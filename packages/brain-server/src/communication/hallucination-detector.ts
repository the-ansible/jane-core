/**
 * Hallucination Detector — post-composition middleware.
 *
 * Extracts factual claims from the composed message, verifies them against
 * external sources (Wolfram Alpha primary, Ollama self-check fallback),
 * and flags low-confidence results for review.
 *
 * The detector is fire-and-forget with respect to the pipeline — it does NOT
 * block the outbound response. Results are logged to NDJSON for analysis and
 * optionally annotated on the composed message.
 *
 * Architecture:
 *   1. Heuristic pre-filter: skip if message contains no verifiable claims
 *   2. Claim extraction via Ollama (cheap, local)
 *   3. Per-claim verification via Wolfram Alpha (numeric/factual) or Ollama
 *      self-check (free-text claims)
 *   4. Score aggregation → overall confidence level
 *   5. Log to NDJSON + optionally append a [⚠ low confidence] annotation
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FactualClaim {
  text: string;
  /** Category helps route to the right verifier */
  category: 'numeric' | 'factual' | 'temporal' | 'general';
}

export interface ClaimVerificationResult {
  claim: string;
  category: FactualClaim['category'];
  /** 0–100: how confident the verifier is the claim is accurate */
  confidence: number;
  /** Which verifier was used */
  source: 'wolfram' | 'ollama-selfcheck' | 'skipped';
  /** Optional brief explanation from the verifier */
  note?: string;
}

export interface HallucinationReport {
  messageId: string;
  timestamp: string;
  claimsFound: number;
  claimsVerified: number;
  overallConfidence: number;
  flagged: boolean;
  results: ClaimVerificationResult[];
}

export interface DetectorResult {
  report: HallucinationReport;
  /** Annotated message — same as input unless flagged */
  annotatedMessage: string;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const WOLFRAM_BASE_URL = 'https://api.wolframalpha.com/v1/result';
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://host.docker.internal:11434';
const OLLAMA_TIMEOUT_MS = 15_000;
const WOLFRAM_TIMEOUT_MS = 10_000;

/** Flag the message if overall confidence falls below this threshold */
const CONFIDENCE_FLAG_THRESHOLD = 60;

/** Maximum claims to verify per message (avoid excessive API calls) */
const MAX_CLAIMS_TO_VERIFY = 5;

/** Minimum text length before we bother analyzing the message */
const MIN_MESSAGE_LENGTH = 40;

// ---------------------------------------------------------------------------
// Log path
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.resolve(__dirname, '../../logs');
const LOG_FILE = path.join(LOG_DIR, 'hallucination-detections.ndjson');

// ---------------------------------------------------------------------------
// Heuristic pre-filter
// ---------------------------------------------------------------------------

/**
 * Returns true if the message is likely to contain verifiable factual claims.
 * Avoids sending short greetings or pure conversational messages to the LLM.
 */
export function likelyHasClaims(message: string): boolean {
  if (message.length < MIN_MESSAGE_LENGTH) return false;

  const claimPatterns = [
    /\b\d+(\.\d+)?%/,
    /\b\d+(\.\d+)?\s+(percent|degrees?|miles?|kilometers?|kg|lbs?|km|GHz|MB|GB|TB|seconds?|minutes?|hours?|years?|days?)\b/i,
    /\b(was|were|is|are|became|happened|occurred|invented|discovered|founded|born|died)\b.*\bin\s+\d{4}\b/i,
    /\b\d{4}\b.*\b(was|were|is|are|became|happened|occurred|invented|discovered|founded|born|died)\b/i,
    /\baccording to\b/i,
    /\b(the|a)\s+\w+\s+(is|was|are|were)\s+(the\s+)?(first|largest|smallest|tallest|fastest|oldest|newest|most|least)\b/i,
    /\b(approximately|about|roughly|around|exactly|precisely)\s+\d/i,
    /\b\d[\d,]*(\.\d+)?\s+(people|users|companies|countries|languages|species|elements)\b/i,
  ];

  return claimPatterns.some(p => p.test(message));
}

// ---------------------------------------------------------------------------
// Claim extraction
// ---------------------------------------------------------------------------

/**
 * Use Ollama to extract factual claims from the message.
 * Returns an empty array on failure (non-blocking).
 */
async function extractClaims(message: string): Promise<FactualClaim[]> {
  const prompt = `Extract any verifiable factual claims from the following message. Return ONLY a JSON array. Each item should have:
- "text": the exact claim as a short phrase
- "category": one of "numeric" (quantities, measurements, statistics), "temporal" (dates, years, sequences), "factual" (historical facts, scientific facts), "general" (other verifiable statements)

Only include claims that could be fact-checked. Ignore opinions, suggestions, and conversational text. Return at most 5 claims. If there are no verifiable claims, return [].

Message:
${message}

JSON array:`;

  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.HALLUCINATION_EXTRACTOR_MODEL || 'llama3.2',
        prompt,
        stream: false,
        options: { temperature: 0 },
      }),
      signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
    });

    if (!res.ok) {
      log('warn', 'Ollama claim extraction HTTP error', { status: res.status });
      return [];
    }

    const data = await res.json() as { response?: string };
    const text = data.response?.trim() ?? '';

    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return [];

    const parsed = JSON.parse(match[0]) as unknown;
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter((item): item is FactualClaim =>
        typeof item === 'object' && item !== null &&
        typeof (item as Record<string, unknown>).text === 'string' &&
        ['numeric', 'factual', 'temporal', 'general'].includes((item as Record<string, unknown>).category as string)
      )
      .slice(0, MAX_CLAIMS_TO_VERIFY);
  } catch (err) {
    log('warn', 'Claim extraction failed', { error: String(err) });
    return [];
  }
}

// ---------------------------------------------------------------------------
// Wolfram Alpha verification
// ---------------------------------------------------------------------------

async function verifyWithWolfram(claim: string): Promise<ClaimVerificationResult> {
  const apiKey = process.env.WOLFRAM_ALPHA_APP_ID;
  if (!apiKey) {
    return {
      claim,
      category: 'numeric',
      confidence: 50,
      source: 'skipped',
      note: 'WOLFRAM_ALPHA_APP_ID not set',
    };
  }

  try {
    const url = new URL(WOLFRAM_BASE_URL);
    url.searchParams.set('appid', apiKey);
    url.searchParams.set('i', claim);
    url.searchParams.set('timeout', '5');

    const res = await fetch(url.toString(), {
      signal: AbortSignal.timeout(WOLFRAM_TIMEOUT_MS),
    });

    if (res.status === 501) {
      // Wolfram couldn't interpret — route to Ollama self-check
      return verifyWithOllamaSelfCheck(claim, 'numeric');
    }

    if (!res.ok) {
      return {
        claim,
        category: 'numeric',
        confidence: 50,
        source: 'skipped',
        note: `Wolfram HTTP ${res.status}`,
      };
    }

    const wolframAnswer = (await res.text()).trim();

    // Ask Ollama to reconcile claim vs wolfram answer
    const reconcile = await reconcileClaimWithAnswer(claim, wolframAnswer);
    return {
      claim,
      category: 'numeric',
      confidence: reconcile.confidence,
      source: 'wolfram',
      note: `Wolfram says: "${wolframAnswer.slice(0, 120)}" — ${reconcile.note}`,
    };
  } catch (err) {
    log('warn', 'Wolfram verification failed', { claim: claim.slice(0, 80), error: String(err) });
    return {
      claim,
      category: 'numeric',
      confidence: 50,
      source: 'skipped',
      note: `Wolfram error: ${String(err).slice(0, 100)}`,
    };
  }
}

async function reconcileClaimWithAnswer(
  claim: string,
  externalAnswer: string,
): Promise<{ confidence: number; note: string }> {
  const prompt = `A statement was made: "${claim}"

An external source says: "${externalAnswer}"

Is the statement consistent with the external source? Return ONLY a JSON object:
{"confidence": <0-100>, "note": "<brief explanation>"}

Where confidence is how confident you are the claim is accurate (100 = definitely correct, 0 = definitely wrong, 50 = uncertain).`;

  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.HALLUCINATION_EXTRACTOR_MODEL || 'llama3.2',
        prompt,
        stream: false,
        options: { temperature: 0 },
      }),
      signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
    });

    if (!res.ok) return { confidence: 50, note: 'reconcile HTTP error' };
    const data = await res.json() as { response?: string };
    const text = data.response?.trim() ?? '';
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return { confidence: 50, note: 'unparseable reconcile response' };
    const parsed = JSON.parse(match[0]) as { confidence?: number; note?: string };
    return {
      confidence: typeof parsed.confidence === 'number' ? Math.max(0, Math.min(100, parsed.confidence)) : 50,
      note: typeof parsed.note === 'string' ? parsed.note.slice(0, 200) : '',
    };
  } catch {
    return { confidence: 50, note: 'reconcile failed' };
  }
}

// ---------------------------------------------------------------------------
// Ollama self-check verification
// ---------------------------------------------------------------------------

async function verifyWithOllamaSelfCheck(
  claim: string,
  category: FactualClaim['category'],
): Promise<ClaimVerificationResult> {
  const prompt = `Fact-check the following claim. Return ONLY a JSON object with:
{"confidence": <0-100>, "note": "<brief explanation>"}

Where confidence is how confident you are the claim is accurate (100 = definitely correct, 0 = definitely wrong, 50 = uncertain/can't verify).

Claim: "${claim}"`;

  try {
    const res = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.HALLUCINATION_EXTRACTOR_MODEL || 'llama3.2',
        prompt,
        stream: false,
        options: { temperature: 0 },
      }),
      signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
    });

    if (!res.ok) {
      return { claim, category, confidence: 50, source: 'ollama-selfcheck', note: `HTTP ${res.status}` };
    }

    const data = await res.json() as { response?: string };
    const text = data.response?.trim() ?? '';
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) {
      return { claim, category, confidence: 50, source: 'ollama-selfcheck', note: 'unparseable response' };
    }

    const parsed = JSON.parse(match[0]) as { confidence?: number; note?: string };
    return {
      claim,
      category,
      confidence: typeof parsed.confidence === 'number' ? Math.max(0, Math.min(100, parsed.confidence)) : 50,
      source: 'ollama-selfcheck',
      note: typeof parsed.note === 'string' ? parsed.note.slice(0, 200) : undefined,
    };
  } catch (err) {
    log('warn', 'Ollama self-check failed', { claim: claim.slice(0, 80), error: String(err) });
    return { claim, category, confidence: 50, source: 'ollama-selfcheck', note: String(err).slice(0, 100) };
  }
}

// ---------------------------------------------------------------------------
// Per-claim routing
// ---------------------------------------------------------------------------

async function verifyClaim(claim: FactualClaim): Promise<ClaimVerificationResult> {
  if (claim.category === 'numeric' || claim.category === 'temporal') {
    return verifyWithWolfram(claim.text);
  }
  return verifyWithOllamaSelfCheck(claim.text, claim.category);
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Run hallucination detection on a composed message.
 *
 * Non-blocking: always resolves. Errors are caught and produce a safe default.
 * The annotated message is the same as input unless flagged.
 */
export async function detectHallucinations(
  message: string,
  messageId: string,
): Promise<DetectorResult> {
  const timestamp = new Date().toISOString();

  const nullResult = (): DetectorResult => ({
    report: {
      messageId,
      timestamp,
      claimsFound: 0,
      claimsVerified: 0,
      overallConfidence: 100,
      flagged: false,
      results: [],
    },
    annotatedMessage: message,
  });

  try {
    // 1. Heuristic pre-filter
    if (!likelyHasClaims(message)) {
      return nullResult();
    }

    // 2. Extract claims
    const claims = await extractClaims(message);
    if (claims.length === 0) {
      return nullResult();
    }

    log('info', 'Claims extracted, verifying', { messageId, count: claims.length });

    // 3. Verify all claims in parallel
    const results = await Promise.all(claims.map(verifyClaim));

    // 4. Aggregate confidence
    const verified = results.filter(r => r.source !== 'skipped');
    const overallConfidence = verified.length > 0
      ? Math.round(verified.reduce((sum, r) => sum + r.confidence, 0) / verified.length)
      : 100;

    const flagged = overallConfidence < CONFIDENCE_FLAG_THRESHOLD;

    const report: HallucinationReport = {
      messageId,
      timestamp,
      claimsFound: claims.length,
      claimsVerified: verified.length,
      overallConfidence,
      flagged,
      results,
    };

    // 5. Append annotation if flagged
    const annotatedMessage = flagged
      ? `${message}\n\n⚠️ _Low confidence (${overallConfidence}/100): some factual claims in this response may be inaccurate. Please verify independently._`
      : message;

    // 6. Log to NDJSON
    logReport(report);

    if (flagged) {
      log('warn', 'Hallucination detected — message flagged', {
        messageId,
        overallConfidence,
        claimsFound: claims.length,
        lowConfidenceClaims: results.filter(r => r.confidence < CONFIDENCE_FLAG_THRESHOLD).map(r => r.claim.slice(0, 80)),
      });
    } else {
      log('info', 'Hallucination check passed', { messageId, overallConfidence, claimsVerified: verified.length });
    }

    return { report, annotatedMessage };
  } catch (err) {
    log('error', 'Hallucination detection failed, returning original message', {
      messageId,
      error: String(err),
    });
    return nullResult();
  }
}

// ---------------------------------------------------------------------------
// NDJSON logging
// ---------------------------------------------------------------------------

function logReport(report: HallucinationReport): void {
  try {
    if (!fs.existsSync(LOG_DIR)) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
    }
    fs.appendFileSync(LOG_FILE, JSON.stringify(report) + '\n', 'utf-8');
  } catch (err) {
    log('warn', 'Failed to write hallucination report', { error: String(err) });
  }
}

// ---------------------------------------------------------------------------
// Logging helper
// ---------------------------------------------------------------------------

function log(level: string, msg: string, extra?: Record<string, unknown>): void {
  console.log(JSON.stringify({
    level,
    msg,
    component: 'comm.hallucination-detector',
    ts: new Date().toISOString(),
    ...extra,
  }));
}
