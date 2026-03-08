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

// Mock executor client
const mockInvoke = vi.fn();
vi.mock('../executor-client.js', () => ({
  invoke: (...args: any[]) => mockInvoke(...args),
}));

import { compose, _resetCaches } from '../composer/index.js';
import type { AgentIntent } from '../agent/index.js';

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
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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
      mockInvoke.mockResolvedValueOnce({ success: true, resultText: 'Composed message', durationMs: 10 });

      await compose({
        intent: makeIntent(),
        senderName: 'Chris',
      });

      expect(mockInvoke).toHaveBeenCalledOnce();
      const [opts] = mockInvoke.mock.calls[0];
      expect(opts.prompt).toContain('VOICE PROFILE');
      expect(opts.prompt).toContain('Speech Patterns');
      expect(opts.prompt).toContain('Relationship: Chris');
      expect(opts.runtime).toBe('mercury');
      expect(opts.model).toBe('mercury-2');
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
      mockInvoke.mockResolvedValueOnce({ success: true, resultText: 'Fallback message', durationMs: 10 });

      await compose({
        intent: makeIntent(),
      });

      const [opts] = mockInvoke.mock.calls[0];
      expect(opts.prompt).toContain('VOICE GUIDELINES');
      expect(opts.prompt).not.toContain('VOICE PROFILE');
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
      mockInvoke.mockResolvedValueOnce({ success: true, resultText: 'Test', durationMs: 10 });

      await compose({
        intent: makeIntent(),
      });

      const [opts] = mockInvoke.mock.calls[0];
      expect(opts.prompt).toContain('IDENTITY');
      expect(opts.prompt).toContain('Who I Am');
    });
  });

  describe('Executor integration', () => {
    it('calls executor with mercury runtime and correct params', async () => {
      mockExistsSync.mockReturnValue(false);
      mockInvoke.mockResolvedValueOnce({ success: true, resultText: 'A response', durationMs: 50 });

      await compose({
        intent: makeIntent({ content: 'something' }),
      });

      expect(mockInvoke).toHaveBeenCalledOnce();
      const [opts] = mockInvoke.mock.calls[0];
      expect(opts.runtime).toBe('mercury');
      expect(opts.model).toBe('mercury-2');
      expect(opts.reasoningEffort).toBe('instant');
      expect(opts.maxTokens).toBe(4096);
    });

    it('returns composed content from executor response', async () => {
      mockExistsSync.mockReturnValue(false);
      mockInvoke.mockResolvedValueOnce({ success: true, resultText: 'This is my composed reply', durationMs: 10 });

      const result = await compose({
        intent: makeIntent({ content: 'raw intent' }),
      });

      expect(result).toBe('This is my composed reply');
    });
  });

  describe('Graceful degradation', () => {
    it('returns raw intent content when executor fails', async () => {
      mockExistsSync.mockReturnValue(false);
      mockInvoke.mockResolvedValueOnce({ success: false, resultText: null, durationMs: 10, error: 'API error' });

      const result = await compose({
        intent: makeIntent({ content: 'Fallback content' }),
      });

      expect(result).toBe('Fallback content');
    });

    it('returns raw intent content when executor throws', async () => {
      mockExistsSync.mockReturnValue(false);
      mockInvoke.mockRejectedValueOnce(new Error('Network error'));

      const result = await compose({
        intent: makeIntent({ content: 'Network fallback' }),
      });

      expect(result).toBe('Network fallback');
    });
  });
});
