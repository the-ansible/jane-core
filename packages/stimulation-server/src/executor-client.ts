/**
 * Executor client — calls the brain server's executor API for all AI adapter invocations.
 *
 * All AI calls in the stimulation server route through here, which calls
 * POST http://localhost:3103/api/executor/invoke on the brain server.
 * This centralizes runtime management, API key handling, and model selection.
 */

const BRAIN_SERVER_URL = process.env.BRAIN_SERVER_URL || 'http://localhost:3103';
const DEFAULT_TIMEOUT_MS = 30_000;

export interface InvokeOptions {
  /** Runtime adapter: mercury, ollama, synthetic, claude-code */
  runtime: 'mercury' | 'ollama' | 'synthetic' | 'claude-code';
  /** Model identifier */
  model: string;
  /** The prompt text */
  prompt: string;
  /** Max tokens (default 4096) */
  maxTokens?: number;
  /** Temperature (optional) */
  temperature?: number;
  /** Mercury-specific reasoning effort */
  reasoningEffort?: 'instant' | 'low' | 'medium' | 'high';
  /** Request timeout in ms (default 30s) */
  timeoutMs?: number;
}

export interface InvokeResult {
  success: boolean;
  resultText: string | null;
  durationMs: number;
  error?: string;
}

/**
 * Invoke an executor adapter via the brain server HTTP API.
 * Returns the result inline (synchronous call, no job tracking).
 */
export async function invoke(options: InvokeOptions): Promise<InvokeResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const start = Date.now();

  try {
    const response = await fetch(`${BRAIN_SERVER_URL}/api/executor/invoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        runtime: options.runtime,
        model: options.model,
        prompt: options.prompt,
        maxTokens: options.maxTokens,
        temperature: options.temperature,
        reasoningEffort: options.reasoningEffort,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    const data = await response.json() as InvokeResult;
    return data;
  } catch (err) {
    return {
      success: false,
      resultText: null,
      durationMs: Date.now() - start,
      error: `Executor client error: ${String(err)}`,
    };
  }
}
