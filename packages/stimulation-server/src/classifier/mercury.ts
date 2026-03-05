/**
 * Mercury classifier — uses Mercury API with instant reasoning mode.
 * Fast (~100-300ms) and reliable for structured classification tasks.
 */

import { readFileSync } from 'node:fs';
import type { ClassificationContext, LlmClassifier, LlmClassifyResult } from './types.js';
import { parseClassificationResponse } from './ollama.js';
import { buildClassificationPrompt } from './prompt.js';

const MERCURY_TIMEOUT_MS = 15_000;
const MERCURY_BASE_URL = 'https://api.inceptionlabs.ai/v1';
const MERCURY_MODEL = 'mercury-2';

/**
 * Read MERCURY_API_KEY from process env or fall back to PID 1 environ.
 */
function getMercuryApiKey(): string | undefined {
  if (process.env.MERCURY_API_KEY) return process.env.MERCURY_API_KEY;

  try {
    const environ = readFileSync('/proc/1/environ');
    const vars = environ.toString().split('\0');
    for (const v of vars) {
      if (v.startsWith('MERCURY_API_KEY=')) {
        const val = v.slice('MERCURY_API_KEY='.length);
        if (val) return val;
      }
    }
  } catch {
    // /proc/1/environ not available
  }

  return undefined;
}

export class MercuryClassifier implements LlmClassifier {
  readonly name = 'mercury';
  readonly tier = 'mercury';

  async classify(ctx: ClassificationContext): Promise<LlmClassifyResult | null> {
    const start = Date.now();
    const prompt = buildClassificationPrompt(ctx);

    const apiKey = getMercuryApiKey();
    if (!apiKey) {
      console.log(JSON.stringify({
        level: 'error',
        msg: 'MERCURY_API_KEY not set — cannot classify with Mercury',
        component: 'classifier',
        ts: new Date().toISOString(),
      }));
      return null;
    }

    try {
      const response = await fetch(`${MERCURY_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: MERCURY_MODEL,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 256,
          reasoning_effort: 'instant',
        }),
        signal: AbortSignal.timeout(MERCURY_TIMEOUT_MS),
      });

      const latencyMs = Date.now() - start;

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        console.log(JSON.stringify({
          level: 'error',
          msg: 'Mercury classifier API error',
          component: 'classifier',
          status: response.status,
          body: text.slice(0, 300),
          latencyMs,
          ts: new Date().toISOString(),
        }));
        return null;
      }

      const data = await response.json() as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const resultText = data?.choices?.[0]?.message?.content?.trim();
      if (!resultText) return null;

      const classification = parseClassificationResponse(resultText);
      if (!classification) return null;

      return { classification, confidence: 'high', latencyMs, model: MERCURY_MODEL };
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
