import { Hono } from 'hono';
import { uuidv7 } from '@the-ansible/life-system-shared';
import { getMetrics } from './metrics.js';
import { getRecentEvents } from './events.js';
import { getClassifierMetrics } from './classifier/index.js';
import { listSessions, getMessageCount, getSession, getContextMessages } from './sessions/store.js';
import { getPipelineStats } from './pipeline-stats.js';
import type { NatsClient } from './nats/client.js';
import type { SafetyGate } from './safety/index.js';
import { getQueueStatus } from './outbound-queue.js';

export interface ServerDeps {
  nats: NatsClient | null;
  safety: SafetyGate | null;
}

export function createApp(deps: ServerDeps): Hono {
  const app = new Hono();

  app.get('/health', (c) => {
    const natsConnected = deps.nats?.isConnected() ?? false;
    const status = natsConnected ? 'ok' : 'degraded';
    return c.json({
      status,
      service: 'stimulation-server',
      nats: { connected: natsConnected },
      timestamp: new Date().toISOString(),
    });
  });

  app.get('/metrics', (c) => {
    const sessionIds = listSessions();
    return c.json({
      ...getMetrics(),
      safety: deps.safety?.status() ?? null,
      classification: getClassifierMetrics(),
      pipeline: getPipelineStats(),
      outboundQueue: getQueueStatus(),
      sessions: {
        active: sessionIds.length,
        totalMessages: sessionIds.reduce((sum, id) => sum + getMessageCount(id), 0),
      },
    });
  });

  // --- Admin/Debug endpoints ---

  app.get('/api/events/recent', (c) => {
    const limit = parseInt(c.req.query('limit') || '20', 10);
    const events = getRecentEvents(limit);
    return c.json({ events, count: events.length });
  });

  app.post('/api/send', async (c) => {
    if (!deps.nats?.isConnected()) {
      return c.json({ error: 'NATS not connected' }, 503);
    }

    const body = await c.req.json<{
      message: string;
      channelType?: string;
      sessionId?: string;
      parentId?: string;
    }>();

    if (!body.message) {
      return c.json({ error: 'message is required' }, 400);
    }

    // Safety check before sending
    if (deps.safety) {
      const check = deps.safety.canSend();
      if (!check.allowed) {
        return c.json({ error: 'Blocked by safety gate', reasons: check.reasons }, 429);
      }
    }

    const event = {
      id: uuidv7(),
      sessionId: body.sessionId || 'stimulation-server-admin',
      channelType: body.channelType || 'message',
      direction: 'outbound' as const,
      contentType: 'markdown' as const,
      content: body.message,
      metadata: {},
      timestamp: new Date().toISOString(),
      ...(body.parentId ? { parentId: body.parentId } : {}),
    };

    const subject = `communication.outbound.${event.channelType}`;

    await deps.nats.publish(subject, event);

    // Record the send for rate limiting and flood detection
    deps.safety?.recordSend();

    console.log(JSON.stringify({
      level: 'info',
      msg: 'Outbound message sent',
      eventId: event.id,
      subject,
      ts: new Date().toISOString(),
    }));

    return c.json({
      sent: true,
      eventId: event.id,
      subject,
    });
  });

  app.post('/api/test/inbound', async (c) => {
    if (!deps.nats?.isConnected()) {
      return c.json({ error: 'NATS not connected' }, 503);
    }

    const body = await c.req.json<{
      message?: string;
      channelType?: string;
      sessionId?: string;
      senderName?: string;
    }>();

    const event = {
      id: uuidv7(),
      sessionId: body.sessionId || 'loopback-test',
      channelType: body.channelType || 'realtime',
      direction: 'inbound' as const,
      contentType: 'markdown' as const,
      content: body.message || 'Test inbound message from admin API',
      sender: {
        id: 'admin',
        displayName: body.senderName || 'Admin',
        type: 'person' as const,
      },
      recipients: [{
        id: 'jane',
        displayName: 'Jane',
        type: 'agent' as const,
      }],
      metadata: { loopback: true },
      timestamp: new Date().toISOString(),
    };

    const subject = `communication.inbound.${event.channelType}`;
    await deps.nats.publish(subject, event);

    console.log(JSON.stringify({
      level: 'info',
      msg: 'Loopback test message published',
      eventId: event.id,
      subject,
      ts: new Date().toISOString(),
    }));

    return c.json({
      published: true,
      eventId: event.id,
      subject,
      note: 'Check GET /api/events/recent to see it arrive',
    });
  });

  // --- Session inspection endpoints ---

  app.get('/api/sessions', (c) => {
    const sessionIds = listSessions();
    const sessions = sessionIds.map(id => {
      const session = getSession(id);
      return {
        sessionId: id,
        messageCount: session.messages.length,
        createdAt: session.createdAt,
        lastActivityAt: session.lastActivityAt,
      };
    });
    return c.json({ sessions, count: sessions.length });
  });

  app.get('/api/sessions/:id', (c) => {
    const sessionId = c.req.param('id');
    const limit = parseInt(c.req.query('limit') || '50', 10);
    const session = getSession(sessionId);
    const messages = getContextMessages(sessionId, limit);

    return c.json({
      sessionId: session.sessionId,
      messageCount: session.messages.length,
      createdAt: session.createdAt,
      lastActivityAt: session.lastActivityAt,
      metadata: session.metadata,
      messages,
    });
  });

  // --- Pipeline stats endpoint ---

  app.get('/api/pipeline', (c) => {
    return c.json(getPipelineStats());
  });

  // --- Safety control endpoints ---

  app.post('/api/pause', (c) => {
    if (!deps.safety) {
      return c.json({ error: 'Safety gate not initialized' }, 503);
    }
    deps.safety.pause();
    return c.json({ paused: true });
  });

  app.post('/api/resume', (c) => {
    if (!deps.safety) {
      return c.json({ error: 'Safety gate not initialized' }, 503);
    }
    deps.safety.resume();
    return c.json({ paused: false });
  });

  app.get('/api/safety', (c) => {
    if (!deps.safety) {
      return c.json({ error: 'Safety gate not initialized' }, 503);
    }
    return c.json(deps.safety.status());
  });

  return app;
}
