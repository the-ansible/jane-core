import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Use a temp directory so disk writes don't interfere with other test files
process.env.SESSIONS_DIR = mkdtempSync(join(tmpdir(), 'pipeline-test-'));

import { processPipeline, type PipelineDeps } from '../pipeline.js';
import { clearAllSessions, getSession, appendMessage } from '../sessions/store.js';
import type { CommunicationEvent } from '@the-ansible/life-system-shared';
import type { ClassificationResult } from '../classifier/types.js';

// Mock the agent and composer modules
vi.mock('../agent/index.js', () => ({
  invokeAgent: vi.fn(),
}));

vi.mock('../composer/index.js', () => ({
  compose: vi.fn(),
}));

import { invokeAgent } from '../agent/index.js';
import { compose } from '../composer/index.js';

const mockInvokeAgent = vi.mocked(invokeAgent);
const mockCompose = vi.mocked(compose);

function makeEvent(overrides: Partial<CommunicationEvent> = {}): CommunicationEvent {
  return {
    id: '019502e4-0000-7000-8000-000000000001',
    sessionId: 'test-session',
    channelType: 'realtime',
    direction: 'inbound',
    contentType: 'markdown',
    content: 'Hey Jane, how are you?',
    metadata: {},
    timestamp: '2026-02-28T12:00:00.000Z',
    sender: {
      id: 'chris',
      displayName: 'Chris',
      type: 'person',
    },
    ...overrides,
  } as CommunicationEvent;
}

function makeClassification(overrides: Partial<ClassificationResult> = {}): ClassificationResult {
  return {
    category: 'chat',
    urgency: 'low',
    confidence: 0.9,
    routing: 'reflexive_reply',
    tier: 'rules',
    ...overrides,
  };
}

function makeDeps(overrides: Partial<PipelineDeps> = {}): PipelineDeps {
  return {
    nats: null,
    safety: null,
    ...overrides,
  };
}

describe('Pipeline', () => {
  beforeEach(() => {
    clearAllSessions();
    vi.clearAllMocks();
  });

  describe('log-only routing', () => {
    it('returns log action without invoking agent', async () => {
      const result = await processPipeline(
        makeEvent(),
        makeClassification({ routing: 'log_only' }),
        makeDeps()
      );

      expect(result.action).toBe('log');
      expect(result.responded).toBe(false);
      expect(mockInvokeAgent).not.toHaveBeenCalled();
      expect(mockCompose).not.toHaveBeenCalled();
    });

    it('still records the inbound message in session', async () => {
      await processPipeline(
        makeEvent({ sessionId: 'log-sess' }),
        makeClassification({ routing: 'log_only' }),
        makeDeps()
      );

      const session = getSession('log-sess');
      expect(session.messages.length).toBe(1);
      expect(session.messages[0].role).toBe('user');
      expect(session.messages[0].content).toBe('Hey Jane, how are you?');
    });
  });

  describe('reply routing', () => {
    it('invokes agent and composer for reply routing', async () => {
      mockInvokeAgent.mockResolvedValue({
        type: 'reply',
        content: 'I am doing great!',
        tone: 'casual',
      });
      mockCompose.mockResolvedValue('Doing great! What about you?');

      const mockPublish = vi.fn().mockResolvedValue(undefined);
      const mockNats = {
        isConnected: () => true,
        publish: mockPublish,
      } as any;

      const result = await processPipeline(
        makeEvent(),
        makeClassification({ routing: 'reflexive_reply' }),
        makeDeps({ nats: mockNats })
      );

      expect(result.action).toBe('reply');
      expect(result.responded).toBe(true);
      expect(result.responseEventId).toBeDefined();
      expect(result.agentIntent?.type).toBe('reply');
      expect(mockInvokeAgent).toHaveBeenCalledOnce();
      expect(mockCompose).toHaveBeenCalledOnce();
      expect(mockPublish).toHaveBeenCalledOnce();
    });

    it('publishes to correct NATS subject', async () => {
      mockInvokeAgent.mockResolvedValue({
        type: 'reply',
        content: 'Response',
        tone: 'casual',
      });
      mockCompose.mockResolvedValue('Composed response');

      const mockPublish = vi.fn().mockResolvedValue(undefined);
      const mockNats = {
        isConnected: () => true,
        publish: mockPublish,
      } as any;

      await processPipeline(
        makeEvent({ channelType: 'realtime' }),
        makeClassification({ routing: 'reflexive_reply' }),
        makeDeps({ nats: mockNats })
      );

      expect(mockPublish).toHaveBeenCalledWith(
        'communication.outbound.realtime',
        expect.objectContaining({
          direction: 'outbound',
          content: 'Composed response',
          sender: expect.objectContaining({ id: 'jane', type: 'agent' }),
        })
      );
    });

    it('records both inbound and outbound in session', async () => {
      mockInvokeAgent.mockResolvedValue({
        type: 'reply',
        content: 'Intent',
        tone: 'casual',
      });
      mockCompose.mockResolvedValue('Composed');

      const mockNats = {
        isConnected: () => true,
        publish: vi.fn().mockResolvedValue(undefined),
      } as any;

      await processPipeline(
        makeEvent({ sessionId: 'roundtrip-sess' }),
        makeClassification({ routing: 'reflexive_reply' }),
        makeDeps({ nats: mockNats })
      );

      const session = getSession('roundtrip-sess');
      expect(session.messages.length).toBe(2);
      expect(session.messages[0].role).toBe('user');
      expect(session.messages[1].role).toBe('assistant');
      expect(session.messages[1].content).toBe('Composed');
    });
  });

  describe('error handling', () => {
    it('handles agent returning null', async () => {
      mockInvokeAgent.mockResolvedValue(null);

      const result = await processPipeline(
        makeEvent(),
        makeClassification({ routing: 'reflexive_reply' }),
        makeDeps()
      );

      expect(result.responded).toBe(false);
      expect(result.agentIntent).toBeNull();
      expect(result.error).toContain('Agent returned no intent');
      expect(mockCompose).not.toHaveBeenCalled();
    });

    it('handles composer returning null', async () => {
      mockInvokeAgent.mockResolvedValue({
        type: 'reply',
        content: 'Intent here',
        tone: 'casual',
      });
      mockCompose.mockResolvedValue(null);

      const result = await processPipeline(
        makeEvent(),
        makeClassification({ routing: 'reflexive_reply' }),
        makeDeps()
      );

      expect(result.responded).toBe(false);
      expect(result.error).toContain('Composer returned no message');
    });

    it('handles NATS not connected', async () => {
      mockInvokeAgent.mockResolvedValue({
        type: 'reply',
        content: 'Intent',
        tone: 'casual',
      });
      mockCompose.mockResolvedValue('Composed');

      const result = await processPipeline(
        makeEvent(),
        makeClassification({ routing: 'reflexive_reply' }),
        makeDeps({ nats: null })
      );

      expect(result.responded).toBe(false);
      expect(result.error).toContain('NATS not connected');
    });

    it('handles NATS publish failure', async () => {
      mockInvokeAgent.mockResolvedValue({
        type: 'reply',
        content: 'Intent',
        tone: 'casual',
      });
      mockCompose.mockResolvedValue('Composed');

      const mockNats = {
        isConnected: () => true,
        publish: vi.fn().mockRejectedValue(new Error('publish timeout')),
      } as any;

      const result = await processPipeline(
        makeEvent(),
        makeClassification({ routing: 'reflexive_reply' }),
        makeDeps({ nats: mockNats })
      );

      expect(result.responded).toBe(false);
      expect(result.error).toContain('Publish failed');
    });
  });

  describe('safety gate', () => {
    it('blocks when safety gate denies Claude calls', async () => {
      const mockSafety = {
        canCallClaude: vi.fn().mockReturnValue({
          allowed: false,
          reasons: ['Rate limit exceeded'],
        }),
      } as any;

      const result = await processPipeline(
        makeEvent(),
        makeClassification({ routing: 'reflexive_reply' }),
        makeDeps({ safety: mockSafety })
      );

      expect(result.responded).toBe(false);
      expect(result.reason).toContain('Blocked by safety');
      expect(mockInvokeAgent).not.toHaveBeenCalled();
    });

    it('proceeds when safety gate allows', async () => {
      mockInvokeAgent.mockResolvedValue(null);

      const mockSafety = {
        canCallClaude: vi.fn().mockReturnValue({ allowed: true, reasons: [] }),
        recordLlmCall: vi.fn(),
      } as any;

      await processPipeline(
        makeEvent(),
        makeClassification({ routing: 'reflexive_reply' }),
        makeDeps({ safety: mockSafety })
      );

      expect(mockInvokeAgent).toHaveBeenCalledOnce();
    });

    it('records LLM calls for both agent and composer', async () => {
      mockInvokeAgent.mockResolvedValue({
        type: 'reply',
        content: 'Intent',
        tone: 'casual',
      });
      mockCompose.mockResolvedValue('Composed');

      const mockSafety = {
        canCallClaude: vi.fn().mockReturnValue({ allowed: true, reasons: [] }),
        recordLlmCall: vi.fn(),
        recordSend: vi.fn(),
      } as any;

      const mockNats = {
        isConnected: () => true,
        publish: vi.fn().mockResolvedValue(undefined),
      } as any;

      await processPipeline(
        makeEvent(),
        makeClassification({ routing: 'reflexive_reply' }),
        makeDeps({ nats: mockNats, safety: mockSafety })
      );

      // Should record LLM calls for both agent and composer
      expect(mockSafety.recordLlmCall).toHaveBeenCalledTimes(2);
      expect(mockSafety.recordSend).toHaveBeenCalledOnce();
    });
  });

  describe('sender handling', () => {
    it('uses sender displayName for session messages', async () => {
      await processPipeline(
        makeEvent({
          sessionId: 'sender-sess',
          sender: { id: 'u1', displayName: 'Alice', type: 'person' },
        }),
        makeClassification({ routing: 'log_only' }),
        makeDeps()
      );

      const session = getSession('sender-sess');
      expect(session.messages[0].role).toBe('user');
    });

    it('falls back to sender id when no displayName', async () => {
      mockInvokeAgent.mockResolvedValue(null);

      const mockSafety = {
        canCallClaude: vi.fn().mockReturnValue({ allowed: true, reasons: [] }),
        recordLlmCall: vi.fn(),
      } as any;

      await processPipeline(
        makeEvent({
          sender: { id: 'user-123', type: 'person' } as any,
        }),
        makeClassification({ routing: 'reflexive_reply' }),
        makeDeps({ safety: mockSafety })
      );

      // Agent should be called with senderName derived from sender.id
      expect(mockInvokeAgent).toHaveBeenCalledWith(
        expect.objectContaining({ senderName: 'user-123' })
      );
    });
  });

  describe('active-session override', () => {
    it('overrides log_only to reply when session has recent Jane activity', async () => {
      // Seed session with a recent Jane message
      appendMessage('active-sess', {
        role: 'user',
        content: 'What time is it?',
        timestamp: new Date(Date.now() - 5 * 60 * 1000).toISOString(), // 5 min ago
      });
      appendMessage('active-sess', {
        role: 'assistant',
        content: 'It is 10 PM Pacific.',
        timestamp: new Date(Date.now() - 4 * 60 * 1000).toISOString(), // 4 min ago
      });

      mockInvokeAgent.mockResolvedValue({
        type: 'acknowledgment',
        content: 'Acknowledged',
        tone: 'casual',
      });
      mockCompose.mockResolvedValue('Thanks!');

      const mockNats = {
        isConnected: () => true,
        publish: vi.fn().mockResolvedValue(undefined),
      } as any;

      const result = await processPipeline(
        makeEvent({ sessionId: 'active-sess', content: 'Good job!' }),
        makeClassification({ routing: 'log_only' }),
        makeDeps({ nats: mockNats })
      );

      // Should have been overridden from log to reply
      expect(result.action).toBe('reply');
      expect(result.responded).toBe(true);
      expect(result.reason).toContain('active_session_override');
      expect(mockInvokeAgent).toHaveBeenCalled();
    });

    it('does NOT override log_only when session has no recent activity', async () => {
      // Seed session with an old Jane message (> 10 min ago)
      appendMessage('stale-sess', {
        role: 'assistant',
        content: 'Old message',
        timestamp: new Date(Date.now() - 15 * 60 * 1000).toISOString(), // 15 min ago
      });

      const result = await processPipeline(
        makeEvent({ sessionId: 'stale-sess', content: 'Good job!' }),
        makeClassification({ routing: 'log_only' }),
        makeDeps()
      );

      expect(result.action).toBe('log');
      expect(result.responded).toBe(false);
      expect(mockInvokeAgent).not.toHaveBeenCalled();
    });

    it('does NOT override log_only when session is empty', async () => {
      const result = await processPipeline(
        makeEvent({ sessionId: 'empty-sess', content: 'ok' }),
        makeClassification({ routing: 'log_only' }),
        makeDeps()
      );

      expect(result.action).toBe('log');
      expect(result.responded).toBe(false);
    });
  });

  describe('think and escalate routing', () => {
    it('handles think routing same as reply', async () => {
      mockInvokeAgent.mockResolvedValue(null);

      const result = await processPipeline(
        makeEvent(),
        makeClassification({ routing: 'deliberate_thought' }),
        makeDeps()
      );

      expect(result.action).toBe('think');
      expect(mockInvokeAgent).toHaveBeenCalledOnce();
    });

    it('handles escalate routing same as reply', async () => {
      mockInvokeAgent.mockResolvedValue(null);

      const result = await processPipeline(
        makeEvent(),
        makeClassification({ routing: 'escalate' }),
        makeDeps()
      );

      expect(result.action).toBe('escalate');
      expect(mockInvokeAgent).toHaveBeenCalledOnce();
    });
  });
});
