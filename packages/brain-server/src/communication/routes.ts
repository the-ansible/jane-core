/**
 * Communication HTTP API routes.
 * Mounted under /api/communication/ in the brain server.
 */

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { uuidv7, COMMUNICATION_EVENT_VERSION } from '@the-ansible/life-system-shared';
import type { CommunicationEvent } from '@the-ansible/life-system-shared';
import type { NatsConnection } from 'nats';
import { StringCodec } from 'nats';
import { getCommMetrics } from './metrics.js';
import { getTimeline } from './event-timeline.js';
import { getRecentEvents, onEvent, pushEvent } from './events.js';
import { recordTimelineEvent } from './event-timeline.js';
import {
  listSessions, getMessageCount, getSession, getContextMessages, appendMessage, getDiskMessageCount,
} from './sessions/store.js';
import { getActivePlan, listPlans, createPlan, setActivePlan } from './context/plans.js';
import { db as contextDb } from './context/db.js';
import type { ContextPlanConfig } from './context/types.js';
import { getPipelineStats } from './pipeline-stats.js';
import { getQueueStatus } from './outbound.js';
import { compose } from './composer.js';
import {
  getActiveRuns, getRecentRuns, getRun, onRunUpdate, cleanupOrphanedRuns,
} from './pipeline-runs.js';
import { getCommSafetyGate } from './index.js';

const sc = StringCodec();

export interface CommRouteDeps {
  nats: NatsConnection | null;
}

export function createCommRoutes(deps: CommRouteDeps): Hono {
  const app = new Hono();
  const safety = () => getCommSafetyGate();

  // --- Health / Metrics ---

  app.get('/metrics', (c) => {
    const sessionIds = listSessions();
    return c.json({
      ...getCommMetrics(),
      safety: safety()?.status() ?? null,
      pipeline: getPipelineStats(),
      outboundQueue: getQueueStatus(),
      sessions: {
        active: sessionIds.length,
        totalMessages: sessionIds.reduce((sum, id) => sum + getMessageCount(id), 0),
      },
      pipelineRuns: {
        active: getActiveRuns(),
        activeCount: getActiveRuns().length,
      },
      timeline: getTimeline(),
    });
  });

  app.get('/timeline', (c) => {
    return c.json({ timeline: getTimeline() });
  });

  // --- Events ---

  app.get('/events/recent', (c) => {
    const limit = parseInt(c.req.query('limit') || '20', 10);
    const events = getRecentEvents(limit);
    return c.json({ events, count: events.length });
  });

  // --- Outbound send (raw, no composer) ---

  app.post('/send', async (c) => {
    if (!deps.nats) {
      return c.json({ error: 'NATS not connected' }, 503);
    }

    const body = await c.req.json<{
      message: string;
      channelType?: string;
      sessionId?: string;
      parentId?: string;
      sender?: { id: string; displayName?: string; type?: string };
    }>();

    if (!body.message) {
      return c.json({ error: 'message is required' }, 400);
    }

    const gate = safety();
    if (gate) {
      const check = gate.canSend();
      if (!check.allowed) {
        return c.json({ error: 'Blocked by safety gate', reasons: check.reasons }, 429);
      }
    }

    const sender = {
      id: body.sender?.id ?? 'jane',
      displayName: body.sender?.displayName ?? 'Jane',
      type: (body.sender?.type ?? 'agent') as 'person' | 'system' | 'agent' | 'channel' | 'group',
    };

    const event = {
      v: COMMUNICATION_EVENT_VERSION,
      id: uuidv7(),
      sessionId: body.sessionId || uuidv7(),
      channelType: body.channelType || 'realtime',
      direction: 'outbound' as const,
      contentType: 'markdown' as const,
      content: body.message,
      sender,
      metadata: {},
      timestamp: new Date().toISOString(),
      ...(body.parentId ? { parentId: body.parentId } : {}),
    };

    const subject = `communication.outbound.${event.channelType}`;
    deps.nats.publish(subject, sc.encode(JSON.stringify(event)));

    gate?.recordSend();
    pushEvent(event as any, subject);
    recordTimelineEvent({ channelType: event.channelType, direction: 'outbound' });

    return c.json({ sent: true, eventId: event.id, subject });
  });

  // --- Compose and send (through voice composer) ---

  app.post('/compose-and-send', async (c) => {
    if (!deps.nats) {
      return c.json({ error: 'NATS not connected' }, 503);
    }

    const body = await c.req.json<{
      message: string;
      tone?: 'casual' | 'professional' | 'urgent' | 'playful';
      channelType?: string;
      sessionId?: string;
      sender?: { id: string; displayName?: string; type?: string };
    }>();

    if (!body.message) {
      return c.json({ error: 'message is required' }, 400);
    }

    const gate = safety();
    if (gate) {
      const check = gate.canCallLlm(body.channelType || 'realtime');
      if (!check.allowed) {
        return c.json({ error: 'Blocked by safety gate', reasons: check.reasons }, 429);
      }
    }

    const sessionId = body.sessionId || 'scheduled-jobs';

    gate?.recordLlmCall(body.channelType || 'realtime');
    const composed = await compose({
      intent: {
        type: 'reply',
        content: body.message,
        tone: body.tone || 'casual',
      },
    });

    const finalMessage = composed || body.message;

    if (gate) {
      const sendCheck = gate.canSend();
      if (!sendCheck.allowed) {
        return c.json({ error: 'Blocked by safety gate', reasons: sendCheck.reasons }, 429);
      }
    }

    const sender = {
      id: body.sender?.id ?? 'jane',
      displayName: body.sender?.displayName ?? 'Jane',
      type: (body.sender?.type ?? 'agent') as 'person' | 'system' | 'agent' | 'channel' | 'group',
    };

    const event = {
      v: COMMUNICATION_EVENT_VERSION,
      id: uuidv7(),
      sessionId,
      channelType: body.channelType || 'realtime',
      direction: 'outbound' as const,
      contentType: 'markdown' as const,
      content: finalMessage,
      sender,
      metadata: { composedFrom: 'api' },
      timestamp: new Date().toISOString(),
    };

    const subject = `communication.outbound.${event.channelType}`;
    deps.nats.publish(subject, sc.encode(JSON.stringify(event)));
    gate?.recordSend();
    pushEvent(event as any, subject);
    recordTimelineEvent({ channelType: event.channelType, direction: 'outbound' });

    appendMessage(sessionId, {
      role: 'assistant',
      content: finalMessage,
      timestamp: event.timestamp,
      eventId: event.id,
      sender,
    });

    return c.json({ sent: true, eventId: event.id, subject, composed: composed !== null });
  });

  // --- Interactive capture ---

  app.post('/interactive/capture', async (c) => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    const hookEvent = body.hook_event_name as string | undefined;
    const sessionId = (body.session_id as string) || 'interactive-unknown';
    const interactiveSessionId = `interactive-${sessionId}`;

    if (hookEvent === 'UserPromptSubmit') {
      const prompt = (body.prompt ?? body.user_prompt) as string;
      if (!prompt) return c.json({ skipped: true, reason: 'empty prompt' });

      const now = new Date().toISOString();
      appendMessage(interactiveSessionId, {
        role: 'user',
        content: prompt,
        timestamp: now,
        sender: { id: 'chris', displayName: 'Chris', type: 'person' },
      });

      if (deps.nats) {
        try {
          const event = {
            v: COMMUNICATION_EVENT_VERSION,
            id: uuidv7(),
            sessionId: interactiveSessionId,
            channelType: 'interactive',
            direction: 'inbound' as const,
            contentType: 'markdown' as const,
            content: prompt,
            sender: { id: 'chris', displayName: 'Chris', type: 'person' as const },
            recipients: [{ id: 'jane', displayName: 'Jane', type: 'agent' as const }],
            metadata: { source: 'claude-code', hookEvent },
            timestamp: now,
          };
          deps.nats.publish(
            'communication.interactive.inbound',
            sc.encode(JSON.stringify(event))
          );
        } catch (err) { log('warn', 'Failed to publish interactive event to NATS', { error: String(err) }); }
      }

      return c.json({ captured: true, direction: 'inbound', sessionId: interactiveSessionId });
    }

    if (hookEvent === 'Stop') {
      const assistantMessage = body.last_assistant_message as string;
      if (!assistantMessage) return c.json({ skipped: true, reason: 'empty response' });
      if (body.stop_hook_active) return c.json({ skipped: true, reason: 'stop_hook_active' });

      const now = new Date().toISOString();
      appendMessage(interactiveSessionId, {
        role: 'assistant',
        content: assistantMessage,
        timestamp: now,
        sender: { id: 'jane', displayName: 'Jane', type: 'agent' },
      });

      if (deps.nats) {
        try {
          const event = {
            v: COMMUNICATION_EVENT_VERSION,
            id: uuidv7(),
            sessionId: interactiveSessionId,
            channelType: 'interactive',
            direction: 'outbound' as const,
            contentType: 'markdown' as const,
            content: assistantMessage,
            sender: { id: 'jane', displayName: 'Jane', type: 'agent' as const },
            recipients: [{ id: 'chris', displayName: 'Chris', type: 'person' as const }],
            metadata: { source: 'claude-code', hookEvent },
            timestamp: now,
          };
          deps.nats.publish(
            'communication.interactive.outbound',
            sc.encode(JSON.stringify(event))
          );
        } catch (err) { log('warn', 'Failed to publish interactive event to NATS', { error: String(err) }); }
      }

      return c.json({ captured: true, direction: 'outbound', sessionId: interactiveSessionId });
    }

    return c.json({ skipped: true, reason: `unhandled hook event: ${hookEvent}` });
  });

  // --- Test inbound ---

  app.post('/test/inbound', async (c) => {
    if (!deps.nats) {
      return c.json({ error: 'NATS not connected' }, 503);
    }

    const body = await c.req.json<{
      message?: string;
      channelType?: string;
      sessionId?: string;
      senderName?: string;
      hints?: { category?: string; urgency?: string; routing?: string };
    }>();

    const event = {
      v: COMMUNICATION_EVENT_VERSION,
      id: uuidv7(),
      sessionId: body.sessionId || uuidv7(),
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
      ...(body.hints ? { hints: body.hints } : {}),
      metadata: { loopback: true },
      timestamp: new Date().toISOString(),
    };

    const subject = `communication.inbound.${event.channelType}`;
    deps.nats.publish(subject, sc.encode(JSON.stringify(event)));

    return c.json({ published: true, eventId: event.id, subject });
  });

  // --- Sessions ---

  app.get('/sessions', (c) => {
    const sessionIds = listSessions();
    const sessions = sessionIds.map(id => {
      const session = getSession(id);
      return {
        sessionId: id,
        messageCount: session.messages.length,
        diskMessageCount: getDiskMessageCount(id),
        lastActivity: session.messages.length > 0
          ? session.messages[session.messages.length - 1].timestamp
          : null,
      };
    });
    return c.json({ sessions });
  });

  app.get('/sessions/:id', (c) => {
    const session = getSession(c.req.param('id'));
    const limit = parseInt(c.req.query('limit') || '50', 10);
    const messages = session.messages.slice(-limit);
    return c.json({
      sessionId: c.req.param('id'),
      messageCount: session.messages.length,
      diskMessageCount: getDiskMessageCount(c.req.param('id')),
      messages,
    });
  });

  // --- Context plans ---

  app.get('/context/plan', async (c) => {
    try {
      const plan = await getActivePlan();
      return c.json(plan);
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  app.get('/context/plans', async (c) => {
    const plans = await listPlans();
    return c.json({ plans });
  });

  app.post('/context/plans', async (c) => {
    const body = await c.req.json<{ name: string; config: ContextPlanConfig; description?: string }>();
    if (!body.name || !body.config) return c.json({ error: 'name and config required' }, 400);
    await createPlan(body.name, body.config, body.description);
    return c.json({ created: true, name: body.name });
  });

  app.get('/context/sessions/:id/summaries', async (c) => {
    const sessionId = c.req.param('id');
    const { rows } = await contextDb.query(
      'SELECT * FROM brain.comm_summaries WHERE session_id = $1 ORDER BY msg_end_idx DESC',
      [sessionId]
    );
    return c.json({ sessionId, summaries: rows, count: rows.length });
  });

  app.get('/context/sessions/:id/assembly', async (c) => {
    const sessionId = c.req.param('id');
    const { rows } = await contextDb.query(
      'SELECT * FROM brain.comm_assembly_log WHERE session_id = $1 ORDER BY assembled_at DESC LIMIT 20',
      [sessionId]
    );
    return c.json({ sessionId, assemblies: rows, count: rows.length });
  });

  app.get('/context/metrics', async (c) => {
    const { rows: summaryStats } = await contextDb.query<{ count: string; avg_latency: string }>(
      'SELECT count(*) as count, avg(latency_ms) as avg_latency FROM brain.comm_summaries'
    );
    const { rows: assemblyStats } = await contextDb.query<{
      count: string;
      avg_assembly_ms: string;
      avg_tokens: string;
      success_rate: string;
    }>(
      `SELECT count(*) as count,
              avg(assembly_ms) as avg_assembly_ms,
              avg(estimated_tokens) as avg_tokens,
              avg(CASE WHEN pipeline_succeeded THEN 1 ELSE 0 END) as success_rate
       FROM brain.comm_assembly_log`
    );
    return c.json({
      summaries: {
        total: parseInt(summaryStats[0]?.count || '0'),
        avgLatencyMs: Math.round(parseFloat(summaryStats[0]?.avg_latency || '0')),
      },
      assemblies: {
        total: parseInt(assemblyStats[0]?.count || '0'),
        avgAssemblyMs: Math.round(parseFloat(assemblyStats[0]?.avg_assembly_ms || '0')),
        avgTokens: Math.round(parseFloat(assemblyStats[0]?.avg_tokens || '0')),
        successRate: parseFloat(assemblyStats[0]?.success_rate || '0'),
      },
    });
  });

  // --- Pipeline runs ---

  app.get('/pipeline', (c) => {
    return c.json({
      stats: getPipelineStats(),
      outboundQueue: getQueueStatus(),
    });
  });

  app.get('/pipeline/runs', (c) => {
    const limit = parseInt(c.req.query('limit') || '20', 10);
    return c.json({
      active: getActiveRuns(),
      recent: getRecentRuns(limit),
    });
  });

  app.get('/pipeline/runs/:id', (c) => {
    const run = getRun(c.req.param('id'));
    if (!run) return c.json({ error: 'Not found' }, 404);
    return c.json({ run });
  });

  // --- Safety / admin ---

  app.post('/pause', (c) => {
    const gate = safety();
    if (gate) {
      gate.pause();
      return c.json({ paused: true });
    }
    return c.json({ error: 'Safety gate not initialized' }, 500);
  });

  app.post('/resume', (c) => {
    const gate = safety();
    if (gate) {
      gate.resume();
      return c.json({ resumed: true });
    }
    return c.json({ error: 'Safety gate not initialized' }, 500);
  });

  app.get('/safety', (c) => {
    const gate = safety();
    return c.json({
      safety: gate?.status() ?? null,
    });
  });

  // --- SSE stream ---

  app.get('/events/stream', (c) => {
    return streamSSE(c, async (stream) => {
      let id = 0;

      // Send recent events as initial batch
      const recent = getRecentEvents(10);
      for (const ev of recent) {
        await stream.writeSSE({ data: JSON.stringify(ev), event: 'event', id: String(id++) });
      }

      // Listen for new events
      const unsubEvent = onEvent((ev) => {
        stream.writeSSE({ data: JSON.stringify(ev), event: 'event', id: String(id++) }).catch((err) => log('debug', 'SSE event write failed (client likely disconnected)', { error: String(err) }));
      });

      const unsubRun = onRunUpdate((run) => {
        stream.writeSSE({ data: JSON.stringify(run), event: 'pipeline-run', id: String(id++) }).catch((err) => log('debug', 'SSE pipeline-run write failed', { error: String(err) }));
      });

      // Keep alive
      const keepAlive = setInterval(() => {
        stream.writeSSE({ data: '', event: 'ping', id: String(id++) }).catch((err) => log('debug', 'SSE ping write failed', { error: String(err) }));
      }, 15000);

      // Cleanup orphaned runs periodically
      const orphanInterval = setInterval(() => {
        cleanupOrphanedRuns();
      }, 60000);

      stream.onAbort(() => {
        unsubEvent();
        unsubRun();
        clearInterval(keepAlive);
        clearInterval(orphanInterval);
      });

      // Hold the connection open
      await new Promise(() => {});
    });
  });

  return app;
}
