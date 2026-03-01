/**
 * Classifier orchestrator.
 * Routes messages through three tiers: rules → local consensus → Claude escalation.
 * Each tier is tried in order; the first to produce a result wins.
 */

import { classifyByRules } from './rules.js';
import { classifyByConsensus } from './ollama.js';
import { classifyByClaude } from './claude.js';
import { recordClassification, getClassifierMetrics, resetClassifierMetrics } from './classifier-metrics.js';
import type { ClassificationResult, ClassificationContext } from './types.js';
import type { SafetyGate } from '../safety/index.js';

export type { ClassificationResult, ClassificationContext } from './types.js';
export { getClassifierMetrics, resetClassifierMetrics } from './classifier-metrics.js';

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
 * Classify a message through the tiered pipeline.
 * Rules → Ollama consensus → Claude escalation → fallback.
 */
export async function classify(
  ctx: ClassificationContext,
  safety: SafetyGate | null,
): Promise<ClassificationResult> {
  const start = Date.now();

  // --- Tier 1: Rules ---
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

  // --- Tier 2: Ollama Consensus ---
  // Check safety gate before making LLM calls
  const localCheck = safety?.canCallLocalLlm(ctx.channelType) ?? { allowed: true, reasons: [] };
  if (localCheck.allowed) {
    try {
      const consensusResult = await classifyByConsensus(ctx);
      if (consensusResult) {
        const result: ClassificationResult = {
          ...consensusResult.classification,
          confidence: consensusResult.confidence,
          tier: 'local_consensus',
          agreement: consensusResult.agreement,
          latencyMs: consensusResult.latencyMs,
        };
        log('Classified by local consensus', {
          agreement: consensusResult.agreement,
          ...result,
        });
        // Record 3 LLM calls for rate limiting
        safety?.recordLlmCall('local', ctx.channelType);
        safety?.recordLlmCall('local', ctx.channelType);
        safety?.recordLlmCall('local', ctx.channelType);
        recordClassification(
          'local_consensus', result.urgency, result.category, result.routing,
          result.confidence, result.latencyMs, consensusResult.agreement
        );
        return result;
      }
      log('Local consensus failed — no agreement, escalating');
    } catch (err) {
      log('Ollama consensus error, escalating', { error: String(err) });
    }
  } else {
    log('Local LLM blocked by safety gate', { reasons: localCheck.reasons });
  }

  // --- Tier 3: Claude Escalation ---
  const claudeCheck = safety?.canCallClaude(ctx.channelType) ?? { allowed: true, reasons: [] };
  if (claudeCheck.allowed) {
    try {
      const claudeResult = await classifyByClaude(ctx);
      if (claudeResult) {
        const result: ClassificationResult = {
          ...claudeResult.classification,
          confidence: 'high', // Claude is authoritative
          tier: 'claude_escalation',
          latencyMs: claudeResult.latencyMs,
        };
        log('Classified by Claude escalation', result);
        safety?.recordLlmCall('claude', ctx.channelType);
        recordClassification(
          'claude_escalation', result.urgency, result.category, result.routing,
          result.confidence, result.latencyMs
        );
        return result;
      }
      log('Claude escalation returned no result');
    } catch (err) {
      log('Claude escalation error', { error: String(err) });
    }
  } else {
    log('Claude blocked by safety gate', { reasons: claudeCheck.reasons });
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
