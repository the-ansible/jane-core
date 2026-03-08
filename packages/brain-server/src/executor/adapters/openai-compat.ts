/**
 * Shared helper for OpenAI-compatible API calls.
 * Used by Mercury and Synthetic adapters.
 */

import type { AdapterResult } from '../types.js';

export interface OpenAICompatParams {
  baseUrl: string;
  apiKey: string;
  model: string;
  prompt: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  /** Extra body fields (e.g., reasoning_effort for Mercury) */
  extraBody?: Record<string, unknown>;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: { content?: string };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export async function callOpenAICompatible(params: OpenAICompatParams): Promise<AdapterResult> {
  const {
    baseUrl,
    apiKey,
    model,
    prompt,
    maxTokens = 4096,
    temperature,
    timeoutMs = 120_000,
    extraBody = {},
  } = params;

  const start = Date.now();

  try {
    const body: Record<string, unknown> = {
      model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: maxTokens,
      ...extraBody,
    };
    if (temperature !== undefined) {
      body.temperature = temperature;
    }

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });

    const durationMs = Date.now() - start;

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return {
        success: false,
        resultText: null,
        rawOutput: text,
        durationMs,
        error: `HTTP ${response.status}: ${text.slice(0, 500)}`,
      };
    }

    const data = await response.json() as ChatCompletionResponse;
    const resultText = data?.choices?.[0]?.message?.content?.trim() ?? null;

    return {
      success: resultText !== null,
      resultText,
      rawOutput: JSON.stringify(data),
      durationMs,
    };
  } catch (err) {
    return {
      success: false,
      resultText: null,
      rawOutput: '',
      durationMs: Date.now() - start,
      error: String(err),
    };
  }
}

/**
 * Read an API key from process env, falling back to /proc/1/environ.
 * Reuses the pattern from the stimulation server's Mercury classifier.
 */
export function getApiKey(envVar: string): string | undefined {
  if (process.env[envVar]) return process.env[envVar];

  try {
    const { readFileSync } = require('node:fs');
    const environ = readFileSync('/proc/1/environ');
    const vars = environ.toString().split('\0');
    for (const v of vars) {
      if (v.startsWith(`${envVar}=`)) {
        const val = v.slice(envVar.length + 1);
        if (val) return val;
      }
    }
  } catch {
    // /proc/1/environ not available
  }

  return undefined;
}
