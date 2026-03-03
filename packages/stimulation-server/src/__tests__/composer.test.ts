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

// Mock child_process to avoid actually spawning Claude
vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);

// We need to access buildComposerPrompt indirectly through compose,
// but for testing the prompt structure we'll test the module's behavior.
// Since buildComposerPrompt is not exported, we test through compose's behavior
// and verify the prompt structure via the spawned process input.

import { spawn } from 'node:child_process';
import { compose, _resetCaches } from '../composer/index.js';
import type { AgentIntent } from '../agent/index.js';
import type { SessionMessage } from '../sessions/store.js';
import type { AssembledContext } from '../context/types.js';

const mockSpawn = vi.mocked(spawn);

function makeIntent(overrides: Partial<AgentIntent> = {}): AgentIntent {
  return {
    type: 'reply',
    content: 'Test response content',
    tone: 'casual',
    ...overrides,
  };
}

function makeHistory(count: number): SessionMessage[] {
  const messages: SessionMessage[] = [];
  for (let i = 0; i < count; i++) {
    messages.push({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `Message ${i + 1}`,
      timestamp: new Date(Date.now() - (count - i) * 60000).toISOString(),
    });
  }
  return messages;
}

function makeAssembledContext(messages: SessionMessage[]): AssembledContext {
  return {
    summaries: [],
    recentMessages: messages,
    meta: {
      assemblyLogId: 'test-log-id', planName: 'baseline_v1', summaryCount: 0,
      rawMessageCount: messages.length, totalMessageCoverage: messages.length,
      estimatedTokens: 0, rawTokens: 0, summaryTokens: 0, summaryBudget: 12000,
      budgetUtilization: 0, rawOverBudget: false, assemblyMs: 1,
      summarizationMs: null, newSummariesCreated: 0,
    },
  };
}

function captureStdinFromSpawn(): string {
  // Get the stdin data that was written to the spawned process
  const calls = mockSpawn.mock.calls;
  if (calls.length === 0) return '';

  // The stdin.write call is captured via the mock
  const proc = mockSpawn.mock.results[0]?.value;
  if (!proc?._stdinData) return '';
  return proc._stdinData;
}

function setupMockSpawn(result: string) {
  const mockProc = {
    stdin: {
      write: vi.fn().mockImplementation(function(this: any, data: string) {
        mockProc._stdinData = (mockProc._stdinData || '') + data;
      }),
      end: vi.fn(),
    },
    stdout: {
      on: vi.fn().mockImplementation((event: string, cb: Function) => {
        if (event === 'data') {
          // Send the result data
          setTimeout(() => cb(Buffer.from(result)), 10);
        }
      }),
    },
    stderr: {
      on: vi.fn(),
    },
    on: vi.fn().mockImplementation((event: string, cb: Function) => {
      if (event === 'close') {
        setTimeout(() => cb(0, null), 20);
      }
    }),
    exitCode: null,
    kill: vi.fn(),
    _stdinData: '',
  };

  mockSpawn.mockReturnValue(mockProc as any);
  return mockProc;
}

const VOICE_PROFILE_CONTENT = `# Jane — Voice Profile\n\n## Speech Patterns\nContractions always.\n\n## Relationship: Chris\nDirect, trusting.`;
const INNER_VOICE_CONTENT = `# Inner Voice\n\n## Who I Am\nI am Jane.\n\n## What Matters\nCoherence.\n\n## Patterns I Trust\nStart simple.`;

describe('Composer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    _resetCaches();
  });

  afterEach(() => {
    vi.useRealTimers();
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

      const mockProc = setupMockSpawn(JSON.stringify({ type: 'result', result: 'Composed message' }));

      const promise = compose({
        intent: makeIntent(),
        assembledContext: makeAssembledContext([]),
        senderName: 'Chris',
      });

      vi.advanceTimersByTime(100);
      await promise;

      const stdinData = mockProc._stdinData;
      expect(stdinData).toContain('VOICE PROFILE');
      expect(stdinData).toContain('Speech Patterns');
      expect(stdinData).toContain('Relationship: Chris');
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

      const mockProc = setupMockSpawn(JSON.stringify({ type: 'result', result: 'Fallback message' }));

      const promise = compose({
        intent: makeIntent(),
        assembledContext: makeAssembledContext([]),
      });

      vi.advanceTimersByTime(100);
      await promise;

      const stdinData = mockProc._stdinData;
      expect(stdinData).toContain('VOICE GUIDELINES');
      expect(stdinData).not.toContain('VOICE PROFILE');
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

      const mockProc = setupMockSpawn(JSON.stringify({ type: 'result', result: 'Test' }));

      const promise = compose({
        intent: makeIntent(),
        assembledContext: makeAssembledContext([]),
      });

      vi.advanceTimersByTime(100);
      await promise;

      const stdinData = mockProc._stdinData;
      expect(stdinData).toContain('IDENTITY');
      expect(stdinData).toContain('Who I Am');
    });
  });

  describe('Session history', () => {
    it('includes last 8 messages for continuity', async () => {
      mockExistsSync.mockReturnValue(false);

      const mockProc = setupMockSpawn(JSON.stringify({ type: 'result', result: 'Response' }));

      const history = makeHistory(12);

      const promise = compose({
        intent: makeIntent(),
        assembledContext: makeAssembledContext(history),
        senderName: 'Chris',
      });

      vi.advanceTimersByTime(100);
      await promise;

      const stdinData = mockProc._stdinData;
      // Should contain messages 5-12 (last 8), not messages 1-4
      expect(stdinData).toContain('Message 5');
      expect(stdinData).toContain('Message 12');
      expect(stdinData).not.toContain('Message 4');
    });

    it('uses sender name in conversation history', async () => {
      mockExistsSync.mockReturnValue(false);

      const mockProc = setupMockSpawn(JSON.stringify({ type: 'result', result: 'Response' }));

      const promise = compose({
        intent: makeIntent(),
        assembledContext: makeAssembledContext([
          { role: 'user', content: 'Hello', timestamp: new Date().toISOString() },
          { role: 'assistant', content: 'Hi there', timestamp: new Date().toISOString() },
        ]),
        senderName: 'Chris',
      });

      vi.advanceTimersByTime(100);
      await promise;

      const stdinData = mockProc._stdinData;
      expect(stdinData).toContain('Chris: Hello');
      expect(stdinData).toContain('Jane: Hi there');
    });
  });

  describe('Graceful degradation', () => {
    it('returns raw intent content when Claude CLI fails', async () => {
      mockExistsSync.mockReturnValue(false);

      const mockProc = {
        stdin: { write: vi.fn(), end: vi.fn() },
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn().mockImplementation((event: string, cb: Function) => {
          if (event === 'close') {
            setTimeout(() => cb(1, null), 10); // Non-zero exit
          }
        }),
        exitCode: null,
        kill: vi.fn(),
      };
      mockSpawn.mockReturnValue(mockProc as any);

      const promise = compose({
        intent: makeIntent({ content: 'Fallback content' }),
        assembledContext: makeAssembledContext([]),
      });

      vi.advanceTimersByTime(100);
      const result = await promise;

      expect(result).toBe('Fallback content');
    });
  });
});
