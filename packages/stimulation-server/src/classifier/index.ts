/**
 * Classifier orchestrator.
 * Routes messages through a configurable waterfall:
 *   rules → LLM classifiers (in order) → fallback.
 *
 * The LLM classifier chain is configured at startup. Default:
 *   Mercury (instant) → Claude CLI (backup)
 *
 * Each LLM classifier implements the LlmClassifier interface, so new
 * backends can be added by implementing classify() and dropping them
 * into the chain.
 */

import { classifyByRules } from './rules.js';
import { recordClassification, getClassifierMetrics, resetClassifierMetrics } from './classifier-metrics.js';
import type { ClassificationResult, ClassificationContext, LlmClassifier } from './types.js';
import type { SafetyGate } from '../safety/index.js';

// Concrete implementations — import the classes
import { MercuryClassifier } from './mercury.js';
import { ClaudeCliClassifier } from './claude.js';
import { OllamaClassifier } from './ollama.js';

export type { ClassificationResult, ClassificationContext, LlmClassifier } from './types.js';
export { getClassifierMetrics, resetClassifierMetrics } from './classifier-metrics.js';
export { MercuryClassifier } from './mercury.js';
export { ClaudeCliClassifier } from './claude.js';
export { OllamaClassifier } from './ollama.js';

/** Default classification when all tiers fail */
const FALLBACK_RESULT: ClassificationResult = {
  urgency: 'normal',
  category: 'informational',
  routing: 'log_only',
  confidence: 'low',
  tier: 'fallback',
  latencyMs: 0,
};

function log(msg: string, data?: Record<string, unknown>) {
  console.log(JSON.stringify({
    level: 'info',
    msg,
    component: 'classifier',
    ...data,
    ts: new Date().toISOString(),
  }));
}

/**
 * The configured LLM classifier chain.
 * Default: Mercury → Claude CLI.
 * Call setClassifierChain() to reconfigure.
 */
let classifierChain: LlmClassifier[] = [
  new MercuryClassifier(),
  new ClaudeCliClassifier(),
];

/** Replace the LLM classifier chain at runtime */
export function setClassifierChain(chain: LlmClassifier[]): void {
  classifierChain = chain;
  log('Classifier chain updated', {
    chain: chain.map((c) => c.name),
  });
}

/** Get the current classifier chain (for inspection/testing) */
export function getClassifierChain(): LlmClassifier[] {
  return classifierChain;
}

/**
 * Classify a message through the tiered pipeline.
 * Rules → LLM chain (in order) → fallback.
 */
export async function classify(
  ctx: ClassificationContext,
  safety: SafetyGate | null,
): Promise<ClassificationResult> {
  const start = Date.now();

  // --- Tier 1: Rules (always first) ---
  const rulesResult = classifyByRules(ctx);
  if (rulesResult) {
    const latencyMs = Date.now() - start;
    const result: ClassificationResult = {
      ...rulesResult.classification,
      confidence: 'high',
      tier: 'rules',
      latencyMs,
    };
    log('Classified by rules', { rule: rulesResult.ruleName, ...result });
    recordClassification(
      'rules', result.urgency, result.category, result.routing, result.confidence, latencyMs
    );
    return result;
  }

  // --- LLM Classifier Chain ---
  for (const classifier of classifierChain) {
    // Check safety gate — use 'claude' gate for Claude CLI, 'local' for others
    const gateType = classifier.name === 'claude-cli' ? 'claude' : 'local';
    const check = gateType === 'claude'
      ? (safety?.canCallClaude(ctx.channelType) ?? { allowed: true, reasons: [] })
      : (safety?.canCallLocalLlm(ctx.channelType) ?? { allowed: true, reasons: [] });

    if (!check.allowed) {
      log(`${classifier.name} blocked by safety gate`, { reasons: check.reasons });
      continue;
    }

    try {
      const llmResult = await classifier.classify(ctx);
      if (llmResult) {
        const result: ClassificationResult = {
          ...llmResult.classification,
          confidence: llmResult.confidence,
          tier: classifier.tier,
          latencyMs: llmResult.latencyMs,
          model: llmResult.model,
        };

        // Attach agreement metadata if present (from Ollama consensus)
        if (llmResult.metadata?.agreement) {
          result.agreement = llmResult.metadata.agreement as { votes: number; agreeing: number };
        }

        log(`Classified by ${classifier.name}`, result as unknown as Record<string, unknown>);

        // Record rate limiting — Ollama consensus counts as 3 calls
        if (classifier.name === 'ollama') {
          safety?.recordLlmCall('local', ctx.channelType);
          safety?.recordLlmCall('local', ctx.channelType);
          safety?.recordLlmCall('local', ctx.channelType);
        } else if (classifier.name === 'claude-cli') {
          safety?.recordLlmCall('claude', ctx.channelType);
        }
        // Mercury doesn't need rate limiting through our safety gate

        recordClassification(
          classifier.tier, result.urgency, result.category, result.routing,
          result.confidence, result.latencyMs, result.agreement
        );
        return result;
      }
      log(`${classifier.name} returned no result, trying next`);
    } catch (err) {
      log(`${classifier.name} error, trying next`, { error: String(err) });
    }
  }

  // --- Fallback ---
  const latencyMs = Date.now() - start;
  const fallback = { ...FALLBACK_RESULT, latencyMs };
  log('All classifiers failed, using fallback', fallback);
  recordClassification(
    'fallback', fallback.urgency, fallback.category, fallback.routing,
    fallback.confidence, latencyMs
  );
  return fallback;
}
