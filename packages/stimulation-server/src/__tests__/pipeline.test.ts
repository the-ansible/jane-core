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

vi.mock('../composer/task-extractor.js', () => ({
  extractAndDispatchTask: vi.fn().mockResolvedValue(undefined),
}));

// Mock context assembler
vi.mock('../context/assembler.js', () => ({
  assembleContext: vi.fn().mockResolvedValue({
    summaries: [],
    recentMessages: [],
    meta: {
      assemblyLogId: 'test-assembly-log-id',
      planName: 'baseline_v1',
      summaryCount: 0,
      rawMessageCount: 0,
      totalMessageCoverage: 0,
      estimatedTokens: 0,
      rawTokens: 0,
      summaryTokens: 0,
      summaryBudget: 12000,
      budgetUtilization: 0,
      rawOverBudget: false,
      assemblyMs: 5,
      summarizationMs: null,
      newSummariesCreated: 0,
    },
  }),
}));

// Mock context DB
vi.mock('../context/db.js', () => ({
  updateAssemblyOutcome: vi.fn().mockResolvedValue(undefined),
}));

// Mock pipeline runs
vi.mock('../pipeline-runs.js', () => ({
  startRun: vi.fn().mockReturnValue({ runId: 'test-run-id' }),
  beginStage: vi.fn(),
  completeStage: vi.fn(),
  failStage: vi.fn(),
  completeRun: vi.fn(),
  setRunOutputs: vi.fn(),
}));

// Mock job registry (no DB in tests)
vi.mock('../agent/job-registry.js', () => ({
  markJobCompleted: vi.fn().mockResolvedValue(undefined),
  markJobFailed: vi.fn().mockResolvedValue(undefined),
  getJobById: vi.fn().mockResolvedValue(null),
}));

// Mock graphiti client — deterministic memory facts in tests
vi.mock('../graphiti/client.js', () => ({
  searchMemory: vi.fn().mockResolvedValue([]),
  ingestEpisode: vi.fn().mockResolvedValue({ episodeId: null, error: null }),
}));

import { invokeAgent } from '../agent/index.js';
import { compose } from '../composer/index.js';
import { extractAndDispatchTask } from '../composer/task-extractor.js';
import { assembleContext } from '../context/assembler.js';
import { updateAssemblyOutcome } from '../context/db.js';
import { startRun, beginStage, completeStage, failStage, completeRun } from '../pipeline-runs.js';
import { searchMemory } from '../graphiti/client.js';

const mockInvokeAgent = vi.mocked(invokeAgent);
const mockCompose = vi.mocked(compose);
const mockExtractAndDispatchTask = vi.mocked(extractAndDispatchTask);
const mockSearchMemory = vi.mocked(searchMemory);
const mockAssembleContext = vi.mocked(assembleContext);
const mockUpdateOutcome = vi.mocked(updateAssemblyOutcome);
const mockStartRun = vi.mocked(startRun);
const mockBeginStage = vi.mocked(beginStage);
const mockCompleteStage = vi.mocked(completeStage);
const mockFailStage = vi.mocked(failStage);
const mockCompleteRun = vi.mocked(completeRun);

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
        intent: { type: 'reply', content: 'I am doing great!', tone: 'casual' },
        jobId: null,
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
        intent: { type: 'reply', content: 'Response', tone: 'casual' },
        jobId: null,
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
        intent: { type: 'reply', content: 'Intent', tone: 'casual' },
        jobId: null,
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
      mockInvokeAgent.mockResolvedValue({ intent: null, jobId: null });

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
        intent: { type: 'reply', content: 'Intent here', tone: 'casual' },
        jobId: null,
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
        intent: { type: 'reply', content: 'Intent', tone: 'casual' },
        jobId: null,
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
        intent: { type: 'reply', content: 'Intent', tone: 'casual' },
        jobId: null,
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
      mockInvokeAgent.mockResolvedValue({ intent: null, jobId: null });

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
        intent: { type: 'reply', content: 'Intent', tone: 'casual' },
        jobId: null,
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
      mockInvokeAgent.mockResolvedValue({ intent: null, jobId: null });

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
        intent: { type: 'acknowledgment', content: 'Acknowledged', tone: 'casual' },
        jobId: null,
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

  describe('pipeline run tracking', () => {
    it('starts a run and completes on log-only', async () => {
      await processPipeline(
        makeEvent({ sessionId: 'tracking-log-sess' }),
        makeClassification({ routing: 'log_only' }),
        makeDeps()
      );

      expect(mockStartRun).toHaveBeenCalledWith(expect.objectContaining({
        runId: '019502e4-0000-7000-8000-000000000001',
        sessionId: 'tracking-log-sess',
      }));
      expect(mockCompleteRun).toHaveBeenCalledWith('test-run-id', 'success', expect.objectContaining({ routeAction: 'log' }));
    });

    it('tracks all stages on successful reply', async () => {
      mockInvokeAgent.mockResolvedValue({ intent: { type: 'reply', content: 'Hi', tone: 'casual' }, jobId: null });
      mockCompose.mockResolvedValue('Hey!');

      const mockNats = {
        isConnected: () => true,
        publish: vi.fn().mockResolvedValue(undefined),
      } as any;

      await processPipeline(
        makeEvent(),
        makeClassification({ routing: 'reflexive_reply' }),
        makeDeps({ nats: mockNats })
      );

      expect(mockBeginStage).toHaveBeenCalledWith('test-run-id', 'routing');
      expect(mockCompleteStage).toHaveBeenCalledWith('test-run-id', 'routing', 'reply');
      expect(mockBeginStage).toHaveBeenCalledWith('test-run-id', 'safety_check');
      expect(mockBeginStage).toHaveBeenCalledWith('test-run-id', 'context_assembly');
      expect(mockBeginStage).toHaveBeenCalledWith('test-run-id', 'agent');
      expect(mockBeginStage).toHaveBeenCalledWith('test-run-id', 'composer');
      expect(mockBeginStage).toHaveBeenCalledWith('test-run-id', 'publish');
      expect(mockCompleteRun).toHaveBeenCalledWith('test-run-id', 'success', expect.objectContaining({ routeAction: 'reply' }));
    });

    it('fails stage on agent null', async () => {
      mockInvokeAgent.mockResolvedValue({ intent: null, jobId: null });

      await processPipeline(
        makeEvent(),
        makeClassification({ routing: 'reflexive_reply' }),
        makeDeps()
      );

      expect(mockFailStage).toHaveBeenCalledWith('test-run-id', 'agent', 'Agent returned no intent');
      expect(mockCompleteRun).toHaveBeenCalledWith('test-run-id', 'failure', expect.objectContaining({ error: 'Agent returned no intent' }));
    });

    it('fails stage on safety block', async () => {
      const mockSafety = {
        canCallClaude: vi.fn().mockReturnValue({ allowed: false, reasons: ['Rate limit'] }),
      } as any;

      await processPipeline(
        makeEvent(),
        makeClassification({ routing: 'reflexive_reply' }),
        makeDeps({ safety: mockSafety })
      );

      expect(mockFailStage).toHaveBeenCalledWith('test-run-id', 'safety_check', expect.stringContaining('Blocked by safety'));
      expect(mockCompleteRun).toHaveBeenCalledWith('test-run-id', 'failure', expect.objectContaining({ error: expect.stringContaining('Blocked by safety') }));
    });
  });

  describe('recovery context injection', () => {
    it('injects recoveryInfo into agent context when redeliveryCount > 1', async () => {
      mockInvokeAgent.mockResolvedValue({ intent: null, jobId: null });

      await processPipeline(
        makeEvent({ timestamp: '2026-02-28T12:00:00.000Z' }),
        makeClassification({ routing: 'reflexive_reply' }),
        makeDeps(),
        { redeliveryCount: 2 }
      );

      expect(mockInvokeAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          recoveryInfo: {
            recoveryCount: 1,
            originalStartedAt: '2026-02-28T12:00:00.000Z',
          },
        })
      );
    });

    it('does not inject recoveryInfo when redeliveryCount is 1', async () => {
      mockInvokeAgent.mockResolvedValue({ intent: null, jobId: null });

      await processPipeline(
        makeEvent(),
        makeClassification({ routing: 'reflexive_reply' }),
        makeDeps(),
        { redeliveryCount: 1 }
      );

      expect(mockInvokeAgent).toHaveBeenCalledWith(
        expect.objectContaining({ recoveryInfo: undefined })
      );
    });

    it('does not inject recoveryInfo when opts is absent', async () => {
      mockInvokeAgent.mockResolvedValue({ intent: null, jobId: null });

      await processPipeline(
        makeEvent(),
        makeClassification({ routing: 'reflexive_reply' }),
        makeDeps()
      );

      expect(mockInvokeAgent).toHaveBeenCalledWith(
        expect.objectContaining({ recoveryInfo: undefined })
      );
    });
  });

  describe('graphiti memory retrieval', () => {
    it('passes graphitiMemory to invokeAgent when facts are found', async () => {
      const facts = [
        { uuid: 'f1', fact: 'Chris prefers concise answers', score: 0.9 },
        { uuid: 'f2', fact: 'Jane is building the brain server', score: 0.8 },
      ];
      mockSearchMemory.mockResolvedValueOnce(facts);
      mockInvokeAgent.mockResolvedValue({ intent: null, jobId: null });

      await processPipeline(
        makeEvent(),
        makeClassification({ routing: 'reflexive_reply' }),
        makeDeps()
      );

      expect(mockInvokeAgent).toHaveBeenCalledWith(
        expect.objectContaining({ graphitiMemory: facts })
      );
    });

    it('passes empty graphitiMemory when search returns nothing', async () => {
      mockSearchMemory.mockResolvedValueOnce([]);
      mockInvokeAgent.mockResolvedValue({ intent: null, jobId: null });

      await processPipeline(
        makeEvent(),
        makeClassification({ routing: 'reflexive_reply' }),
        makeDeps()
      );

      expect(mockInvokeAgent).toHaveBeenCalledWith(
        expect.objectContaining({ graphitiMemory: [] })
      );
    });

    it('passes empty graphitiMemory when search fails', async () => {
      mockSearchMemory.mockRejectedValueOnce(new Error('graphiti unavailable'));
      mockInvokeAgent.mockResolvedValue({ intent: null, jobId: null });

      await processPipeline(
        makeEvent(),
        makeClassification({ routing: 'reflexive_reply' }),
        makeDeps()
      );

      expect(mockInvokeAgent).toHaveBeenCalledWith(
        expect.objectContaining({ graphitiMemory: [] })
      );
    });
  });

  describe('think and escalate routing', () => {
    it('handles think routing same as reply', async () => {
      mockInvokeAgent.mockResolvedValue({ intent: null, jobId: null });

      const result = await processPipeline(
        makeEvent(),
        makeClassification({ routing: 'deliberate_thought' }),
        makeDeps()
      );

      expect(result.action).toBe('think');
      expect(mockInvokeAgent).toHaveBeenCalledOnce();
    });

    it('handles escalate routing same as reply', async () => {
      mockInvokeAgent.mockResolvedValue({ intent: null, jobId: null });

      const result = await processPipeline(
        makeEvent(),
        makeClassification({ routing: 'escalate' }),
        makeDeps()
      );

      expect(result.action).toBe('escalate');
      expect(mockInvokeAgent).toHaveBeenCalledOnce();
    });
  });

  describe('task dispatch', () => {
    it('dispatches via nc.publish when agent intent includes a task', async () => {
      const ncPublish = vi.fn();
      const mockNats = {
        isConnected: () => true,
        publish: vi.fn().mockResolvedValue(undefined),
        nc: { publish: ncPublish },
      } as any;

      mockInvokeAgent.mockResolvedValue({
        intent: {
          type: 'reply',
          content: 'On it.',
          tone: 'casual',
          task: { description: 'Fix the login bug in auth.ts', type: 'task' },
        },
        jobId: null,
      });
      mockCompose.mockResolvedValue('On it.');

      await processPipeline(
        makeEvent(),
        makeClassification({ routing: 'reflexive_reply' }),
        makeDeps({ nats: mockNats })
      );

      expect(ncPublish).toHaveBeenCalledOnce();
      const [subject, encoded] = ncPublish.mock.calls[0];
      expect(subject).toBe('agent.jobs.request');
      const payload = JSON.parse(new TextDecoder().decode(encoded));
      expect(payload.prompt).toBe('Fix the login bug in auth.ts');
      expect(payload.type).toBe('task');
      // Fast-path should NOT call the extractor
      expect(mockExtractAndDispatchTask).not.toHaveBeenCalled();
    });

    it('calls extractAndDispatchTask when agent intent has no task field', async () => {
      const mockNats = {
        isConnected: () => true,
        publish: vi.fn().mockResolvedValue(undefined),
        nc: { publish: vi.fn() },
      } as any;

      mockInvokeAgent.mockResolvedValue({
        intent: { type: 'reply', content: 'Sure, I can help with that.', tone: 'casual' },
        jobId: null,
      });
      mockCompose.mockResolvedValue('Sure, I can help with that.');

      await processPipeline(
        makeEvent({ content: 'Can you fix the bug?' }),
        makeClassification({ routing: 'reflexive_reply' }),
        makeDeps({ nats: mockNats })
      );

      expect(mockExtractAndDispatchTask).toHaveBeenCalledOnce();
      expect(mockExtractAndDispatchTask).toHaveBeenCalledWith(
        expect.objectContaining({
          composedMessage: 'Sure, I can help with that.',
          inboundMessage: 'Can you fix the bug?',
          senderName: 'Chris',
        }),
        mockNats
      );
    });

    it('does not call extractAndDispatchTask when NATS is not connected', async () => {
      mockInvokeAgent.mockResolvedValue({
        intent: { type: 'reply', content: 'Hello!', tone: 'casual' },
        jobId: null,
      });
      mockCompose.mockResolvedValue('Hello!');

      await processPipeline(
        makeEvent(),
        makeClassification({ routing: 'reflexive_reply' }),
        makeDeps({ nats: null })
      );

      expect(mockExtractAndDispatchTask).not.toHaveBeenCalled();
    });
  });
});
