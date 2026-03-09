/**
 * Mercury runtime adapter — Inception's Mercury API (OpenAI-compatible).
 *
 * Supports multiple reasoning levels via `reasoningEffort`:
 *   - instant: ~100-300ms, minimal reasoning (voice composition, quick replies)
 *   - low/medium: balanced speed and depth
 *   - high: deep reasoning, slower but more capable
 *
 * Also supports: reasoning summaries, stop sequences, tool calling,
 * and configurable max tokens (1-50,000).
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
    if (runtime.reasoningSummary !== undefined) {
      extraBody.reasoning_summary = runtime.reasoningSummary;
    }
    if (runtime.reasoningSummaryWait !== undefined) {
      extraBody.reasoning_summary_wait = runtime.reasoningSummaryWait;
    }
    if (runtime.stop) {
      extraBody.stop = runtime.stop;
    }
    if (runtime.tools) {
      extraBody.tools = runtime.tools;
    }

    const result = await callOpenAICompatible({
      baseUrl: MERCURY_BASE_URL,
      apiKey,
      model: runtime.model || 'mercury-2',
      prompt,
      maxTokens: runtime.maxTokens,
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
