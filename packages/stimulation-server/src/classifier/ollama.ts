/**
 * Tier 2: Ollama consensus classifier.
 * Runs 3 parallel prompts to a local LLM, takes majority vote.
 * Free to run, compensates for individual model unreliability through consensus.
 */

import {
  type Classification,
  type ClassificationContext,
  type Confidence,
  type LlmClassifier,
  type LlmClassifyResult,
  isValidClassification,
  VALID_URGENCY,
  VALID_CATEGORY,
  VALID_ROUTING,
} from './types.js';
import { buildClassificationPrompt } from './prompt.js';

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://host.docker.internal:11434';
const OLLAMA_MODEL = process.env.OLLAMA_CLASSIFIER_MODEL || 'qwen3:8b';
const CONSENSUS_COUNT = 3;
const OLLAMA_TIMEOUT_MS = 30_000;

/**
 * Call Ollama once and parse the JSON response.
 * Returns a Classification or null if the response can't be parsed.
 */
async function callOllamaOnce(
  prompt: string,
  fetchFn: typeof fetch = globalThis.fetch
): Promise<Classification | null> {

  const response = await fetchFn(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      prompt,
      stream: false,
      options: {
        temperature: 0.1, // low temp for consistency
        num_predict: 100, // classification is short
      },
      think: false, // disable qwen3 thinking mode for faster, cleaner output
    }),
    signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
  });

  if (!response.ok) {
    return null;
  }

  const data = (await response.json()) as { response: string };
  return parseClassificationResponse(data.response);
}

/**
 * Parse a classification JSON response from the LLM.
 * Handles common LLM quirks: markdown code blocks, extra text, etc.
 */
export function parseClassificationResponse(text: string): Classification | null {
  // Strip markdown code blocks if present
  let cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();

  // Try to extract JSON object from the text
  const jsonMatch = cleaned.match(/\{[^}]+\}/);
  if (!jsonMatch) return null;

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    if (isValidClassification(parsed)) {
      return parsed;
    }

    // Try to salvage partially valid responses by clamping to valid values
    const salvaged = {
      urgency: VALID_URGENCY.includes(parsed.urgency) ? parsed.urgency : null,
      category: VALID_CATEGORY.includes(parsed.category) ? parsed.category : null,
      routing: VALID_ROUTING.includes(parsed.routing) ? parsed.routing : null,
    };
    if (salvaged.urgency && salvaged.category && salvaged.routing) {
      return salvaged as Classification;
    }
  } catch {
    // JSON parse failed
  }

  return null;
}

/**
 * Takes an array of classifications and returns the majority vote.
 * Returns the consensus classification, count of agreeing votes, and confidence.
 */
export function majorityVote(
  votes: (Classification | null)[]
): { classification: Classification; agreeing: number; confidence: Confidence } | null {
  const valid = votes.filter((v): v is Classification => v !== null);
  if (valid.length === 0) return null;

  // Create a key for each classification to compare
  const keyed = valid.map((v) => ({
    key: `${v.urgency}|${v.category}|${v.routing}`,
    classification: v,
  }));

  // Count occurrences of each unique classification
  const counts = new Map<string, { count: number; classification: Classification }>();
  for (const { key, classification } of keyed) {
    const existing = counts.get(key);
    if (existing) {
      existing.count++;
    } else {
      counts.set(key, { count: 1, classification });
    }
  }

  // Find the classification with the most votes
  let best: { count: number; classification: Classification } | null = null;
  for (const entry of counts.values()) {
    if (!best || entry.count > best.count) {
      best = entry;
    }
  }
  if (!best) return null;

  const totalVotes = valid.length;
  const confidence: Confidence =
    best.count === totalVotes ? 'high' :
    best.count > totalVotes / 2 ? 'medium' :
    'low';

  return {
    classification: best.classification,
    agreeing: best.count,
    confidence,
  };
}

export interface ConsensusResult {
  classification: Classification;
  confidence: Confidence;
  agreement: { votes: number; agreeing: number };
  latencyMs: number;
  model: string;
}

/**
 * Run consensus classification: 3 parallel Ollama calls, majority vote.
 * Returns null if no consensus could be reached (all disagree or all fail).
 */
export async function classifyByConsensus(
  ctx: ClassificationContext,
  fetchFn: typeof fetch = globalThis.fetch
): Promise<ConsensusResult | null> {
  const start = Date.now();
  const prompt = buildClassificationPrompt(ctx);

  // Run N calls in parallel
  const promises = Array.from({ length: CONSENSUS_COUNT }, () =>
    callOllamaOnce(prompt, fetchFn).catch(() => null)
  );

  const votes = await Promise.all(promises);
  const latencyMs = Date.now() - start;

  const result = majorityVote(votes);
  if (!result) return null;

  // Only accept if we have actual consensus (>1 agreeing)
  // Single valid vote out of 3 is not reliable enough
  const validVotes = votes.filter((v) => v !== null).length;
  if (validVotes > 1 && result.agreeing === 1) {
    // Multiple valid votes but none agree — no consensus
    return null;
  }

  return {
    classification: result.classification,
    confidence: result.confidence,
    agreement: { votes: validVotes, agreeing: result.agreeing },
    latencyMs,
    model: OLLAMA_MODEL,
  };
}

export class OllamaClassifier implements LlmClassifier {
  readonly name = 'ollama';
  readonly tier = 'local_consensus';

  async classify(ctx: ClassificationContext): Promise<LlmClassifyResult | null> {
    const result = await classifyByConsensus(ctx);
    if (!result) return null;

    return {
      classification: result.classification,
      confidence: result.confidence,
      latencyMs: result.latencyMs,
      model: result.model,
      metadata: { agreement: result.agreement },
    };
  }
}
