/**
 * Hallucination Detector — post-composition middleware.
 *
 * Extracts factual claims from the composed message, verifies them against
 * external sources (Wolfram Alpha primary, Ollama self-check fallback),
 * and flags low-confidence results for review.
 *
 * A secondary Wikipedia REST API verification step runs in parallel for
 * factual and general claims. When Wikipedia returns relevant content, the
 * confidence scores from both sources are averaged to reduce false positives
 * and negatives.
 *
 * Architecture:
 *   1. Heuristic pre-filter: skip if message contains no verifiable claims
 *   2. Claim extraction via Ollama (cheap, local)
 *   3. Per-claim primary verification: Wolfram Alpha (numeric/temporal) or
 *      Ollama self-check (factual/general)
 *   4. Per-claim secondary verification: Wikipedia REST API (all claim types)
 *   5. Score fusion: average primary + Wikipedia when both available
 *   6. Score aggregation → overall confidence level
 *   7. Log to NDJSON + optionally append a [⚠ low confidence] annotation
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
  /** Which primary verifier was used */
  source: 'wolfram' | 'ollama-selfcheck' | 'skipped';
  /** Optional brief explanation from the verifier */
  note?: string;
  /** Wikipedia secondary verification result (present when Wikipedia was consulted) */
  wikipedia?: WikipediaVerificationResult;
}

export interface WikipediaVerificationResult {
  /** 0–100 confidence from Wikipedia source */
  confidence: number;
  /** Short excerpt or article title used for verification */
  snippet: string;
  /** Whether Wikipedia returned a relevant article */
  found: boolean;
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
const WIKIPEDIA_REST_BASE = 'https://en.wikipedia.org/api/rest_v1';
const OLLAMA_TIMEOUT_MS = 15_000;
const WOLFRAM_TIMEOUT_MS = 10_000;
const WIKIPEDIA_TIMEOUT_MS = 8_000;

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
// Wikipedia secondary verification
// ---------------------------------------------------------------------------

/**
 * Query the Wikipedia REST API for content related to the claim.
 *
 * Strategy:
 *   1. Search Wikipedia for the claim text (up to 3 results)
 *   2. Fetch the summary of the top result
 *   3. Ask Ollama to reconcile the claim against the Wikipedia summary
 *
 * Returns a WikipediaVerificationResult. On any error, returns found=false
 * so the caller can safely ignore it.
 */
export async function verifyWithWikipedia(claim: string): Promise<WikipediaVerificationResult> {
  try {
    // Step 1: search for relevant articles
    const searchUrl = new URL(`${WIKIPEDIA_REST_BASE}/page/search/title`);
    searchUrl.searchParams.set('q', claim);
    searchUrl.searchParams.set('limit', '3');

    const searchRes = await fetch(searchUrl.toString(), {
      headers: { 'User-Agent': 'Jane-AI-Assistant/1.0 (jane@jane.ai)' },
      signal: AbortSignal.timeout(WIKIPEDIA_TIMEOUT_MS),
    });

    if (!searchRes.ok) {
      log('warn', 'Wikipedia search HTTP error', { status: searchRes.status });
      return { confidence: 50, snippet: '', found: false };
    }

    const searchData = await searchRes.json() as {
      pages?: Array<{ title: string; description?: string; key: string }>;
    };

    const pages = searchData.pages ?? [];
    if (pages.length === 0) {
      return { confidence: 50, snippet: 'No Wikipedia article found', found: false };
    }

    // Step 2: fetch summary of the top result
    const topKey = pages[0].key;
    const summaryUrl = `${WIKIPEDIA_REST_BASE}/page/summary/${encodeURIComponent(topKey)}`;
    const summaryRes = await fetch(summaryUrl, {
      headers: { 'User-Agent': 'Jane-AI-Assistant/1.0 (jane@jane.ai)' },
      signal: AbortSignal.timeout(WIKIPEDIA_TIMEOUT_MS),
    });

    if (!summaryRes.ok) {
      // Search found something but summary failed — treat as partial hit
      const desc = pages[0].description ?? '';
      return { confidence: 50, snippet: desc.slice(0, 200), found: true };
    }

    const summaryData = await summaryRes.json() as {
      extract?: string;
      title?: string;
    };

    const extract = summaryData.extract ?? '';
    const title = summaryData.title ?? pages[0].title;
    const snippet = extract.slice(0, 400);

    if (!snippet) {
      return { confidence: 50, snippet: `Found: ${title}`, found: true };
    }

    // Step 3: reconcile claim against Wikipedia content
    const reconcile = await reconcileClaimWithAnswer(claim, `Wikipedia on "${title}": ${snippet}`);

    return {
      confidence: reconcile.confidence,
      snippet: `${title}: ${snippet.slice(0, 200)}`,
      found: true,
    };
  } catch (err) {
    log('warn', 'Wikipedia verification failed', { claim: claim.slice(0, 80), error: String(err) });
    return { confidence: 50, snippet: '', found: false };
  }
}

// ---------------------------------------------------------------------------
// Score fusion
// ---------------------------------------------------------------------------

/**
 * Fuse a primary confidence score with a Wikipedia confidence score.
 *
 * Rules:
 * - If Wikipedia didn't find a relevant article, use primary score as-is.
 * - If both sources found content, average them (equal weight).
 * - If primary was skipped but Wikipedia found content, use Wikipedia alone.
 */
export function fuseConfidenceScores(
  primaryConfidence: number,
  primarySource: ClaimVerificationResult['source'],
  wikipedia: WikipediaVerificationResult | undefined,
): number {
  if (!wikipedia || !wikipedia.found) {
    return primaryConfidence;
  }

  if (primarySource === 'skipped') {
    // Primary had no data — use Wikipedia alone
    return wikipedia.confidence;
  }

  // Both sources contributed — average them
  return Math.round((primaryConfidence + wikipedia.confidence) / 2);
}

// ---------------------------------------------------------------------------
// Per-claim routing
// ---------------------------------------------------------------------------

async function verifyClaim(claim: FactualClaim): Promise<ClaimVerificationResult> {
  const isNumericOrTemporal = claim.category === 'numeric' || claim.category === 'temporal';

  // Run primary verification
  const primaryPromise = isNumericOrTemporal
    ? verifyWithWolfram(claim.text)
    : verifyWithOllamaSelfCheck(claim.text, claim.category);

  // Run Wikipedia secondary verification in parallel for all claim types.
  // For numeric/temporal, Wikipedia cross-checks when Wolfram is unavailable.
  // For factual/general, Wikipedia is a strong secondary signal.
  const wikiPromise = verifyWithWikipedia(claim.text);

  const [primary, wikipedia] = await Promise.all([primaryPromise, wikiPromise]);

  const fusedConfidence = fuseConfidenceScores(primary.confidence, primary.source, wikipedia);

  return {
    ...primary,
    confidence: fusedConfidence,
    wikipedia,
  };
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

    // 3. Verify all claims in parallel (each claim runs primary + Wikipedia internally)
    const results = await Promise.all(claims.map(verifyClaim));

    // 4. Aggregate confidence — a claim counts as verified if primary ran OR Wikipedia found content
    const verified = results.filter(r => r.source !== 'skipped' || (r.wikipedia?.found ?? false));
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
