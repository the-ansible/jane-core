/**
 * Ollama runtime adapter — local Ollama instance.
 *
 * Free, no API key needed. Best for small models (<=8GB).
 * Performance degrades with larger models.
 * No tool use; prompt-only.
 */

import type { RuntimeAdapter, AdapterExecuteParams, AdapterResult } from '../types.js';

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://host.docker.internal:11434';
const OLLAMA_TIMEOUT_MS = 120_000; // 2 minutes

interface OllamaGenerateResponse {
  response?: string;
  done?: boolean;
  error?: string;
}

const ollamaAdapter: RuntimeAdapter = {
  name: 'ollama',

  async execute(params: AdapterExecuteParams): Promise<AdapterResult> {
    const { prompt, runtime, jobId } = params;
    const start = Date.now();

    log('info', 'Calling Ollama', { jobId, model: runtime.model });

    try {
      const response = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: runtime.model,
          prompt,
          stream: false,
          options: {
            ...(runtime.temperature !== undefined && { temperature: runtime.temperature }),
          },
        }),
        signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
      });

      const durationMs = Date.now() - start;

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        log('error', 'Ollama HTTP error', { jobId, status: response.status, durationMs });
        return {
          success: false,
          resultText: null,
          rawOutput: text,
          durationMs,
          error: `HTTP ${response.status}: ${text.slice(0, 500)}`,
        };
      }

      const data = await response.json() as OllamaGenerateResponse;

      if (data.error) {
        log('error', 'Ollama returned error', { jobId, error: data.error, durationMs });
        return {
          success: false,
          resultText: null,
          rawOutput: JSON.stringify(data),
          durationMs,
          error: data.error,
        };
      }

      const resultText = data.response?.trim() ?? null;
      log('info', 'Ollama completed', { jobId, durationMs, resultLength: resultText?.length ?? 0 });

      return {
        success: resultText !== null,
        resultText,
        rawOutput: JSON.stringify(data),
        durationMs,
      };
    } catch (err) {
      const durationMs = Date.now() - start;
      log('error', 'Ollama failed', { jobId, error: String(err), durationMs });
      return {
        success: false,
        resultText: null,
        rawOutput: '',
        durationMs,
        error: String(err),
      };
    }
  },
};

export default ollamaAdapter;

function log(level: string, msg: string, extra?: Record<string, unknown>): void {
  console.log(JSON.stringify({ level, msg, component: 'executor.ollama', ts: new Date().toISOString(), ...extra }));
}
