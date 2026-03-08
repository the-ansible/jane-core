/**
 * Mercury classifier — uses the executor's Mercury adapter via the brain server.
 * Fast (~100-300ms) and reliable for structured classification tasks.
 */

import type { ClassificationContext, LlmClassifier, LlmClassifyResult } from './types.js';
import { parseClassificationResponse } from './ollama.js';
import { buildClassificationPrompt } from './prompt.js';
import { invoke } from '../executor-client.js';

export class MercuryClassifier implements LlmClassifier {
  readonly name = 'mercury';
  readonly tier = 'mercury';

  async classify(ctx: ClassificationContext): Promise<LlmClassifyResult | null> {
    const start = Date.now();
    const prompt = buildClassificationPrompt(ctx);

    try {
      const result = await invoke({
        runtime: 'mercury',
        model: 'mercury-2',
        prompt,
        maxTokens: 256,
        reasoningEffort: 'instant',
        timeoutMs: 15_000,
      });

      const latencyMs = Date.now() - start;

      if (!result.success || !result.resultText) {
        console.log(JSON.stringify({
          level: 'error',
          msg: 'Mercury classifier failed via executor',
          component: 'classifier',
          error: result.error,
          latencyMs,
          ts: new Date().toISOString(),
        }));
        return null;
      }

      const classification = parseClassificationResponse(result.resultText);
      if (!classification) return null;

      return { classification, confidence: 'high', latencyMs, model: 'mercury-2' };
    } catch (err) {
      console.log(JSON.stringify({
        level: 'error',
        msg: 'Mercury classifier failed',
        error: String(err),
        component: 'classifier',
        latencyMs: Date.now() - start,
        ts: new Date().toISOString(),
      }));
      return null;
    }
  }
}
