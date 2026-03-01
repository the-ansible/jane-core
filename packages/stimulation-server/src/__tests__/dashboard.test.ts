import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.SESSIONS_DIR = mkdtempSync(join(tmpdir(), 'dashboard-test-'));

import { createApp, type ServerDeps } from '../server.js';
import { resetMetrics } from '../metrics.js';
import { pushEvent, clearEvents, onEvent } from '../events.js';
import { clearAllSessions } from '../sessions/store.js';
import { resetPipelineStats } from '../pipeline-stats.js';
import type { NatsClient } from '../nats/client.js';

function makeMockNats(connected: boolean): NatsClient {
  return {
    nc: {} as any,
    js: {} as any,
    isConnected: () => connected,
    close: async () => {},
    publish: vi.fn(async () => {}),
  };
}

function makeDeps(connected = false): ServerDeps {
  return { nats: connected ? makeMockNats(true) : null, safety: null };
}

describe('Dashboard route', () => {
  beforeEach(() => {
    resetMetrics();
    clearEvents();
    clearAllSessions();
    resetPipelineStats();
  });

  it('GET /dashboard returns 200 with HTML content type', async () => {
    const app = createApp(makeDeps());
    const res = await app.request('/dashboard');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  it('dashboard HTML contains expected panel elements', async () => {
    const app = createApp(makeDeps());
    const res = await app.request('/dashboard');
    const html = await res.text();
    expect(html).toContain('Stimulation Server');
    expect(html).toContain('Pipeline Counters');
    expect(html).toContain('Pipeline Performance');
    expect(html).toContain('Classification');
    expect(html).toContain('Safety Gate');
    expect(html).toContain('Live Events');
    expect(html).toContain('Active Sessions');
    expect(html).toContain('Outbound Queue');
  });

  it('dashboard HTML uses dynamic base path for all API calls', async () => {
    const app = createApp(makeDeps());
    const res = await app.request('/dashboard');
    const html = await res.text();
    // Should use api() helper for all fetch/SSE calls
    expect(html).toContain("api('/api/events/stream')");
    expect(html).toContain("api('/metrics')");
    expect(html).toContain("api('/api/events/recent");
    expect(html).toContain("api('/health')");
    expect(html).toContain("api('/api/sessions')");
    // Should NOT contain localhost or hardcoded hosts
    expect(html).not.toContain('localhost:3102');
    expect(html).not.toContain('http://');
    expect(html).not.toContain('https://');
  });

  it('GET / redirects to /dashboard', async () => {
    const app = createApp(makeDeps());
    const res = await app.request('/', { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/dashboard');
  });

  it('GET /apps/stim/dashboard returns 200 with HTML (gateway prefix)', async () => {
    const app = createApp(makeDeps());
    const res = await app.request('/apps/stim/dashboard');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  it('GET /apps/stim/metrics returns 200 with JSON (gateway prefix)', async () => {
    const app = createApp(makeDeps());
    const res = await app.request('/apps/stim/metrics');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.received).toBeDefined();
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('GET /apps/stim/health returns 200 (gateway prefix)', async () => {
    const app = createApp(makeDeps());
    const res = await app.request('/apps/stim/health');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.service).toBe('stimulation-server');
  });
});

describe('SSE endpoint', () => {
  beforeEach(() => {
    resetMetrics();
    clearEvents();
    clearAllSessions();
    resetPipelineStats();
  });

  it('GET /api/events/stream returns text/event-stream content type', async () => {
    const app = createApp(makeDeps());
    const res = await app.request('/api/events/stream');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
  });
});

describe('Events pub/sub', () => {
  beforeEach(() => clearEvents());

  it('onEvent notifies listeners when events are pushed', () => {
    const received: any[] = [];
    const unsub = onEvent((stored) => received.push(stored));

    pushEvent({
      id: '019502e4-1234-7000-8000-000000000099',
      sessionId: 'test',
      channelType: 'message',
      direction: 'inbound',
      contentType: 'markdown',
      content: 'hello from pub/sub',
      metadata: {},
      timestamp: '2026-03-01T00:00:00.000Z',
    }, 'communication.inbound.message');

    expect(received.length).toBe(1);
    expect(received[0].event.content).toBe('hello from pub/sub');
    expect(received[0].subject).toBe('communication.inbound.message');
    unsub();
  });

  it('unsubscribe stops notifications', () => {
    const received: any[] = [];
    const unsub = onEvent((stored) => received.push(stored));
    unsub();

    pushEvent({
      id: '019502e4-1234-7000-8000-000000000098',
      sessionId: 'test',
      channelType: 'message',
      direction: 'inbound',
      contentType: 'markdown',
      content: 'should not arrive',
      metadata: {},
      timestamp: '2026-03-01T00:00:00.000Z',
    }, 'communication.inbound.message');

    expect(received.length).toBe(0);
  });

  it('listener errors do not break other listeners', () => {
    const received: any[] = [];
    onEvent(() => { throw new Error('boom'); });
    const unsub2 = onEvent((stored) => received.push(stored));

    pushEvent({
      id: '019502e4-1234-7000-8000-000000000097',
      sessionId: 'test',
      channelType: 'message',
      direction: 'inbound',
      contentType: 'markdown',
      content: 'survives error',
      metadata: {},
      timestamp: '2026-03-01T00:00:00.000Z',
    }, 'communication.inbound.message');

    expect(received.length).toBe(1);
    expect(received[0].event.content).toBe('survives error');
    unsub2();
  });
});
