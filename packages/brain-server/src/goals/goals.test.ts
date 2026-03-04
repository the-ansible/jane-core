/**
 * Goal System Integration Tests
 *
 * Tests registry CRUD, seeder idempotency, engine state, and HTTP API routes.
 * Uses real PostgreSQL — requires JANE_DATABASE_URL to be set.
 *
 * Each test cleans up after itself by deleting test-specific records.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import pg from 'pg';
import {
  initGoalRegistry,
  createGoal,
  getGoal,
  listGoals,
  listActiveGoals,
  updateGoal,
  countGoals,
  createGoalAction,
  updateGoalAction,
  listGoalActions,
  getGoalActionByJobId,
  createCycle,
  completeCycle,
  failCycle,
  listCycles,
  getLatestCycle,
  _resetPool,
} from './registry.js';
import { createJob } from '../jobs/registry.js';
import { seedInitialGoals } from './seeder.js';
import { isEngineRunning, isCycleActive, startGoalEngine, stopGoalEngine } from './engine.js';

const { Pool } = pg;

// ---------------------------------------------------------------------------
// Test DB helpers
// ---------------------------------------------------------------------------

let pool: pg.Pool;

beforeAll(async () => {
  const connectionString = process.env.JANE_DATABASE_URL;
  if (!connectionString) throw new Error('JANE_DATABASE_URL is required for tests');
  pool = new Pool({ connectionString });
  await initGoalRegistry();
});

afterAll(async () => {
  await pool.end();
  _resetPool();
});

// Track goal IDs created in tests for cleanup
const testGoalIds: string[] = [];

afterEach(async () => {
  // Clean up test goals (cascades to actions via FK — goals with parent_id must be deleted first)
  if (testGoalIds.length > 0) {
    // Delete in reverse order to handle parent_id constraints
    for (const id of [...testGoalIds].reverse()) {
      await pool.query(`DELETE FROM brain.goal_actions WHERE goal_id = $1`, [id]).catch(() => {});
      await pool.query(`DELETE FROM brain.goals WHERE id = $1`, [id]).catch(() => {});
    }
    testGoalIds.length = 0;
  }
});

// ---------------------------------------------------------------------------
// Registry: Goals CRUD
// ---------------------------------------------------------------------------

describe('Goal Registry — Goals', () => {
  it('creates and retrieves a goal', async () => {
    const id = await createGoal({
      title: 'Test Goal Alpha',
      description: 'A test goal for unit testing',
      level: 'tactical',
      priority: 42,
    });
    testGoalIds.push(id);

    const goal = await getGoal(id);
    expect(goal).not.toBeNull();
    expect(goal!.title).toBe('Test Goal Alpha');
    expect(goal!.description).toBe('A test goal for unit testing');
    expect(goal!.level).toBe('tactical');
    expect(goal!.priority).toBe(42);
    expect(goal!.status).toBe('active');
    expect(goal!.parent_id).toBeNull();
  });

  it('creates a goal with all optional fields', async () => {
    const id = await createGoal({
      title: 'Test Goal Beta',
      description: 'Full field test',
      motivation: 'Testing completeness',
      level: 'strategic',
      priority: 80,
      successCriteria: 'All fields persisted correctly',
    });
    testGoalIds.push(id);

    const goal = await getGoal(id);
    expect(goal!.motivation).toBe('Testing completeness');
    expect(goal!.success_criteria).toBe('All fields persisted correctly');
  });

  it('creates a child goal with parent_id', async () => {
    const parentId = await createGoal({
      title: 'Parent Goal',
      description: 'Parent',
      level: 'strategic',
    });
    testGoalIds.push(parentId);

    const childId = await createGoal({
      title: 'Child Goal',
      description: 'Child',
      level: 'tactical',
      parentId,
    });
    testGoalIds.push(childId);

    const child = await getGoal(childId);
    expect(child!.parent_id).toBe(parentId);
  });

  it('returns null for non-existent goal', async () => {
    const goal = await getGoal('00000000-0000-0000-0000-000000000000');
    expect(goal).toBeNull();
  });

  it('updates goal fields', async () => {
    const id = await createGoal({
      title: 'Updateable Goal',
      description: 'Will be updated',
      level: 'operational',
    });
    testGoalIds.push(id);

    await updateGoal(id, {
      title: 'Updated Title',
      priority: 99,
      status: 'paused',
      progressNotes: 'Making good progress',
    });

    const goal = await getGoal(id);
    expect(goal!.title).toBe('Updated Title');
    expect(goal!.priority).toBe(99);
    expect(goal!.status).toBe('paused');
    expect(goal!.progress_notes).toBe('Making good progress');
  });

  it('updateGoal with no updates is a no-op', async () => {
    const id = await createGoal({
      title: 'No-op Goal',
      description: 'Nothing changes',
      level: 'operational',
    });
    testGoalIds.push(id);

    await expect(updateGoal(id, {})).resolves.toBeUndefined();
    const goal = await getGoal(id);
    expect(goal!.title).toBe('No-op Goal');
  });

  it('listActiveGoals only returns active goals', async () => {
    const activeId = await createGoal({
      title: 'Active Test Goal',
      description: 'Active',
      level: 'operational',
      priority: 1,
    });
    testGoalIds.push(activeId);

    const pausedId = await createGoal({
      title: 'Paused Test Goal',
      description: 'Paused',
      level: 'operational',
      priority: 1,
    });
    testGoalIds.push(pausedId);
    await updateGoal(pausedId, { status: 'paused' });

    const activeGoals = await listActiveGoals();
    const ids = activeGoals.map((g) => g.id);
    expect(ids).toContain(activeId);
    expect(ids).not.toContain(pausedId);
  });

  it('listGoals filters by status', async () => {
    const id = await createGoal({
      title: 'Abandoned Test Goal',
      description: 'Abandoned',
      level: 'operational',
      priority: 1,
    });
    testGoalIds.push(id);
    await updateGoal(id, { status: 'abandoned' });

    const abandoned = await listGoals('abandoned');
    const ids = abandoned.map((g) => g.id);
    expect(ids).toContain(id);

    const active = await listGoals('active');
    const activeIds = active.map((g) => g.id);
    expect(activeIds).not.toContain(id);
  });

  it('countGoals returns correct count', async () => {
    const before = await countGoals();

    const id1 = await createGoal({ title: 'Count A', description: 'x', level: 'operational' });
    const id2 = await createGoal({ title: 'Count B', description: 'x', level: 'operational' });
    testGoalIds.push(id1, id2);

    const after = await countGoals();
    expect(after).toBe(before + 2);
  });
});

// ---------------------------------------------------------------------------
// Registry: Goal Actions
// ---------------------------------------------------------------------------

describe('Goal Registry — Actions', () => {
  it('creates and retrieves actions for a goal', async () => {
    const goalId = await createGoal({
      title: 'Action Goal',
      description: 'Has actions',
      level: 'tactical',
    });
    testGoalIds.push(goalId);

    const actionId = await createGoalAction({
      goalId,
      description: 'Do something useful',
      rationale: 'Because it helps',
      score: 7.5,
    });

    const actions = await listGoalActions(goalId);
    expect(actions).toHaveLength(1);
    expect(actions[0].id).toBe(actionId);
    expect(actions[0].description).toBe('Do something useful');
    expect(actions[0].score).toBe('7.50'); // pg returns numeric as string
    expect(actions[0].status).toBe('proposed');
  });

  it('updates action status and job_id', async () => {
    const goalId = await createGoal({
      title: 'Action Update Goal',
      description: 'x',
      level: 'tactical',
    });
    testGoalIds.push(goalId);

    const actionId = await createGoalAction({
      goalId,
      description: 'Execute task',
    });

    const realJobId = await createJob({ jobType: 'task', prompt: 'test job for action update', contextJson: {} });
    await updateGoalAction(actionId, { status: 'executing', jobId: realJobId });

    const actions = await listGoalActions(goalId);
    expect(actions[0].status).toBe('executing');
    expect(actions[0].job_id).toBe(realJobId);
  });

  it('getGoalActionByJobId finds action', async () => {
    const goalId = await createGoal({
      title: 'Lookup Goal',
      description: 'x',
      level: 'operational',
    });
    testGoalIds.push(goalId);

    const realJobId = await createJob({ jobType: 'task', prompt: 'test job for lookup', contextJson: {} });
    const actionId = await createGoalAction({ goalId, description: 'lookup test' });
    await updateGoalAction(actionId, { jobId: realJobId });

    const found = await getGoalActionByJobId(realJobId);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(actionId);
  });

  it('getGoalActionByJobId returns null for unknown job', async () => {
    const result = await getGoalActionByJobId('00000000-0000-0000-0000-ffffffffffff');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Registry: Goal Cycles
// ---------------------------------------------------------------------------

describe('Goal Registry — Cycles', () => {
  it('creates and completes a cycle', async () => {
    const cycleId = await createCycle();

    const goalId = await createGoal({
      title: 'Cycle Goal',
      description: 'For cycle test',
      level: 'operational',
    });
    testGoalIds.push(goalId);

    const actionId = await createGoalAction({ goalId, description: 'cycle action' });
    await completeCycle(cycleId, 3, 5, actionId, 'Test cycle complete');

    const latest = await getLatestCycle();
    // latest may not be ours if there are concurrent tests, so look it up
    const cycles = await listCycles(50);
    const ours = cycles.find((c) => c.id === cycleId);

    expect(ours).toBeDefined();
    expect(ours!.status).toBe('done');
    expect(ours!.goals_assessed).toBe(3);
    expect(ours!.candidates_generated).toBe(5);
    expect(ours!.action_selected_id).toBe(actionId);
    expect(ours!.cycle_notes).toBe('Test cycle complete');
    expect(ours!.completed_at).not.toBeNull();
  });

  it('fails a cycle', async () => {
    const cycleId = await createCycle();
    await failCycle(cycleId, 'Ollama timed out');

    const cycles = await listCycles(50);
    const ours = cycles.find((c) => c.id === cycleId);

    expect(ours!.status).toBe('failed');
    expect(ours!.cycle_notes).toBe('Ollama timed out');
    expect(ours!.completed_at).not.toBeNull();
  });

  it('listCycles respects limit', async () => {
    const cycles = await listCycles(2);
    expect(cycles.length).toBeLessThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Seeder idempotency
// ---------------------------------------------------------------------------

describe('Goal Seeder', () => {
  it('does not duplicate goals on repeated calls', async () => {
    const before = await countGoals();
    await seedInitialGoals();
    const after = await countGoals();
    expect(after).toBe(before); // seeder checks count > 0 and skips
  });
});

// ---------------------------------------------------------------------------
// Engine state
// ---------------------------------------------------------------------------

describe('Goal Engine', () => {
  it('isEngineRunning reflects start/stop state', () => {
    // Engine is started by the server process — in test context it's not running
    // (unless another test started it). We test the toggle.
    const mockNats = {
      subscribe: vi.fn().mockReturnValue({ [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) }),
      publish: vi.fn(),
    };

    expect(isEngineRunning()).toBe(false);

    startGoalEngine(mockNats as never);
    expect(isEngineRunning()).toBe(true);

    stopGoalEngine();
    expect(isEngineRunning()).toBe(false);
  });

  it('isCycleActive returns false when no cycle is running', () => {
    expect(isCycleActive()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// HTTP API Routes
// ---------------------------------------------------------------------------

describe('Goals HTTP API', () => {
  let app: ReturnType<typeof import('../api/routes.js').createApp>;
  const deps = { nats: null };

  beforeAll(async () => {
    const { createApp } = await import('../api/routes.js');
    app = createApp(deps);
  });

  it('GET /api/goals returns goals array', async () => {
    const res = await app.request('/api/goals');
    expect(res.status).toBe(200);
    const body = await res.json() as { goals: unknown[] };
    expect(Array.isArray(body.goals)).toBe(true);
    expect(body.goals.length).toBeGreaterThan(0); // seeded goals
  });

  it('GET /api/goals?status=active filters correctly', async () => {
    const res = await app.request('/api/goals?status=active');
    expect(res.status).toBe(200);
    const body = await res.json() as { goals: Array<{ status: string }> };
    expect(body.goals.every((g) => g.status === 'active')).toBe(true);
  });

  it('POST /api/goals creates a goal', async () => {
    const res = await app.request('/api/goals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'HTTP Created Goal',
        description: 'Created via API test',
        level: 'operational',
        priority: 33,
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { goal: { id: string; title: string } };
    expect(body.goal.title).toBe('HTTP Created Goal');
    testGoalIds.push(body.goal.id);
  });

  it('POST /api/goals returns 400 for missing fields', async () => {
    const res = await app.request('/api/goals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Missing description and level' }),
    });
    expect(res.status).toBe(400);
  });

  it('GET /api/goals/:id returns a specific goal', async () => {
    const id = await createGoal({
      title: 'Fetchable Goal',
      description: 'For GET by ID test',
      level: 'tactical',
    });
    testGoalIds.push(id);

    const res = await app.request(`/api/goals/${id}`);
    expect(res.status).toBe(200);
    const body = await res.json() as { goal: { id: string }; actions: unknown[] };
    expect(body.goal.id).toBe(id);
    expect(Array.isArray(body.actions)).toBe(true);
  });

  it('GET /api/goals/:id returns 404 for unknown goal', async () => {
    const res = await app.request('/api/goals/00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(404);
  });

  it('PATCH /api/goals/:id updates a goal', async () => {
    const id = await createGoal({
      title: 'Patchable Goal',
      description: 'Will be patched',
      level: 'operational',
    });
    testGoalIds.push(id);

    const res = await app.request(`/api/goals/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Patched Title', priority: 77 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { goal: { title: string; priority: number } };
    expect(body.goal.title).toBe('Patched Title');
    expect(body.goal.priority).toBe(77);
  });

  it('DELETE /api/goals/:id marks goal as abandoned', async () => {
    const id = await createGoal({
      title: 'Deleteable Goal',
      description: 'Will be abandoned',
      level: 'operational',
    });
    testGoalIds.push(id);

    const res = await app.request(`/api/goals/${id}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string };
    expect(body.status).toBe('abandoned');

    const goal = await getGoal(id);
    expect(goal!.status).toBe('abandoned');
  });

  it('GET /api/goals/cycles returns cycles array', async () => {
    const res = await app.request('/api/goals/cycles');
    expect(res.status).toBe(200);
    const body = await res.json() as { cycles: unknown[]; cycleRunning: boolean };
    expect(Array.isArray(body.cycles)).toBe(true);
    expect(typeof body.cycleRunning).toBe('boolean');
  });

  it('POST /api/goals/cycles/trigger returns 503 when NATS not connected', async () => {
    const res = await app.request('/api/goals/cycles/trigger', { method: 'POST' });
    expect(res.status).toBe(503); // deps.nats is null
  });
});
