import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Use a temp directory so disk writes don't interfere with other test files
process.env.SESSIONS_DIR = mkdtempSync(join(tmpdir(), 'sessions-test-'));

import {
  getSession,
  appendMessage,
  getContextMessages,
  needsCompaction,
  compactSession,
  listSessions,
  getMessageCount,
  clearAllSessions,
  type SessionMessage,
} from '../sessions/store.js';

describe('Session Store', () => {
  beforeEach(() => {
    clearAllSessions();
  });

  describe('getSession', () => {
    it('creates a new session if none exists', () => {
      const session = getSession('test-session-1');
      expect(session.sessionId).toBe('test-session-1');
      expect(session.messages).toEqual([]);
      expect(session.createdAt).toBeDefined();
      expect(session.lastActivityAt).toBeDefined();
      expect(session.metadata).toEqual({});
    });

    it('returns existing session on subsequent calls', () => {
      const s1 = getSession('test-session-2');
      appendMessage('test-session-2', {
        role: 'user',
        content: 'Hello',
        timestamp: new Date().toISOString(),
      });
      const s2 = getSession('test-session-2');
      expect(s2.messages.length).toBe(1);
      expect(s1).toBe(s2); // Same reference
    });
  });

  describe('appendMessage', () => {
    it('appends a message to the session', () => {
      appendMessage('sess-append', {
        role: 'user',
        content: 'Hi there',
        timestamp: '2026-02-28T12:00:00Z',
      });
      const session = getSession('sess-append');
      expect(session.messages.length).toBe(1);
      expect(session.messages[0].content).toBe('Hi there');
      expect(session.lastActivityAt).toBe('2026-02-28T12:00:00Z');
    });

    it('appends multiple messages in order', () => {
      appendMessage('sess-multi', {
        role: 'user',
        content: 'First',
        timestamp: '2026-02-28T12:00:00Z',
      });
      appendMessage('sess-multi', {
        role: 'assistant',
        content: 'Second',
        timestamp: '2026-02-28T12:00:01Z',
      });
      appendMessage('sess-multi', {
        role: 'user',
        content: 'Third',
        timestamp: '2026-02-28T12:00:02Z',
      });
      const session = getSession('sess-multi');
      expect(session.messages.length).toBe(3);
      expect(session.messages.map(m => m.content)).toEqual(['First', 'Second', 'Third']);
    });
  });

  describe('getContextMessages', () => {
    it('returns last N messages (default 20)', () => {
      for (let i = 0; i < 25; i++) {
        appendMessage('sess-ctx', {
          role: 'user',
          content: `Message ${i}`,
          timestamp: new Date().toISOString(),
        });
      }
      const recent = getContextMessages('sess-ctx');
      expect(recent.length).toBe(20);
      expect(recent[0].content).toBe('Message 5');
      expect(recent[19].content).toBe('Message 24');
    });

    it('returns all messages if fewer than limit', () => {
      appendMessage('sess-few', {
        role: 'user',
        content: 'Only one',
        timestamp: new Date().toISOString(),
      });
      const recent = getContextMessages('sess-few');
      expect(recent.length).toBe(1);
    });

    it('respects custom limit', () => {
      for (let i = 0; i < 10; i++) {
        appendMessage('sess-lim', {
          role: 'user',
          content: `Msg ${i}`,
          timestamp: new Date().toISOString(),
        });
      }
      const recent = getContextMessages('sess-lim', 3);
      expect(recent.length).toBe(3);
      expect(recent[0].content).toBe('Msg 7');
    });
  });

  describe('needsCompaction', () => {
    it('returns false for short sessions', () => {
      appendMessage('sess-short', {
        role: 'user',
        content: 'Hello',
        timestamp: new Date().toISOString(),
      });
      expect(needsCompaction('sess-short')).toBe(false);
    });

    it('returns true when exceeding threshold', () => {
      for (let i = 0; i < 41; i++) {
        appendMessage('sess-long', {
          role: 'user',
          content: `Msg ${i}`,
          timestamp: new Date().toISOString(),
        });
      }
      expect(needsCompaction('sess-long')).toBe(true);
    });

    it('returns false for non-existent session', () => {
      expect(needsCompaction('nonexistent')).toBe(false);
    });
  });

  describe('compactSession', () => {
    it('compacts messages keeping recent ones plus summary', async () => {
      for (let i = 0; i < 45; i++) {
        appendMessage('sess-compact', {
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: `Message ${i}`,
          timestamp: new Date().toISOString(),
        });
      }
      expect(getMessageCount('sess-compact')).toBe(45);

      const mockSummarize = async (msgs: SessionMessage[]) =>
        `Summary of ${msgs.length} messages`;

      await compactSession('sess-compact', mockSummarize);

      const session = getSession('sess-compact');
      // Should be 1 summary + 10 recent = 11
      expect(session.messages.length).toBe(11);
      expect(session.messages[0].role).toBe('system');
      expect(session.messages[0].content).toContain('Summary of 35 messages');
    });

    it('does nothing if under threshold', async () => {
      appendMessage('sess-no-compact', {
        role: 'user',
        content: 'Short',
        timestamp: new Date().toISOString(),
      });

      const mockSummarize = async () => 'summary';
      await compactSession('sess-no-compact', mockSummarize);

      expect(getMessageCount('sess-no-compact')).toBe(1);
    });
  });

  describe('listSessions / getMessageCount', () => {
    it('lists active sessions', () => {
      getSession('a');
      getSession('b');
      getSession('c');
      const ids = listSessions();
      expect(ids).toContain('a');
      expect(ids).toContain('b');
      expect(ids).toContain('c');
    });

    it('returns message count', () => {
      appendMessage('count-test', { role: 'user', content: 'a', timestamp: '' });
      appendMessage('count-test', { role: 'assistant', content: 'b', timestamp: '' });
      expect(getMessageCount('count-test')).toBe(2);
    });

    it('returns 0 for unknown session', () => {
      expect(getMessageCount('unknown')).toBe(0);
    });
  });
});
