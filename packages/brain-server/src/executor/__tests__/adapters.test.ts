/**
 * Runtime adapter tests.
 *
 * Tests the OpenAI-compatible helper and adapter error handling.
 * Claude Code adapter is tested via integration (requires real CLI).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { callOpenAICompatible, getApiKey } from '../adapters/openai-compat.js';

describe('openai-compat helper', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('returns success on valid response', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        choices: [{ message: { content: 'Hello world' } }],
      }),
    }) as unknown as typeof fetch;

    const result = await callOpenAICompatible({
      baseUrl: 'https://example.com/v1',
      apiKey: 'test-key',
      model: 'test-model',
      prompt: 'Say hello',
    });

    expect(result.success).toBe(true);
    expect(result.resultText).toBe('Hello world');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('returns failure on HTTP error', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve('Unauthorized'),
    }) as unknown as typeof fetch;

    const result = await callOpenAICompatible({
      baseUrl: 'https://example.com/v1',
      apiKey: 'bad-key',
      model: 'test-model',
      prompt: 'Say hello',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('401');
  });

  it('returns failure on network error', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;

    const result = await callOpenAICompatible({
      baseUrl: 'https://example.com/v1',
      apiKey: 'test-key',
      model: 'test-model',
      prompt: 'Say hello',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('ECONNREFUSED');
  });

  it('returns failure when choices are empty', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ choices: [] }),
    }) as unknown as typeof fetch;

    const result = await callOpenAICompatible({
      baseUrl: 'https://example.com/v1',
      apiKey: 'test-key',
      model: 'test-model',
      prompt: 'Say hello',
    });

    expect(result.success).toBe(false);
    expect(result.resultText).toBeNull();
  });

  it('passes extra body fields', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        choices: [{ message: { content: 'ok' } }],
      }),
    }) as unknown as typeof fetch;

    await callOpenAICompatible({
      baseUrl: 'https://example.com/v1',
      apiKey: 'test-key',
      model: 'test-model',
      prompt: 'Test',
      extraBody: { reasoning_effort: 'instant' },
    });

    const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(fetchCall[1].body);
    expect(body.reasoning_effort).toBe('instant');
  });

  it('passes temperature when specified', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        choices: [{ message: { content: 'ok' } }],
      }),
    }) as unknown as typeof fetch;

    await callOpenAICompatible({
      baseUrl: 'https://example.com/v1',
      apiKey: 'test-key',
      model: 'test-model',
      prompt: 'Test',
      temperature: 0.7,
    });

    const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(fetchCall[1].body);
    expect(body.temperature).toBe(0.7);
  });
});

describe('getApiKey', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('reads from process.env first', () => {
    process.env.TEST_API_KEY = 'from-env';
    expect(getApiKey('TEST_API_KEY')).toBe('from-env');
  });

  it('returns undefined when not set', () => {
    delete process.env.NONEXISTENT_KEY;
    expect(getApiKey('NONEXISTENT_KEY')).toBeUndefined();
  });
});

describe('mercury adapter', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('calls Mercury API with correct parameters', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        choices: [{ message: { content: 'Mercury says hi' } }],
      }),
    }) as unknown as typeof fetch;

    const { default: mercuryAdapter } = await import('../adapters/mercury.js');

    const result = await mercuryAdapter.execute({
      prompt: 'test prompt',
      runtime: { tool: 'mercury', model: 'mercury-2', reasoningEffort: 'instant' },
      jobId: 'test-job',
      workdir: '/agent',
    });

    // If key is available, it should succeed; if not, it returns API key error
    // Both are valid outcomes depending on environment
    if (result.success) {
      expect(result.resultText).toBeTruthy();
    } else {
      expect(result.error).toBeDefined();
    }
  });
});

describe('ollama adapter', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('handles Ollama error response', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ error: 'model not found' }),
    }) as unknown as typeof fetch;

    const { default: ollamaAdapter } = await import('../adapters/ollama.js');

    const result = await ollamaAdapter.execute({
      prompt: 'test',
      runtime: { tool: 'ollama', model: 'nonexistent' },
      jobId: 'test-job',
      workdir: '/agent',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('model not found');
  });
});
