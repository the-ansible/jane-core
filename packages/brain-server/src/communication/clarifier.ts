/**
 * Clarifier — two capabilities in one module:
 *
 * 1. analyzeClarification() — detects ambiguous phrasing in inbound messages
 *    and generates a targeted clarifying question before the agent proceeds.
 *
 * 2. queryChrisInsight() — retrieves specific facts from the Chris Insights
 *    vault using natural language queries, enabling real-time context enrichment
 *    during the agent pipeline.
 *
 * Design goals:
 * - Fast: uses Mercury instant (or Ollama fallback) for LLM calls
 * - Conservative: clarifier only fires when ambiguity is high
 * - Loop-safe: tracks last-asked question per session; won't re-ask about the same message
 * - Contextual: queryChrisInsight enriches agent context with stored insights about Chris
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { CommunicationEvent } from '@the-ansible/life-system-shared';
import { callOpenAICompatible, getApiKey } from '../executor/adapters/openai-compat.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ClarifierResult {
  needsClarification: boolean;
  /** The clarifying question to send back, when needsClarification is true */
  question?: string;
  /** Ambiguity score 0-100 (internal, for logging) */
  score?: number;
  /** Which signals triggered the ambiguity determination */
  signals?: string[];
}

/** A single insight retrieved from the Chris Insights vault. */
export interface ChrisInsight {
  /** Source file the insight came from */
  source: string;
  /** Relevant excerpt from the file */
  excerpt: string;
  /** Relevance score (0-1) — higher is more relevant */
  relevance: number;
}

/** Result of a queryChrisInsight call */
export interface ChrisInsightResult {
  query: string;
  insights: ChrisInsight[];
  /** Combined prose summary for direct injection into agent context */
  summary: string;
}

// ---------------------------------------------------------------------------
// Session anti-loop state
// (In-memory; acceptable since clarifier state is transient)
// ---------------------------------------------------------------------------

/** Map<sessionId, lastContentHash> — prevents re-asking after user didn't answer */
const lastClarifiedHash = new Map<string, string>();

/** How many times in a row we've asked in a session (avoid infinite loops) */
const consecutiveClarifications = new Map<string, number>();
const MAX_CONSECUTIVE = 2;

// ---------------------------------------------------------------------------
// Heuristic pre-filter
// Skip the LLM call entirely for messages that are clearly unambiguous.
// ---------------------------------------------------------------------------

const SHORT_CONVERSATIONAL_RE = /^(hi|hey|hello|thanks|thank you|ok|okay|sure|yes|no|yep|nope|got it|great|cool|sounds good|perfect|nice|alright|ack)[.!?]?$/i;

/** Patterns that indicate a message almost certainly doesn't need clarification */
const CLEAR_INTENT_PATTERNS = [
  SHORT_CONVERSATIONAL_RE,
];

/** Messages that are definitely action-complete — no need to clarify */
const DEFINITELY_CLEAR_PATTERNS = [
  /^(show|list|get|fetch|display|print|what is|who is|where is|when is|how does)\b/i,
  /^(run|execute|start|stop|restart|kill|deploy|build)\b/i,
];

function isObviouslyClear(content: string): boolean {
  const trimmed = content.trim();
  for (const pat of CLEAR_INTENT_PATTERNS) {
    if (pat.test(trimmed)) return true;
  }
  for (const pat of DEFINITELY_CLEAR_PATTERNS) {
    if (pat.test(trimmed)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// LLM helpers
// ---------------------------------------------------------------------------

const MERCURY_BASE_URL = 'https://api.inceptionlabs.ai/v1';
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://host.docker.internal:11434';
const CLARIFIER_TIMEOUT_MS = 8_000;

interface AmbiguityAnalysis {
  ambiguous: boolean;
  score: number; // 0-100
  signals: string[];
  question: string;
}

const ANALYSIS_PROMPT_TEMPLATE = `You are an ambiguity detector for an AI assistant named Jane. Your job is to decide if a message is too ambiguous to act on correctly, and if so, produce ONE focused clarifying question.

IMPORTANT RULES:
- Only flag ambiguity when acting without clarification could lead to wrong or wasted work
- Short conversational messages (greetings, acknowledgments, thanks) are NEVER ambiguous
- If the message is part of an obvious ongoing task (e.g., follow-up questions), do NOT flag as ambiguous
- Ask only about the single most critical missing piece of information
- Never ask more than one question at a time

Ambiguity signals to look for:
1. Unclear referent: "fix it", "update that", "the issue" — what/which one?
2. Missing scope: "refactor the code" — which file/module/function?
3. Multiple valid interpretations: "make it faster" — optimize what aspect?
4. Vague action: "handle the error" — log it, retry, alert, throw?
5. Underspecified target: "add a feature" — feature in which component?

Message to analyze:
---
{{MESSAGE}}
---

Respond with ONLY a JSON object:
{"ambiguous":false,"score":15,"signals":[],"question":""}

or if ambiguous:
{"ambiguous":true,"score":75,"signals":["unclear_referent","missing_scope"],"question":"Which file or function are you referring to?"}

No other text.`;

async function analyzeWithMercury(content: string): Promise<AmbiguityAnalysis | null> {
  const apiKey = getApiKey('MERCURY_API_KEY');
  if (!apiKey) return null;

  const prompt = ANALYSIS_PROMPT_TEMPLATE.replace('{{MESSAGE}}', content);

  try {
    const result = await callOpenAICompatible({
      baseUrl: MERCURY_BASE_URL,
      apiKey,
      model: 'mercury-coder-small',
      prompt,
      maxTokens: 200,
      temperature: 0.1,
      timeoutMs: CLARIFIER_TIMEOUT_MS,
      extraBody: { reasoning_effort: 'instant' },
    });

    if (!result.success || !result.resultText) return null;
    return parseAnalysisJson(result.resultText);
  } catch {
    return null;
  }
}

async function analyzeWithOllama(content: string): Promise<AmbiguityAnalysis | null> {
  const prompt = ANALYSIS_PROMPT_TEMPLATE.replace('{{MESSAGE}}', content);

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CLARIFIER_TIMEOUT_MS);

    const response = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gemma3:12b',
        prompt,
        stream: false,
        options: { temperature: 0.1, num_predict: 200 },
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!response.ok) return null;

    const data = await response.json() as { response?: string };
    if (!data.response) return null;

    return parseAnalysisJson(data.response);
  } catch {
    return null;
  }
}

function parseAnalysisJson(raw: string): AmbiguityAnalysis | null {
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);

    return {
      ambiguous: Boolean(parsed.ambiguous),
      score: typeof parsed.score === 'number' ? Math.min(100, Math.max(0, parsed.score)) : 0,
      signals: Array.isArray(parsed.signals) ? parsed.signals.map(String) : [],
      question: typeof parsed.question === 'string' ? parsed.question.trim() : '',
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Content hash (to prevent re-asking about the same message)
// ---------------------------------------------------------------------------

function simpleHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return String(h >>> 0);
}

// ---------------------------------------------------------------------------
// Clarifier threshold
// ---------------------------------------------------------------------------

const AMBIGUITY_THRESHOLD = 65;

// ---------------------------------------------------------------------------
// Public API — analyzeClarification
// ---------------------------------------------------------------------------

/**
 * Analyze an inbound message for ambiguity.
 * Returns a ClarifierResult indicating whether a clarifying question should
 * be sent back before proceeding.
 */
export async function analyzeClarification(
  event: CommunicationEvent,
): Promise<ClarifierResult> {
  const content = event.content?.trim() ?? '';

  if (!content) {
    return { needsClarification: false };
  }

  if (isObviouslyClear(content)) {
    return { needsClarification: false };
  }

  const contentHash = simpleHash(content);
  const lastHash = lastClarifiedHash.get(event.sessionId);
  if (lastHash === contentHash) {
    lastClarifiedHash.delete(event.sessionId);
    consecutiveClarifications.delete(event.sessionId);
    return { needsClarification: false };
  }

  const consecutive = consecutiveClarifications.get(event.sessionId) ?? 0;
  if (consecutive >= MAX_CONSECUTIVE) {
    consecutiveClarifications.delete(event.sessionId);
    return { needsClarification: false };
  }

  let analysis = await analyzeWithMercury(content);
  if (!analysis) {
    analysis = await analyzeWithOllama(content);
  }

  if (!analysis) {
    log('warn', 'Clarifier LLM analysis failed, passing through', {
      sessionId: event.sessionId,
      contentPreview: content.slice(0, 80),
    });
    return { needsClarification: false };
  }

  if (!analysis.ambiguous || analysis.score < AMBIGUITY_THRESHOLD || !analysis.question) {
    return { needsClarification: false, score: analysis.score, signals: analysis.signals };
  }

  lastClarifiedHash.set(event.sessionId, contentHash);
  consecutiveClarifications.set(event.sessionId, consecutive + 1);

  log('info', 'Clarification needed', {
    sessionId: event.sessionId,
    score: analysis.score,
    signals: analysis.signals,
    contentPreview: content.slice(0, 80),
  });

  return {
    needsClarification: true,
    question: analysis.question,
    score: analysis.score,
    signals: analysis.signals,
  };
}

/**
 * Clear clarification tracking for a session.
 * Called when a session is compacted or reset.
 */
export function clearClarificationState(sessionId: string): void {
  lastClarifiedHash.delete(sessionId);
  consecutiveClarifications.delete(sessionId);
}

// ---------------------------------------------------------------------------
// Public API — queryChrisInsight
// ---------------------------------------------------------------------------

const CHRIS_INSIGHTS_DIR = '/agent/data/vault/Projects/Chris-Insights';

/** Cache: file path -> { content, loadedAt } */
const insightCache = new Map<string, { content: string; loadedAt: number }>();
const INSIGHT_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

/** Load all markdown files from the Chris Insights vault (with caching). */
function loadInsightFiles(): Array<{ name: string; content: string }> {
  if (!existsSync(CHRIS_INSIGHTS_DIR)) {
    log('warn', 'Chris Insights directory not found', { dir: CHRIS_INSIGHTS_DIR });
    return [];
  }

  const files: Array<{ name: string; content: string }> = [];
  const now = Date.now();

  let entries: string[];
  try {
    entries = readdirSync(CHRIS_INSIGHTS_DIR).filter((f) => f.endsWith('.md'));
  } catch (err) {
    log('warn', 'Failed to read Chris Insights dir', { error: String(err) });
    return [];
  }

  for (const filename of entries) {
    const filepath = join(CHRIS_INSIGHTS_DIR, filename);
    const cached = insightCache.get(filepath);

    if (cached && now - cached.loadedAt < INSIGHT_CACHE_TTL) {
      files.push({ name: filename, content: cached.content });
      continue;
    }

    try {
      const content = readFileSync(filepath, 'utf-8');
      insightCache.set(filepath, { content, loadedAt: now });
      files.push({ name: filename, content });
    } catch (err) {
      log('warn', 'Failed to read insight file', { file: filepath, error: String(err) });
    }
  }

  return files;
}

/**
 * Score a chunk of text for relevance to a query using keyword matching.
 * Returns a score in [0, 1].
 */
function scoreRelevance(text: string, queryTerms: string[]): number {
  if (queryTerms.length === 0) return 0;

  const lower = text.toLowerCase();
  let matches = 0;

  for (const term of queryTerms) {
    if (lower.includes(term)) matches++;
  }

  return matches / queryTerms.length;
}

/**
 * Split a markdown document into meaningful chunks (by heading or paragraph).
 * Returns chunks of roughly 200-600 chars.
 */
function chunkMarkdown(content: string): string[] {
  // Split on level-2/3 headings first
  const sections = content.split(/\n(?=#{1,3} )/);
  const chunks: string[] = [];

  for (const section of sections) {
    const trimmed = section.trim();
    if (!trimmed) continue;

    // If section is short enough, keep as-is
    if (trimmed.length <= 600) {
      chunks.push(trimmed);
      continue;
    }

    // Split long sections into paragraphs
    const paragraphs = trimmed.split(/\n{2,}/);
    for (const para of paragraphs) {
      const ptrimmed = para.trim();
      if (ptrimmed.length >= 30) {
        chunks.push(ptrimmed.slice(0, 600));
      }
    }
  }

  return chunks;
}

/**
 * Tokenize a query into terms (lowercase, stop-words removed).
 */
function tokenizeQuery(query: string): string[] {
  const STOP_WORDS = new Set([
    'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'shall', 'can', 'of', 'in', 'on', 'at',
    'to', 'for', 'with', 'by', 'from', 'about', 'what', 'how', 'when',
    'where', 'who', 'which', 'and', 'or', 'but', 'not', 'chris', 's',
  ]);

  return query
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOP_WORDS.has(t));
}

/**
 * Retrieve specific facts from the Chris Insights vault using a natural
 * language query. Returns ranked excerpts and a summary for context injection.
 *
 * @param query - Natural language question (e.g. "What are Chris's current priorities?")
 * @param maxInsights - Max number of excerpts to return (default: 5)
 */
export function queryChrisInsight(
  query: string,
  maxInsights = 5,
): ChrisInsightResult {
  const start = Date.now();
  const queryTerms = tokenizeQuery(query);

  if (queryTerms.length === 0) {
    log('warn', 'queryChrisInsight: empty query terms', { query });
    return { query, insights: [], summary: '' };
  }

  const files = loadInsightFiles();

  if (files.length === 0) {
    log('warn', 'queryChrisInsight: no insight files found');
    return { query, insights: [], summary: 'No Chris Insights vault data available.' };
  }

  // Score each chunk from each file
  const candidates: ChrisInsight[] = [];

  for (const file of files) {
    const chunks = chunkMarkdown(file.content);
    for (const chunk of chunks) {
      const relevance = scoreRelevance(chunk, queryTerms);
      if (relevance > 0) {
        candidates.push({
          source: file.name.replace('.md', ''),
          excerpt: chunk,
          relevance,
        });
      }
    }
  }

  // Sort by relevance descending, take top N
  candidates.sort((a, b) => b.relevance - a.relevance);
  const insights = candidates.slice(0, maxInsights);

  // Build a prose summary
  let summary = '';
  if (insights.length === 0) {
    summary = `No relevant insights found in Chris Insights vault for query: "${query}".`;
  } else {
    const parts = insights.map((ins) => `[${ins.source}] ${ins.excerpt}`);
    summary = `Chris Insights (query: "${query}"):\n${parts.join('\n\n')}`;
  }

  log('info', 'queryChrisInsight complete', {
    query,
    termCount: queryTerms.length,
    filesScanned: files.length,
    resultsFound: insights.length,
    topScore: insights[0]?.relevance ?? 0,
    latencyMs: Date.now() - start,
  });

  return { query, insights, summary };
}

// ---------------------------------------------------------------------------
// Internal log helper
// ---------------------------------------------------------------------------

function log(level: string, msg: string, extra: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({
    level,
    msg,
    component: 'comm.clarifier',
    ts: new Date().toISOString(),
    ...extra,
  }));
}
