/**
 * Brain Server HTTP API
 *
 * GET  /health                    — liveness check
 * GET  /metrics                   — running job count + uptime
 * GET  /api/jobs                  — list recent jobs
 * GET  /api/jobs/:id              — get a specific job
 * POST /api/jobs                  — submit a job directly via HTTP
 * POST /api/jobs/:id/kill         — kill a running job
 *
 * GET  /api/goals                 — list all goals (optional ?status= filter)
 * GET  /api/goals/cycles          — list recent goal cycles
 * POST /api/goals/cycles/trigger  — manually trigger a goal cycle
 * GET  /api/goals/:id             — get a specific goal + recent actions
 * POST /api/goals                 — create a goal
 * PATCH /api/goals/:id            — update a goal
 * DELETE /api/goals/:id           — abandon a goal (sets status=abandoned)
 *
 * GET  /api/layers                — status of all 4 hierarchical layers
 * GET  /api/layers/:name          — status of a specific layer
 * GET  /api/layers/events         — recent cross-layer events
 * GET  /api/layers/directives     — strategic directives
 * POST /api/layers/evaluate       — trigger strategic evaluation
 * POST /api/layers/directive      — issue a strategic directive
 */

import { Hono } from 'hono';
import type { NatsConnection } from 'nats';
import { StringCodec } from 'nats';
import { listJobs, getJob, killJob, createJob } from '../jobs/registry.js';
import { killJobProcess, getRunningJobCount, getRunningJobIds, spawnAgent } from '../jobs/spawner.js';
import type { JobRequest } from '../jobs/types.js';
import {
  listGoals, getGoal, createGoal, updateGoal, listGoalActions, listCycles,
} from '../goals/registry.js';
import { isCycleActive } from '../goals/engine.js';
import type { GoalLevel, GoalStatus } from '../goals/types.js';
import {
  getLayerStatuses, getLayerStatus, isInitialized,
  triggerStrategicEvaluation, issueDirective,
} from '../layers/controller.js';
import { listLayerEvents, listDirectives } from '../layers/registry.js';
import { getLastMonitorResults } from '../layers/autonomic.js';
import type { LayerName } from '../layers/types.js';
import {
  listMemories, getMemory, deleteMemory, countMemories, searchMemories, listPatterns,
} from '../memory/registry.js';
import { recordManualMemory } from '../memory/recorder.js';
import { getRelevantMemories, formatMemoriesForContext } from '../memory/retriever.js';
import { runConsolidation, isConsolidating, getLastConsolidationResult } from '../memory/consolidator.js';
import type { MemoryType, MemorySource } from '../memory/types.js';
import { runBackfill } from '../memory/backfill.js';
import { getIngestionHistory, countIngestedSessions } from '../memory/ingestion-log.js';

const sc = StringCodec();

export interface ServerDeps {
  nats: NatsConnection | null;
}

export function createApp(deps: ServerDeps): Hono {
  const app = new Hono();
  const startTime = Date.now();

  app.get('/health', (c) => {
    return c.json({
      status: 'ok',
      service: 'brain-server',
      uptime: Math.floor((Date.now() - startTime) / 1000),
      natsConnected: deps.nats !== null,
      ts: new Date().toISOString(),
    });
  });

  app.get('/metrics', (c) => {
    return c.json({
      runningJobs: getRunningJobCount(),
      runningJobIds: getRunningJobIds(),
      uptimeMs: Date.now() - startTime,
      ts: new Date().toISOString(),
    });
  });

  app.get('/api/jobs', async (c) => {
    try {
      const limit = parseInt(c.req.query('limit') ?? '50', 10);
      const jobs = await listJobs(Math.min(limit, 200));
      return c.json({ jobs });
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  app.get('/api/jobs/:id', async (c) => {
    try {
      const job = await getJob(c.req.param('id'));
      if (!job) return c.json({ error: 'Not found' }, 404);
      return c.json({ job });
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  app.post('/api/jobs', async (c) => {
    if (!deps.nats) return c.json({ error: 'NATS not connected — try again in a moment' }, 503);

    try {
      const body = await c.req.json() as Partial<JobRequest>;

      if (!body.prompt || typeof body.prompt !== 'string') {
        return c.json({ error: 'prompt is required' }, 400);
      }

      const request: JobRequest = {
        type: body.type ?? 'task',
        prompt: body.prompt,
        context: body.context,
        replySubject: body.replySubject,
        workdir: body.workdir,
        projectPath: body.projectPath,
        clientId: body.clientId,
      };

      const jobId = await createJob({
        jobType: request.type,
        prompt: request.prompt,
        contextJson: request.context ?? {},
        natsReplySubject: request.replySubject,
      });

      spawnAgent({ jobId, request, nats: deps.nats }).catch((err) => {
        console.log(JSON.stringify({
          level: 'error',
          msg: 'Failed to spawn agent from HTTP',
          jobId,
          error: String(err),
          ts: new Date().toISOString(),
        }));
      });

      return c.json({ jobId, status: 'queued' }, 201);
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  app.post('/api/jobs/:id/kill', async (c) => {
    try {
      const jobId = c.req.param('id');
      const job = await getJob(jobId);
      if (!job) return c.json({ error: 'Not found' }, 404);

      if (!['running', 'unresponsive'].includes(job.status)) {
        return c.json({ error: `Job is not running (status: ${job.status})` }, 400);
      }

      const killed = killJobProcess(jobId);
      const { pid } = await killJob(jobId);

      if (!killed && pid) {
        try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
      }

      return c.json({ jobId, killed: killed || pid !== null, pid });
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  // -------------------------------------------------------------------------
  // Goals API
  // -------------------------------------------------------------------------

  app.get('/api/goals', async (c) => {
    try {
      const status = c.req.query('status') as GoalStatus | undefined;
      const goals = await listGoals(status);
      return c.json({ goals });
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  // Must be defined before /api/goals/:id to avoid 'cycles' matching :id
  app.get('/api/goals/cycles', async (c) => {
    try {
      const limit = parseInt(c.req.query('limit') ?? '20', 10);
      const cycles = await listCycles(Math.min(limit, 100));
      return c.json({ cycles, cycleRunning: isCycleActive() });
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  app.post('/api/goals/cycles/trigger', async (c) => {
    if (!deps.nats) return c.json({ error: 'NATS not connected' }, 503);
    if (isCycleActive()) return c.json({ error: 'Cycle already running' }, 409);

    try {
      deps.nats.publish('goals.cycle.trigger', sc.encode(JSON.stringify({ source: 'http', ts: new Date().toISOString() })));
      return c.json({ status: 'triggered' }, 202);
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  app.get('/api/goals/:id', async (c) => {
    try {
      const goal = await getGoal(c.req.param('id'));
      if (!goal) return c.json({ error: 'Not found' }, 404);
      const actions = await listGoalActions(goal.id, 10);
      return c.json({ goal, actions });
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  app.post('/api/goals', async (c) => {
    try {
      const body = await c.req.json() as {
        title?: string;
        description?: string;
        motivation?: string;
        level?: GoalLevel;
        priority?: number;
        parentId?: string;
        successCriteria?: string;
      };

      if (!body.title || !body.description || !body.level) {
        return c.json({ error: 'title, description, and level are required' }, 400);
      }

      const id = await createGoal({
        title: body.title,
        description: body.description,
        motivation: body.motivation,
        level: body.level,
        priority: body.priority,
        parentId: body.parentId,
        successCriteria: body.successCriteria,
      });

      const goal = await getGoal(id);
      return c.json({ goal }, 201);
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  app.patch('/api/goals/:id', async (c) => {
    try {
      const id = c.req.param('id');
      const goal = await getGoal(id);
      if (!goal) return c.json({ error: 'Not found' }, 404);

      const body = await c.req.json() as Partial<{
        title: string;
        description: string;
        motivation: string;
        level: GoalLevel;
        priority: number;
        status: GoalStatus;
        parentId: string | null;
        successCriteria: string;
        progressNotes: string;
      }>;

      await updateGoal(id, body);
      const updated = await getGoal(id);
      return c.json({ goal: updated });
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  app.delete('/api/goals/:id', async (c) => {
    try {
      const id = c.req.param('id');
      const goal = await getGoal(id);
      if (!goal) return c.json({ error: 'Not found' }, 404);
      await updateGoal(id, { status: 'abandoned' });
      return c.json({ id, status: 'abandoned' });
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  // -------------------------------------------------------------------------
  // Hierarchical Layers API
  // -------------------------------------------------------------------------

  // Must be before /:name to avoid route conflicts
  app.get('/api/layers/events', async (c) => {
    try {
      const layer = c.req.query('layer') as LayerName | undefined;
      const eventType = c.req.query('type') as string | undefined;
      const severity = c.req.query('severity');
      const limit = parseInt(c.req.query('limit') ?? '50', 10);
      const opts: Parameters<typeof listLayerEvents>[0] = {
        layer,
        severity: severity ?? undefined,
        limit: Math.min(limit, 500),
      };
      if (eventType) opts.eventType = eventType as NonNullable<typeof opts.eventType>;
      const events = await listLayerEvents(opts);
      return c.json({ events });
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  app.get('/api/layers/directives', async (c) => {
    try {
      const targetLayer = c.req.query('target') as LayerName | undefined;
      const status = c.req.query('status') as Parameters<typeof listDirectives>[1];
      const directives = await listDirectives(targetLayer, status);
      return c.json({ directives });
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  app.post('/api/layers/evaluate', async (c) => {
    if (!deps.nats) return c.json({ error: 'NATS not connected' }, 503);
    if (!isInitialized()) return c.json({ error: 'Hierarchical control not initialized' }, 503);
    try {
      const jobId = await triggerStrategicEvaluation(deps.nats);
      return c.json({ jobId, status: 'triggered' }, 202);
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  app.post('/api/layers/directive', async (c) => {
    if (!deps.nats) return c.json({ error: 'NATS not connected' }, 503);
    if (!isInitialized()) return c.json({ error: 'Hierarchical control not initialized' }, 503);
    try {
      const body = await c.req.json() as {
        targetLayer?: string;
        directive?: string;
        params?: Record<string, unknown>;
      };
      if (!body.targetLayer || !body.directive) {
        return c.json({ error: 'targetLayer and directive are required' }, 400);
      }
      const validLayers = ['autonomic', 'reflexive', 'cognitive'] as const;
      type TargetLayer = typeof validLayers[number];
      if (!validLayers.includes(body.targetLayer as TargetLayer)) {
        return c.json({ error: `targetLayer must be one of: ${validLayers.join(', ')}` }, 400);
      }
      const directiveId = await issueDirective(deps.nats, {
        targetLayer: body.targetLayer as TargetLayer,
        directive: body.directive,
        directiveParams: body.params,
      });
      return c.json({ directiveId, status: 'issued' }, 201);
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  app.get('/api/layers', (c) => {
    if (!isInitialized()) {
      return c.json({ initialized: false, layers: [] });
    }
    const statuses = getLayerStatuses();
    const monitors = getLastMonitorResults();
    return c.json({ initialized: true, layers: statuses, monitors });
  });

  app.get('/api/layers/:name', (c) => {
    const name = c.req.param('name') as LayerName;
    const status = getLayerStatus(name);
    if (!status) return c.json({ error: 'Unknown layer' }, 404);
    const extra = name === 'autonomic' ? { monitors: getLastMonitorResults() } : {};
    return c.json({ ...status, ...extra });
  });

  // -------------------------------------------------------------------------
  // Memory API
  //
  // GET  /api/memories            — list memories (filters: type, source, tags, minImportance, limit)
  // GET  /api/memories/search     — keyword search (?q=...)
  // GET  /api/memories/context    — retrieve + format relevant memories for LLM context (?q=, tags=)
  // GET  /api/memories/patterns   — list learned patterns
  // GET  /api/memories/stats      — summary stats
  // GET  /api/memories/consolidation — consolidation state + last result
  // POST /api/memories            — manually record a memory
  // POST /api/memories/consolidate — trigger manual consolidation run
  // GET  /api/memories/:id        — get a specific memory (increments access_count)
  // DELETE /api/memories/:id      — delete a memory
  // -------------------------------------------------------------------------

  app.get('/api/memories/search', async (c) => {
    try {
      const q = c.req.query('q');
      if (!q) return c.json({ error: 'q parameter is required' }, 400);
      const limit = parseInt(c.req.query('limit') ?? '20', 10);
      const memories = await searchMemories(q, Math.min(limit, 100));
      return c.json({ memories, count: memories.length });
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  app.get('/api/memories/context', async (c) => {
    try {
      const q = c.req.query('q');
      const tagsRaw = c.req.query('tags');
      const tags = tagsRaw ? tagsRaw.split(',').map((t) => t.trim()) : undefined;
      const limit = parseInt(c.req.query('limit') ?? '8', 10);
      const memories = await getRelevantMemories({ query: q, tags, limit: Math.min(limit, 20) });
      const text = formatMemoriesForContext(memories);
      return c.json({ memories, text, count: memories.length });
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  app.get('/api/memories/patterns', async (c) => {
    try {
      const patternType = c.req.query('type');
      const minConfidence = c.req.query('minConfidence') ? parseFloat(c.req.query('minConfidence')!) : undefined;
      const limit = parseInt(c.req.query('limit') ?? '50', 10);
      const patterns = await listPatterns({ patternType, minConfidence, limit: Math.min(limit, 200) });
      return c.json({ patterns, count: patterns.length });
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  app.get('/api/memories/stats', async (c) => {
    try {
      const total = await countMemories();
      return c.json({ total, ts: new Date().toISOString() });
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  app.get('/api/memories/consolidation', (c) => {
    const { lastRunAt, result } = getLastConsolidationResult();
    return c.json({ consolidating: isConsolidating(), lastRunAt, result });
  });

  app.post('/api/memories/consolidate', async (c) => {
    if (isConsolidating()) return c.json({ error: 'Consolidation already running' }, 409);
    try {
      const result = await runConsolidation();
      return c.json({ result }, result.error ? 500 : 200);
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  // Must be before /:id
  app.get('/api/memories', async (c) => {
    try {
      const type = c.req.query('type') as MemoryType | undefined;
      const source = c.req.query('source') as MemorySource | undefined;
      const tagsRaw = c.req.query('tags');
      const tags = tagsRaw ? tagsRaw.split(',').map((t) => t.trim()) : undefined;
      const minImportance = c.req.query('minImportance') ? parseFloat(c.req.query('minImportance')!) : undefined;
      const limit = parseInt(c.req.query('limit') ?? '50', 10);
      const memories = await listMemories({ type, source, tags, minImportance, limit: Math.min(limit, 500) });
      return c.json({ memories, count: memories.length });
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  app.post('/api/memories', async (c) => {
    try {
      const body = await c.req.json() as {
        title?: string;
        content?: string;
        type?: string;
        tags?: string[];
        importance?: number;
        expiresInMs?: number;
        metadata?: Record<string, unknown>;
        source?: string;
      };

      if (!body.title || !body.content) {
        return c.json({ error: 'title and content are required' }, 400);
      }

      const validTypes = ['episodic', 'semantic', 'procedural', 'working'];
      if (body.type && !validTypes.includes(body.type)) {
        return c.json({ error: `type must be one of: ${validTypes.join(', ')}` }, 400);
      }

      const id = await recordManualMemory({
        title: body.title,
        content: body.content,
        type: body.type as 'episodic' | 'semantic' | 'procedural' | 'working' | undefined,
        tags: body.tags,
        importance: body.importance,
        expiresInMs: body.expiresInMs,
        metadata: body.metadata,
        source: body.source as MemorySource | undefined,
      });

      const memory = await getMemory(id);
      return c.json({ memory }, 201);
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  app.get('/api/memories/:id', async (c) => {
    try {
      const memory = await getMemory(c.req.param('id'));
      if (!memory) return c.json({ error: 'Not found' }, 404);
      return c.json({ memory });
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  app.delete('/api/memories/:id', async (c) => {
    try {
      const deleted = await deleteMemory(c.req.param('id'));
      if (!deleted) return c.json({ error: 'Not found' }, 404);
      return c.json({ id: c.req.param('id'), deleted: true });
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  // -------------------------------------------------------------------------
  // Graphiti Memory Ingestion API
  //
  // POST /api/memory/backfill        — ingest existing sessions into Graphiti
  // GET  /api/memory/ingestion       — ingestion stats + history
  // GET  /api/memory/ingestion/:sid  — ingestion history for a session
  // -------------------------------------------------------------------------

  app.post('/api/memory/backfill', async (c) => {
    const body = await c.req.json().catch(() => ({})) as { sessionId?: string };
    // Run in the background — Graphiti takes ~84s per episode so this can take 30+ minutes.
    // Return 202 immediately and check /api/memory/ingestion for progress.
    runBackfill(body.sessionId).catch((err) => {
      console.error(JSON.stringify({ level: 'error', msg: 'Backfill failed', error: String(err), component: 'brain-api', ts: new Date().toISOString() }));
    });
    return c.json({ status: 'started', message: 'Backfill running in background. Check /api/memory/ingestion for progress.' }, 202);
  });

  app.get('/api/memory/ingestion', async (c) => {
    try {
      const totalSessions = await countIngestedSessions();
      return c.json({ totalIngestedSessions: totalSessions });
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  app.get('/api/memory/ingestion/:sessionId', async (c) => {
    try {
      const history = await getIngestionHistory(c.req.param('sessionId'));
      return c.json({ sessionId: c.req.param('sessionId'), history });
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  return app;
}
