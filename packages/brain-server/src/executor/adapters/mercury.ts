/**
 * Mercury runtime adapter — Inception's Mercury API (OpenAI-compatible).
 *
 * Fast (~100-300ms with instant reasoning), pay-per-token.
 * Use sparingly when speed matters and context is light.
 * Currently used for classification and voice composition.
 */

import type { RuntimeAdapter, AdapterExecuteParams, AdapterResult } from '../types.js';
import { callOpenAICompatible, getApiKey } from './openai-compat.js';

const MERCURY_BASE_URL = 'https://api.inceptionlabs.ai/v1';
const MERCURY_TIMEOUT_MS = 30_000;

const mercuryAdapter: RuntimeAdapter = {
  name: 'mercury',

  async execute(params: AdapterExecuteParams): Promise<AdapterResult> {
    const { prompt, runtime, jobId } = params;

    const apiKey = getApiKey('MERCURY_API_KEY');
    if (!apiKey) {
      return {
        success: false,
        resultText: null,
        rawOutput: '',
        durationMs: 0,
        error: 'MERCURY_API_KEY not set',
      };
    }

    log('info', 'Calling Mercury', { jobId, model: runtime.model });

    const extraBody: Record<string, unknown> = {};
    if (runtime.reasoningEffort) {
      extraBody.reasoning_effort = runtime.reasoningEffort;
    }

    const result = await callOpenAICompatible({
      baseUrl: MERCURY_BASE_URL,
      apiKey,
      model: runtime.model || 'mercury-2',
      prompt,
      temperature: runtime.temperature,
      timeoutMs: MERCURY_TIMEOUT_MS,
      extraBody,
    });

    if (result.success) {
      log('info', 'Mercury completed', { jobId, durationMs: result.durationMs });
    } else {
      log('error', 'Mercury failed', { jobId, error: result.error, durationMs: result.durationMs });
    }

    return result;
  },
};

export default mercuryAdapter;

function log(level: string, msg: string, extra?: Record<string, unknown>): void {
  console.log(JSON.stringify({ level, msg, component: 'executor.mercury', ts: new Date().toISOString(), ...extra }));
}
