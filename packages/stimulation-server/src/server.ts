import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { serveStatic } from '@hono/node-server/serve-static';
import { uuidv7 } from '@the-ansible/life-system-shared';
import { getMetrics } from './metrics.js';
import { getRecentEvents, onEvent, pushEvent } from './events.js';
import { getClassifierMetrics } from './classifier/index.js';
import { listSessions, getMessageCount, getSession, getContextMessages, appendMessage, getDiskMessageCount } from './sessions/store.js';
import { getActivePlan, listPlans, createPlan, setActivePlan } from './context/plans.js';
import { db as contextDb } from './context/db.js';
import type { ContextPlanConfig } from './context/types.js';
import { getPipelineStats } from './pipeline-stats.js';
import type { NatsClient } from './nats/client.js';
import type { SafetyGate } from './safety/index.js';
import { getQueueStatus } from './outbound-queue.js';
import { compose } from './composer/index.js';
import { getActiveRuns, getRecentRuns, getRun, onRunUpdate, cleanupOrphanedRuns } from './pipeline-runs.js';
import { getLastRecovery, onRecovery } from './agent/recovery.js';
import { panicClearJobs } from './agent/job-registry.js';

export interface ServerDeps {
  nats: NatsClient | null;
  safety: SafetyGate | null;
}

const GATEWAY_PREFIX = '/apps/stim';

function buildMetricsSnapshot(deps: ServerDeps) {
  const sessionIds = listSessions();
  return {
    ...getMetrics(),
    safety: deps.safety?.status() ?? null,
    classification: getClassifierMetrics(),
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
  };
}

function registerRoutes(app: Hono, deps: ServerDeps): void {

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
    return c.json(buildMetricsSnapshot(deps));
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
      sessionId: body.sessionId || uuidv7(),
      channelType: body.channelType || 'realtime',
      direction: 'outbound' as const,
      contentType: 'markdown' as const,
      content: body.message,
      sender: { id: 'jane', displayName: 'Jane', type: 'agent' as const },
      metadata: {},
      timestamp: new Date().toISOString(),
      ...(body.parentId ? { parentId: body.parentId } : {}),
    };

    const subject = `communication.outbound.${event.channelType}`;

    await deps.nats.publish(subject, event);

    // Record the send for rate limiting and flood detection
    deps.safety?.recordSend();
    pushEvent(event as any, subject);

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

  app.post('/api/compose-and-send', async (c) => {
    if (!deps.nats?.isConnected()) {
      return c.json({ error: 'NATS not connected' }, 503);
    }

    const body = await c.req.json<{
      message: string;
      tone?: 'casual' | 'professional' | 'urgent' | 'playful';
      channelType?: string;
      sessionId?: string;
    }>();

    if (!body.message) {
      return c.json({ error: 'message is required' }, 400);
    }

    // Safety check
    if (deps.safety) {
      const claudeCheck = deps.safety.canCallClaude(body.channelType || 'realtime');
      if (!claudeCheck.allowed) {
        return c.json({ error: 'Blocked by safety gate', reasons: claudeCheck.reasons }, 429);
      }
    }

    const sessionId = body.sessionId || 'scheduled-jobs';

    // Run through the composer for voice consistency
    deps.safety?.recordLlmCall('claude', body.channelType || 'realtime');
    const composed = await compose({
      intent: {
        type: 'reply',
        content: body.message,
        tone: body.tone || 'casual',
      },
    });

    const finalMessage = composed || body.message;

    // Safety check before sending
    if (deps.safety) {
      const sendCheck = deps.safety.canSend();
      if (!sendCheck.allowed) {
        return c.json({ error: 'Blocked by safety gate', reasons: sendCheck.reasons }, 429);
      }
    }

    const event = {
      id: uuidv7(),
      sessionId,
      channelType: body.channelType || 'realtime',
      direction: 'outbound' as const,
      contentType: 'markdown' as const,
      content: finalMessage,
      sender: {
        id: 'jane',
        displayName: 'Jane',
        type: 'agent' as const,
      },
      metadata: { composedFrom: 'api' },
      timestamp: new Date().toISOString(),
    };

    const subject = `communication.outbound.${event.channelType}`;

    await deps.nats.publish(subject, event);
    deps.safety?.recordSend();
    pushEvent(event as any, subject);

    // Record in session for continuity
    appendMessage(sessionId, {
      role: 'assistant',
      content: finalMessage,
      timestamp: event.timestamp,
      eventId: event.id,
      sender: { id: 'jane', displayName: 'Jane', type: 'agent' },
    });

    console.log(JSON.stringify({
      level: 'info',
      msg: 'Composed and sent outbound message',
      component: 'api',
      eventId: event.id,
      subject,
      composed: composed !== null,
      ts: new Date().toISOString(),
    }));

    return c.json({
      sent: true,
      eventId: event.id,
      subject,
      composed: composed !== null,
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
      hints?: { category?: string; urgency?: string; routing?: string };
    }>();

    const event = {
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

  // --- Nudge endpoint ---
  // Simple webhook to publish an inbound message — use to wake Jane after a restart.
  // POST /api/nudge  (no body required; optional { message, sessionId })

  app.post('/api/nudge', async (c) => {
    if (!deps.nats?.isConnected()) {
      return c.json({ error: 'NATS not connected' }, 503);
    }

    let message = 'nudge';
    let sessionId: string | undefined;

    try {
      const body = await c.req.json<{ message?: string; sessionId?: string }>();
      if (body.message) message = body.message;
      if (body.sessionId) sessionId = body.sessionId;
    } catch {
      // Body is optional — no-op if absent or not JSON
    }

    const event = {
      id: uuidv7(),
      sessionId: sessionId || uuidv7(),
      channelType: 'realtime' as const,
      direction: 'inbound' as const,
      contentType: 'markdown' as const,
      content: message,
      sender: {
        id: 'nudge',
        displayName: 'Nudge',
        type: 'person' as const,
      },
      recipients: [{
        id: 'jane',
        displayName: 'Jane',
        type: 'agent' as const,
      }],
      metadata: { source: 'nudge' },
      timestamp: new Date().toISOString(),
    };

    const subject = `communication.inbound.${event.channelType}`;
    await deps.nats.publish(subject, event);

    console.log(JSON.stringify({
      level: 'info',
      msg: 'Nudge published',
      eventId: event.id,
      subject,
      ts: new Date().toISOString(),
    }));

    return c.json({ nudged: true, eventId: event.id, subject });
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
    const diskMessageCount = getDiskMessageCount(sessionId);

    return c.json({
      sessionId: session.sessionId,
      messageCount: session.messages.length,
      diskMessageCount,
      createdAt: session.createdAt,
      lastActivityAt: session.lastActivityAt,
      metadata: session.metadata,
      messages,
    });
  });

  // --- Context management endpoints ---

  app.get('/api/context/plan', async (c) => {
    try {
      const { name, config } = await getActivePlan();
      return c.json({ name, config });
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  app.put('/api/context/plan', async (c) => {
    try {
      const body = await c.req.json<{ name: string }>();
      if (!body.name) return c.json({ error: 'name is required' }, 400);
      await setActivePlan(body.name);
      return c.json({ activated: body.name });
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }
  });

  app.get('/api/context/plans', async (c) => {
    try {
      const plans = await listPlans();
      return c.json({ plans });
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  app.post('/api/context/plans', async (c) => {
    try {
      const body = await c.req.json<{ name: string; config: ContextPlanConfig; description?: string }>();
      if (!body.name || !body.config) return c.json({ error: 'name and config are required' }, 400);
      await createPlan(body.name, body.config, body.description);
      return c.json({ created: body.name });
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }
  });

  app.get('/api/context/sessions/:id/summaries', async (c) => {
    try {
      const sessionId = c.req.param('id');
      const { rows } = await contextDb.query(
        `SELECT id, summary, topics, entities, msg_start_idx, msg_end_idx, msg_count,
                ts_start, ts_end, model, plan_name, created_at
         FROM context.summaries WHERE session_id = $1 ORDER BY msg_end_idx`,
        [sessionId]
      );
      return c.json({ sessionId, summaries: rows, count: rows.length });
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  app.get('/api/context/sessions/:id/assembly', async (c) => {
    try {
      const sessionId = c.req.param('id');
      const { rows } = await contextDb.query(
        `SELECT * FROM context.assembly_log
         WHERE session_id = $1
         ORDER BY assembled_at DESC
         LIMIT 1`,
        [sessionId]
      );
      return c.json({ assembly: rows[0] || null });
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  app.get('/api/context/metrics', async (c) => {
    try {
      const limit = parseInt(c.req.query('limit') || '20', 10);
      const { rows } = await contextDb.query(
        `SELECT * FROM context.assembly_log ORDER BY assembled_at DESC LIMIT $1`,
        [limit]
      );
      // Compute averages
      const avgAssemblyMs = rows.length > 0
        ? Math.round(rows.reduce((s, r: any) => s + r.assembly_ms, 0) / rows.length)
        : 0;
      const avgBudgetUtil = rows.length > 0
        ? Math.round(rows.reduce((s, r: any) => s + r.budget_utilization, 0) / rows.length * 100) / 100
        : 0;
      return c.json({
        recentAssemblies: rows,
        count: rows.length,
        averages: { assemblyMs: avgAssemblyMs, budgetUtilization: avgBudgetUtil },
      });
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  // --- Pipeline stats endpoint ---

  app.get('/api/pipeline', (c) => {
    return c.json(getPipelineStats());
  });

  // --- Pipeline runs endpoints ---

  app.get('/api/pipeline/runs', (c) => {
    const active = getActiveRuns();
    const recent = getRecentRuns();
    return c.json({
      active,
      recent,
      activeCount: active.length,
      recentCount: recent.length,
    });
  });

  app.get('/api/pipeline/runs/:id', (c) => {
    const run = getRun(c.req.param('id'));
    if (!run) return c.json({ error: 'Run not found' }, 404);
    return c.json(run);
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

  app.get('/api/recovery', (c) => {
    return c.json({ recovery: getLastRecovery() });
  });

  // --- Panic endpoint ---
  // Clears stuck jobs (queued + recovered + agent_done) and optionally kills running wrapper PIDs.
  // POST /api/panic  body: { includeRunning?: boolean }

  app.post('/api/panic', async (c) => {
    let includeRunning = false;
    try {
      const body = await c.req.json<{ includeRunning?: boolean }>();
      includeRunning = body.includeRunning === true;
    } catch {
      // Body optional — default to safe mode (running jobs untouched)
    }

    let result;
    try {
      result = await panicClearJobs(includeRunning);
    } catch (err) {
      return c.json({ error: 'Failed to clear jobs', detail: String(err) }, 500);
    }

    console.log(JSON.stringify({
      level: 'warn',
      msg: 'Panic button triggered',
      component: 'server',
      clearedQueued: result.clearedQueued,
      clearedRunning: result.clearedRunning,
      killedPids: result.killedPids,
      includeRunning,
      ts: new Date().toISOString(),
    }));

    return c.json({
      cleared: true,
      clearedQueued: result.clearedQueued,
      clearedRunning: result.clearedRunning,
      killedPids: result.killedPids,
    });
  });

  // --- SSE endpoint for real-time events ---

  app.get('/api/events/stream', (c) => {
    return streamSSE(c, async (stream) => {
      let eventId = 0;

      // Push new events as they arrive
      const unsubscribe = onEvent((stored) => {
        stream.writeSSE({
          event: 'event',
          data: JSON.stringify(stored),
          id: String(++eventId),
        }).catch(() => {});
      });

      // Push pipeline run updates
      const unsubscribeRuns = onRunUpdate((run) => {
        stream.writeSSE({
          event: 'pipeline-run',
          data: JSON.stringify(run),
          id: String(++eventId),
        }).catch(() => {});
      });

      // Push recovery status updates
      const unsubscribeRecovery = onRecovery((report) => {
        stream.writeSSE({
          event: 'recovery-status',
          data: JSON.stringify(report),
          id: String(++eventId),
        }).catch(() => {});
      });

      // Periodic metrics push + orphan cleanup
      const metricsInterval = setInterval(() => {
        cleanupOrphanedRuns();
        stream.writeSSE({
          event: 'metrics',
          data: JSON.stringify(buildMetricsSnapshot(deps)),
          id: String(++eventId),
        }).catch(() => {});
      }, 5000);

      // Heartbeat to keep connection alive
      const heartbeatInterval = setInterval(() => {
        stream.writeSSE({
          event: 'heartbeat',
          data: '',
          id: String(++eventId),
        }).catch(() => {});
      }, 15000);

      // Send initial metrics immediately
      await stream.writeSSE({
        event: 'metrics',
        data: JSON.stringify(buildMetricsSnapshot(deps)),
        id: String(++eventId),
      });

      // Send initial recovery status if available
      const initialRecovery = getLastRecovery();
      if (initialRecovery) {
        await stream.writeSSE({
          event: 'recovery-status',
          data: JSON.stringify(initialRecovery),
          id: String(++eventId),
        });
      }

      // Wait until client disconnects
      stream.onAbort(() => {
        unsubscribe();
        unsubscribeRuns();
        unsubscribeRecovery();
        clearInterval(metricsInterval);
        clearInterval(heartbeatInterval);
      });

      // Keep the stream open
      while (true) {
        await new Promise((resolve) => setTimeout(resolve, 30000));
      }
    });
  });

  // --- Dashboard (React SPA served from dashboard/dist/) ---

  // Redirect /dashboard to /dashboard/ so relative asset paths resolve correctly
  app.get('/dashboard', (c) => {
    const url = new URL(c.req.url);
    return c.redirect(url.pathname + '/');
  });

  app.get('/dashboard/assets/*', serveStatic({
    root: './dashboard/dist',
    rewriteRequestPath: (path) => path.replace(/^.*\/dashboard/, ''),
  }));

  app.get('/dashboard/', serveStatic({
    root: './dashboard/dist',
    rewriteRequestPath: () => '/index.html',
  }));
}

export function createApp(deps: ServerDeps): Hono {
  const app = new Hono();

  // Mount routes at root (internal access)
  registerRoutes(app, deps);

  // Mount routes at gateway prefix (/apps/stim)
  const gatewayApp = new Hono();
  registerRoutes(gatewayApp, deps);
  app.route(GATEWAY_PREFIX, gatewayApp);

  // Root redirects
  app.get('/', (c) => c.redirect('/dashboard'));

  return app;
}
