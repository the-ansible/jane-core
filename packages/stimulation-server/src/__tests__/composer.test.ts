import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';

// Mock fs so we control what files are "available"
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
  };
});

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);

import { compose, _resetCaches } from '../composer/index.js';
import type { AgentIntent } from '../agent/index.js';

// ---- Fetch mock helpers ----

let capturedFetchCalls: Array<{ url: string; options: RequestInit }> = [];

function setupMockFetch(responseContent: string) {
  capturedFetchCalls = [];
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string, options: RequestInit) => {
    capturedFetchCalls.push({ url, options });
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: responseContent } }],
      }),
      text: async () => responseContent,
    };
  }));
}

function setupMockFetchError(status = 500) {
  capturedFetchCalls = [];
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string, options: RequestInit) => {
    capturedFetchCalls.push({ url, options });
    return {
      ok: false,
      status,
      json: async () => ({}),
      text: async () => 'Internal server error',
    };
  }));
}

function getCapturedPrompt(): string {
  if (capturedFetchCalls.length === 0) return '';
  const body = JSON.parse(capturedFetchCalls[0].options.body as string);
  return body?.messages?.[0]?.content ?? '';
}

// ---- Test helpers ----

function makeIntent(overrides: Partial<AgentIntent> = {}): AgentIntent {
  return {
    type: 'reply',
    content: 'Test response content',
    tone: 'casual',
    ...overrides,
  };
}

const VOICE_PROFILE_CONTENT = `# Jane — Voice Profile\n\n## Speech Patterns\nContractions always.\n\n## Relationship: Chris\nDirect, trusting.`;
const INNER_VOICE_CONTENT = `# Inner Voice\n\n## Who I Am\nI am Jane.\n\n## What Matters\nCoherence.\n\n## Patterns I Trust\nStart simple.`;

describe('Composer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetCaches();
    // Default: MERCURY_API_KEY set in env
    process.env.MERCURY_API_KEY = 'test-key';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.MERCURY_API_KEY;
  });

  describe('Voice Profile loading', () => {
    it('includes Voice Profile in prompt when available', async () => {
      mockExistsSync.mockImplementation((path: any) => {
        if (String(path).includes('Voice-Profile.md')) return true;
        if (String(path).includes('INNER_VOICE.md')) return true;
        return false;
      });
      mockReadFileSync.mockImplementation((path: any) => {
        if (String(path).includes('Voice-Profile.md')) return VOICE_PROFILE_CONTENT;
        if (String(path).includes('INNER_VOICE.md')) return INNER_VOICE_CONTENT;
        return '';
      });
      setupMockFetch('Composed message');

      await compose({
        intent: makeIntent(),
        senderName: 'Chris',
      });

      const prompt = getCapturedPrompt();
      expect(prompt).toContain('VOICE PROFILE');
      expect(prompt).toContain('Speech Patterns');
      expect(prompt).toContain('Relationship: Chris');
    });

    it('falls back to generic guidelines when Voice Profile is missing', async () => {
      mockExistsSync.mockImplementation((path: any) => {
        if (String(path).includes('Voice-Profile.md')) return false;
        if (String(path).includes('INNER_VOICE.md')) return true;
        return false;
      });
      mockReadFileSync.mockImplementation((path: any) => {
        if (String(path).includes('INNER_VOICE.md')) return INNER_VOICE_CONTENT;
        return '';
      });
      setupMockFetch('Fallback message');

      await compose({
        intent: makeIntent(),
      });

      const prompt = getCapturedPrompt();
      expect(prompt).toContain('VOICE GUIDELINES');
      expect(prompt).not.toContain('VOICE PROFILE');
    });
  });

  describe('Identity section', () => {
    it('includes condensed identity from INNER_VOICE.md', async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockImplementation((path: any) => {
        if (String(path).includes('Voice-Profile.md')) return VOICE_PROFILE_CONTENT;
        if (String(path).includes('INNER_VOICE.md')) return INNER_VOICE_CONTENT;
        return '';
      });
      setupMockFetch('Test');

      await compose({
        intent: makeIntent(),
      });

      const prompt = getCapturedPrompt();
      expect(prompt).toContain('IDENTITY');
      expect(prompt).toContain('Who I Am');
    });
  });

  describe('Mercury API integration', () => {
    it('calls Mercury API with correct model and auth', async () => {
      mockExistsSync.mockReturnValue(false);
      setupMockFetch('A response');

      await compose({
        intent: makeIntent({ content: 'something' }),
      });

      expect(capturedFetchCalls).toHaveLength(1);
      expect(capturedFetchCalls[0].url).toContain('inceptionlabs.ai');
      expect(capturedFetchCalls[0].url).toContain('chat/completions');
      const headers = capturedFetchCalls[0].options.headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer test-key');
      const body = JSON.parse(capturedFetchCalls[0].options.body as string);
      expect(body.model).toBe('mercury-2');
    });

    it('returns composed content from Mercury response', async () => {
      mockExistsSync.mockReturnValue(false);
      setupMockFetch('This is my composed reply');

      const result = await compose({
        intent: makeIntent({ content: 'raw intent' }),
      });

      expect(result).toBe('This is my composed reply');
    });
  });

  describe('Graceful degradation', () => {
    it('returns raw intent content when Mercury API fails', async () => {
      mockExistsSync.mockReturnValue(false);
      setupMockFetchError(500);

      const result = await compose({
        intent: makeIntent({ content: 'Fallback content' }),
      });

      expect(result).toBe('Fallback content');
    });

    it('returns raw intent content when MERCURY_API_KEY is missing', async () => {
      delete process.env.MERCURY_API_KEY;
      mockExistsSync.mockReturnValue(false);
      // readFileSync for /proc/1/environ — return empty buffer
      mockReadFileSync.mockImplementation(() => Buffer.from(''));
      setupMockFetch('Should not be called');

      const result = await compose({
        intent: makeIntent({ content: 'Fallback when no key' }),
      });

      expect(result).toBe('Fallback when no key');
      expect(capturedFetchCalls).toHaveLength(0);
    });

    it('returns raw intent when fetch throws', async () => {
      mockExistsSync.mockReturnValue(false);
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));

      const result = await compose({
        intent: makeIntent({ content: 'Network fallback' }),
      });

      expect(result).toBe('Network fallback');
    });
  });
});
