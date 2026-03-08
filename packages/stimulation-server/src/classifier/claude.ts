/**
 * Claude CLI escalation classifier.
 * Routes through the brain server's executor with claude-code adapter.
 * Only called when local consensus fails (all models disagree).
 */

import {
  type Classification,
  type ClassificationContext,
  type LlmClassifier,
  type LlmClassifyResult,
} from './types.js';
import { parseClassificationResponse } from './ollama.js';
import { buildClassificationPrompt } from './prompt.js';
import { invoke } from '../executor-client.js';

const CLAUDE_MODEL = 'haiku';

/**
 * Classify a message via the executor's claude-code adapter.
 */
export async function classifyByClaude(
  ctx: ClassificationContext
): Promise<{ classification: Classification; latencyMs: number; model: string } | null> {
  const start = Date.now();
  const prompt = buildClassificationPrompt(ctx);

  try {
    const result = await invoke({
      runtime: 'claude-code',
      model: CLAUDE_MODEL,
      prompt,
      timeoutMs: 60_000,
    });

    const latencyMs = Date.now() - start;

    if (!result.success || !result.resultText) return null;

    const classification = parseClassificationResponse(result.resultText);
    if (!classification) return null;

    return { classification, latencyMs, model: CLAUDE_MODEL };
  } catch (err) {
    console.log(JSON.stringify({
      level: 'error',
      msg: 'Claude classifier failed',
      error: String(err),
      component: 'classifier',
      ts: new Date().toISOString(),
    }));
    return null;
  }
}

export class ClaudeCliClassifier implements LlmClassifier {
  readonly name = 'claude-cli';
  readonly tier = 'claude_escalation';

  async classify(ctx: ClassificationContext): Promise<LlmClassifyResult | null> {
    const result = await classifyByClaude(ctx);
    if (!result) return null;

    return {
      classification: result.classification,
      confidence: 'high',
      latencyMs: result.latencyMs,
      model: result.model,
    };
  }
}
