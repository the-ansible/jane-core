/**
 * Synthetic runtime adapter — hosted open source models (OpenAI-compatible).
 *
 * Use for open-source models when a task doesn't need tool use.
 * Pay-per-token but significantly cheaper than Anthropic.
 * No tool use; prompt-only.
 *
 * API docs: https://dev.synthetic.new/docs/openai/chat-completions
 */

import type { RuntimeAdapter, AdapterExecuteParams, AdapterResult } from '../types.js';
import { callOpenAICompatible, getApiKey } from './openai-compat.js';

const SYNTHETIC_BASE_URL = 'https://api.synthetic.new/v1';
const SYNTHETIC_TIMEOUT_MS = 120_000; // 2 minutes

const syntheticAdapter: RuntimeAdapter = {
  name: 'synthetic',

  async execute(params: AdapterExecuteParams): Promise<AdapterResult> {
    const { prompt, runtime, jobId } = params;

    const apiKey = getApiKey('SYNTHETIC_API_KEY');
    if (!apiKey) {
      return {
        success: false,
        resultText: null,
        rawOutput: '',
        durationMs: 0,
        error: 'SYNTHETIC_API_KEY not set',
      };
    }

    log('info', 'Calling Synthetic', { jobId, model: runtime.model });

    const result = await callOpenAICompatible({
      baseUrl: SYNTHETIC_BASE_URL,
      apiKey,
      model: runtime.model,
      prompt,
      temperature: runtime.temperature,
      timeoutMs: SYNTHETIC_TIMEOUT_MS,
    });

    if (result.success) {
      log('info', 'Synthetic completed', { jobId, durationMs: result.durationMs });
    } else {
      log('error', 'Synthetic failed', { jobId, error: result.error, durationMs: result.durationMs });
    }

    return result;
  },
};

export default syntheticAdapter;

function log(level: string, msg: string, extra?: Record<string, unknown>): void {
  console.log(JSON.stringify({ level, msg, component: 'executor.synthetic', ts: new Date().toISOString(), ...extra }));
}
