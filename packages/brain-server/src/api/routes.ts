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

  return app;
}
