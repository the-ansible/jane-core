import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.SESSIONS_DIR = mkdtempSync(join(tmpdir(), 'server-test-'));

// Mock the composer to avoid spawning Claude CLI in tests
vi.mock('../composer/index.js', () => ({
  compose: vi.fn(),
}));

// Mock context modules (used by compose-and-send endpoint)
vi.mock('../context/assembler.js', () => ({
  assembleContext: vi.fn().mockResolvedValue({
    summaries: [],
    recentMessages: [],
    meta: {
      assemblyLogId: 'test-log', planName: 'baseline_v1', summaryCount: 0,
      rawMessageCount: 0, totalMessageCoverage: 0, estimatedTokens: 0,
      rawTokens: 0, summaryTokens: 0, summaryBudget: 12000,
      budgetUtilization: 0, rawOverBudget: false, assemblyMs: 1,
      summarizationMs: null, newSummariesCreated: 0,
    },
  }),
}));

vi.mock('../context/db.js', () => ({
  db: { query: vi.fn().mockResolvedValue({ rows: [] }), exec: vi.fn() },
  initializeContextDb: vi.fn(),
  updateAssemblyOutcome: vi.fn(),
}));

vi.mock('../context/plans.js', () => ({
  getActivePlan: vi.fn().mockResolvedValue({ name: 'baseline_v1', config: {} }),
  listPlans: vi.fn().mockResolvedValue([]),
  createPlan: vi.fn(),
  setActivePlan: vi.fn(),
}));

vi.mock('../agent/job-registry.js', () => ({
  panicClearJobs: vi.fn(),
}));

import { compose } from '../composer/index.js';
import { createApp, type ServerDeps } from '../server.js';
import { resetMetrics, increment } from '../metrics.js';
import { pushEvent, clearEvents } from '../events.js';
import { appendMessage, clearAllSessions } from '../sessions/store.js';
import { recordPipelineOutcome, resetPipelineStats } from '../pipeline-stats.js';
import { panicClearJobs } from '../agent/job-registry.js';

const mockPanicClearJobs = vi.mocked(panicClearJobs);
import type { NatsClient } from '../nats/client.js';

const mockCompose = vi.mocked(compose);

function makeMockNats(connected: boolean): NatsClient {
  return {
    nc: {} as any,
    js: {} as any,
    isConnected: () => connected,
    close: async () => {},
    publish: vi.fn(async () => {}),
  };
}

describe('Health endpoint', () => {
  beforeEach(() => resetMetrics());

  it('returns ok when NATS is connected', async () => {
    const deps: ServerDeps = { nats: makeMockNats(true), safety: null };
    const app = createApp(deps);
    const res = await app.request('/health');
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.nats.connected).toBe(true);
    expect(body.service).toBe('stimulation-server');
  });

  it('returns degraded when NATS is not connected', async () => {
    const deps: ServerDeps = { nats: makeMockNats(false), safety: null };
    const app = createApp(deps);
    const res = await app.request('/health');
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.status).toBe('degraded');
    expect(body.nats.connected).toBe(false);
  });

  it('returns degraded when NATS is null', async () => {
    const deps: ServerDeps = { nats: null, safety: null };
    const app = createApp(deps);
    const res = await app.request('/health');
    const body = await res.json();
    expect(body.status).toBe('degraded');
    expect(body.nats.connected).toBe(false);
  });
});

describe('Metrics endpoint', () => {
  beforeEach(() => resetMetrics());

  it('returns initial metrics', async () => {
    const deps: ServerDeps = { nats: null, safety: null };
    const app = createApp(deps);
    const res = await app.request('/metrics');
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.received).toBe(0);
    expect(body.validated).toBe(0);
    expect(body.validationErrors).toBe(0);
    expect(body.errors).toBe(0);
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(body.startedAt).toBeTruthy();
  });

  it('reflects updated counters', async () => {
    increment('received');
    increment('received');
    increment('validated');
    increment('validationErrors');

    const deps: ServerDeps = { nats: null, safety: null };
    const app = createApp(deps);
    const res = await app.request('/metrics');
    const body = await res.json();
    expect(body.received).toBe(2);
    expect(body.validated).toBe(1);
    expect(body.validationErrors).toBe(1);
  });
});

describe('GET /api/events/recent', () => {
  beforeEach(() => clearEvents());

  it('returns empty when no events', async () => {
    const deps: ServerDeps = { nats: null, safety: null };
    const app = createApp(deps);
    const res = await app.request('/api/events/recent');
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.events).toEqual([]);
    expect(body.count).toBe(0);
  });

  it('returns pushed events', async () => {
    pushEvent({
      id: '019502e4-1234-7000-8000-000000000001',
      sessionId: 'test',
      channelType: 'message',
      direction: 'inbound',
      contentType: 'markdown',
      content: 'hello',
      metadata: {},
      timestamp: '2026-02-28T12:00:00.000Z',
    }, 'communication.inbound.message');

    const deps: ServerDeps = { nats: null, safety: null };
    const app = createApp(deps);
    const res = await app.request('/api/events/recent');
    const body = await res.json();
    expect(body.count).toBe(1);
    expect(body.events[0].event.content).toBe('hello');
    expect(body.events[0].subject).toBe('communication.inbound.message');
  });

  it('respects limit parameter', async () => {
    for (let i = 0; i < 5; i++) {
      pushEvent({
        id: `019502e4-1234-7000-8000-00000000000${i}`,
        sessionId: 'test',
        channelType: 'message',
        direction: 'inbound',
        contentType: 'markdown',
        content: `msg ${i}`,
        metadata: {},
        timestamp: '2026-02-28T12:00:00.000Z',
      }, 'communication.inbound.message');
    }

    const deps: ServerDeps = { nats: null, safety: null };
    const app = createApp(deps);
    const res = await app.request('/api/events/recent?limit=2');
    const body = await res.json();
    expect(body.count).toBe(2);
    expect(body.events[0].event.content).toBe('msg 3');
    expect(body.events[1].event.content).toBe('msg 4');
  });
});

describe('POST /api/send', () => {
  it('returns 503 when NATS is not connected', async () => {
    const deps: ServerDeps = { nats: null, safety: null };
    const app = createApp(deps);
    const res = await app.request('/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'test' }),
    });
    expect(res.status).toBe(503);
  });

  it('returns 400 when message is missing', async () => {
    const deps: ServerDeps = { nats: makeMockNats(true), safety: null };
    const app = createApp(deps);
    const res = await app.request('/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('publishes to NATS and returns event ID', async () => {
    const mockNats = makeMockNats(true);
    const deps: ServerDeps = { nats: mockNats, safety: null };
    const app = createApp(deps);

    const res = await app.request('/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Hello Chris!' }),
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.sent).toBe(true);
    expect(body.eventId).toBeTruthy();
    expect(body.subject).toBe('communication.outbound.realtime');
    expect(mockNats.publish).toHaveBeenCalledOnce();
  });
});

describe('POST /api/test/inbound', () => {
  it('returns 503 when NATS is not connected', async () => {
    const deps: ServerDeps = { nats: null, safety: null };
    const app = createApp(deps);
    const res = await app.request('/api/test/inbound', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(503);
  });

  it('publishes loopback test message', async () => {
    const mockNats = makeMockNats(true);
    const deps: ServerDeps = { nats: mockNats, safety: null };
    const app = createApp(deps);
    const res = await app.request('/api/test/inbound', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'loopback test' }),
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.published).toBe(true);
    expect(body.subject).toBe('communication.inbound.realtime');
    expect(mockNats.publish).toHaveBeenCalledOnce();
  });

  it('passes hints through to the published event', async () => {
    const mockNats = makeMockNats(true);
    const deps: ServerDeps = { nats: mockNats, safety: null };
    const app = createApp(deps);
    const res = await app.request('/api/test/inbound', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'Scheduled report',
        hints: { category: 'informational', urgency: 'low', routing: 'log_only' },
      }),
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.published).toBe(true);
    expect(mockNats.publish).toHaveBeenCalledWith(
      'communication.inbound.realtime',
      expect.objectContaining({
        hints: { category: 'informational', urgency: 'low', routing: 'log_only' },
      })
    );
  });
});

describe('Session endpoints', () => {
  beforeEach(() => {
    clearAllSessions();
  });

  it('lists active sessions', async () => {
    appendMessage('sess-a', { role: 'user', content: 'hi', timestamp: new Date().toISOString() });
    appendMessage('sess-b', { role: 'user', content: 'hey', timestamp: new Date().toISOString() });

    const deps: ServerDeps = { nats: null, safety: null };
    const app = createApp(deps);
    const res = await app.request('/api/sessions');
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.count).toBe(2);
    expect(body.sessions.map((s: any) => s.sessionId).sort()).toEqual(['sess-a', 'sess-b']);
  });

  it('returns session details with messages', async () => {
    appendMessage('sess-detail', { role: 'user', content: 'Hello Jane', timestamp: '2026-03-01T00:00:00Z' });
    appendMessage('sess-detail', { role: 'assistant', content: 'Hey!', timestamp: '2026-03-01T00:00:01Z' });

    const deps: ServerDeps = { nats: null, safety: null };
    const app = createApp(deps);
    const res = await app.request('/api/sessions/sess-detail');
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.sessionId).toBe('sess-detail');
    expect(body.messageCount).toBe(2);
    expect(body.messages.length).toBe(2);
    expect(body.messages[0].content).toBe('Hello Jane');
    expect(body.messages[1].content).toBe('Hey!');
  });

  it('respects limit parameter', async () => {
    for (let i = 0; i < 10; i++) {
      appendMessage('sess-limit', { role: 'user', content: `msg ${i}`, timestamp: new Date().toISOString() });
    }

    const deps: ServerDeps = { nats: null, safety: null };
    const app = createApp(deps);
    const res = await app.request('/api/sessions/sess-limit?limit=3');
    const body = await res.json();
    expect(body.messages.length).toBe(3);
    expect(body.messageCount).toBe(10); // total is still 10
  });
});

describe('POST /api/compose-and-send', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearAllSessions();
  });

  it('returns 503 when NATS is not connected', async () => {
    const deps: ServerDeps = { nats: null, safety: null };
    const app = createApp(deps);
    const res = await app.request('/api/compose-and-send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'test' }),
    });
    expect(res.status).toBe(503);
  });

  it('returns 400 when message is missing', async () => {
    const deps: ServerDeps = { nats: makeMockNats(true), safety: null };
    const app = createApp(deps);
    const res = await app.request('/api/compose-and-send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('composes message and publishes to NATS', async () => {
    mockCompose.mockResolvedValue('Voiced version of the message');
    const mockNats = makeMockNats(true);
    const deps: ServerDeps = { nats: mockNats, safety: null };
    const app = createApp(deps);

    const res = await app.request('/api/compose-and-send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Raw report from scheduled job' }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.sent).toBe(true);
    expect(body.composed).toBe(true);
    expect(mockCompose).toHaveBeenCalledOnce();
    expect(mockNats.publish).toHaveBeenCalledWith(
      'communication.outbound.realtime',
      expect.objectContaining({
        content: 'Voiced version of the message',
        sender: expect.objectContaining({ id: 'jane' }),
      })
    );
  });

  it('falls back to raw message when composer returns null', async () => {
    mockCompose.mockResolvedValue(null);
    const mockNats = makeMockNats(true);
    const deps: ServerDeps = { nats: mockNats, safety: null };
    const app = createApp(deps);

    const res = await app.request('/api/compose-and-send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Fallback content' }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.sent).toBe(true);
    expect(body.composed).toBe(false);
    expect(mockNats.publish).toHaveBeenCalledWith(
      'communication.outbound.realtime',
      expect.objectContaining({ content: 'Fallback content' })
    );
  });

  it('records message in session for continuity', async () => {
    mockCompose.mockResolvedValue('Composed');
    const mockNats = makeMockNats(true);
    const deps: ServerDeps = { nats: mockNats, safety: null };
    const app = createApp(deps);

    await app.request('/api/compose-and-send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Test', sessionId: 'job-session' }),
    });

    const { getSession } = await import('../sessions/store.js');
    const session = getSession('job-session');
    expect(session.messages.length).toBe(1);
    expect(session.messages[0].role).toBe('assistant');
    expect(session.messages[0].content).toBe('Composed');
  });
});

describe('Pipeline stats endpoint', () => {
  beforeEach(() => {
    resetPipelineStats();
  });

  it('returns pipeline stats', async () => {
    recordPipelineOutcome({ action: 'reply', responded: true, agentMs: 6000, composerMs: 4000, totalMs: 10000 });
    recordPipelineOutcome({ action: 'log', responded: false, totalMs: 2 });

    const deps: ServerDeps = { nats: null, safety: null };
    const app = createApp(deps);
    const res = await app.request('/api/pipeline');
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.total).toBe(2);
    expect(body.responded).toBe(1);
    expect(body.latency.agent.count).toBe(1);
    expect(body.latency.agent.avg).toBe(6000);
    expect(body.byAction.reply).toEqual({ count: 1, responded: 1 });
    expect(body.byAction.log).toEqual({ count: 1, responded: 0 });
  });

  it('appears in /metrics too', async () => {
    recordPipelineOutcome({ action: 'reply', responded: true, agentMs: 5000, composerMs: 3000, totalMs: 8000 });

    const deps: ServerDeps = { nats: null, safety: null };
    const app = createApp(deps);
    const res = await app.request('/metrics');
    const body = await res.json();
    expect(body.pipeline).toBeDefined();
    expect(body.pipeline.total).toBe(1);
    expect(body.pipeline.latency.agent.avg).toBe(5000);
  });
});

describe('POST /api/panic', () => {
  beforeEach(() => {
    mockPanicClearJobs.mockReset();
  });

  it('clears queued jobs without running by default', async () => {
    mockPanicClearJobs.mockResolvedValue({ clearedQueued: 3, clearedRunning: 0, killedPids: [] });

    const deps: ServerDeps = { nats: null, safety: null };
    const app = createApp(deps);
    const res = await app.request('/api/panic', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.cleared).toBe(true);
    expect(body.clearedQueued).toBe(3);
    expect(body.clearedRunning).toBe(0);
    expect(body.killedPids).toEqual([]);
    expect(mockPanicClearJobs).toHaveBeenCalledWith(false);
  });

  it('kills running jobs when includeRunning is true', async () => {
    mockPanicClearJobs.mockResolvedValue({ clearedQueued: 1, clearedRunning: 2, killedPids: [1234, 5678] });

    const deps: ServerDeps = { nats: null, safety: null };
    const app = createApp(deps);
    const res = await app.request('/api/panic', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ includeRunning: true }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.clearedRunning).toBe(2);
    expect(body.killedPids).toEqual([1234, 5678]);
    expect(mockPanicClearJobs).toHaveBeenCalledWith(true);
  });

  it('works with no request body', async () => {
    mockPanicClearJobs.mockResolvedValue({ clearedQueued: 0, clearedRunning: 0, killedPids: [] });

    const deps: ServerDeps = { nats: null, safety: null };
    const app = createApp(deps);
    const res = await app.request('/api/panic', { method: 'POST' });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.cleared).toBe(true);
    expect(mockPanicClearJobs).toHaveBeenCalledWith(false);
  });

  it('returns 500 when job registry throws', async () => {
    mockPanicClearJobs.mockRejectedValue(new Error('DB connection failed'));

    const deps: ServerDeps = { nats: null, safety: null };
    const app = createApp(deps);
    const res = await app.request('/api/panic', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe('Failed to clear jobs');
    expect(body.detail).toContain('DB connection failed');
  });
});
