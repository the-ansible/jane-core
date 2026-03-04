/**
 * Goal Registry — PostgreSQL persistence for goals, actions, and cycles.
 *
 * Tables:
 *   brain.goals        — persistent goal hierarchy
 *   brain.goal_actions — candidate actions generated each cycle
 *   brain.goal_cycles  — audit log of each engine run
 */

import pg from 'pg';
import type { Goal, GoalAction, GoalCycle, GoalLevel, GoalStatus, ActionStatus, CycleStatus } from './types.js';

const { Pool } = pg;

let pool: pg.Pool | null = null;

function getPool(): pg.Pool {
  if (pool) return pool;
  const connectionString = process.env.JANE_DATABASE_URL;
  if (!connectionString) throw new Error('JANE_DATABASE_URL is required');
  pool = new Pool({ connectionString });
  return pool;
}

// ---------------------------------------------------------------------------
// Schema init
// ---------------------------------------------------------------------------

export async function initGoalRegistry(): Promise<void> {
  const p = getPool();

  await p.query(`
    CREATE TABLE IF NOT EXISTS brain.goals (
      id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      title            TEXT NOT NULL,
      description      TEXT NOT NULL,
      motivation       TEXT,
      level            TEXT NOT NULL CHECK (level IN ('asymptotic','strategic','tactical','operational')),
      priority         INTEGER NOT NULL DEFAULT 50 CHECK (priority BETWEEN 1 AND 100),
      status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','achieved','abandoned')),
      parent_id        UUID REFERENCES brain.goals(id),
      success_criteria TEXT,
      progress_notes   TEXT,
      last_evaluated_at TIMESTAMPTZ,
      created_at       TIMESTAMPTZ DEFAULT now(),
      updated_at       TIMESTAMPTZ DEFAULT now()
    )
  `);

  await p.query(`
    CREATE TABLE IF NOT EXISTS brain.goal_actions (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      goal_id      UUID NOT NULL REFERENCES brain.goals(id),
      cycle_id     UUID,
      description  TEXT NOT NULL,
      rationale    TEXT,
      status       TEXT NOT NULL DEFAULT 'proposed'
                   CHECK (status IN ('proposed','selected','executing','done','failed','rejected')),
      score        NUMERIC(5,2),
      job_id       UUID REFERENCES brain.agent_jobs(id),
      outcome_text TEXT,
      created_at   TIMESTAMPTZ DEFAULT now(),
      updated_at   TIMESTAMPTZ DEFAULT now()
    )
  `);

  await p.query(`
    CREATE TABLE IF NOT EXISTS brain.goal_cycles (
      id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      status              TEXT NOT NULL DEFAULT 'running'
                          CHECK (status IN ('running','done','failed')),
      goals_assessed      INTEGER NOT NULL DEFAULT 0,
      candidates_generated INTEGER NOT NULL DEFAULT 0,
      action_selected_id  UUID REFERENCES brain.goal_actions(id),
      cycle_notes         TEXT,
      started_at          TIMESTAMPTZ DEFAULT now(),
      completed_at        TIMESTAMPTZ
    )
  `);

  await p.query(`CREATE INDEX IF NOT EXISTS idx_goals_status ON brain.goals (status)`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_goals_level  ON brain.goals (level)`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_goal_actions_goal ON brain.goal_actions (goal_id)`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_goal_cycles_started ON brain.goal_cycles (started_at DESC)`);

  log('info', 'Goal registry initialized');
}

// ---------------------------------------------------------------------------
// Goals
// ---------------------------------------------------------------------------

export async function createGoal(params: {
  title: string;
  description: string;
  motivation?: string;
  level: GoalLevel;
  priority?: number;
  parentId?: string;
  successCriteria?: string;
}): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO brain.goals (title, description, motivation, level, priority, parent_id, success_criteria)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      params.title,
      params.description,
      params.motivation ?? null,
      params.level,
      params.priority ?? 50,
      params.parentId ?? null,
      params.successCriteria ?? null,
    ]
  );
  return rows[0].id;
}

export async function listActiveGoals(): Promise<Goal[]> {
  const { rows } = await getPool().query<Goal>(
    `SELECT * FROM brain.goals WHERE status = 'active' ORDER BY priority DESC, created_at ASC`
  );
  return rows;
}

export async function listGoals(status?: GoalStatus): Promise<Goal[]> {
  if (status) {
    const { rows } = await getPool().query<Goal>(
      `SELECT * FROM brain.goals WHERE status = $1 ORDER BY priority DESC, created_at ASC`,
      [status]
    );
    return rows;
  }
  const { rows } = await getPool().query<Goal>(
    `SELECT * FROM brain.goals ORDER BY priority DESC, created_at ASC`
  );
  return rows;
}

export async function getGoal(id: string): Promise<Goal | null> {
  const { rows } = await getPool().query<Goal>(`SELECT * FROM brain.goals WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

export async function updateGoal(id: string, updates: Partial<{
  title: string;
  description: string;
  motivation: string;
  level: GoalLevel;
  priority: number;
  status: GoalStatus;
  parentId: string | null;
  successCriteria: string;
  progressNotes: string;
}>): Promise<void> {
  const sets: string[] = ['updated_at = now()'];
  const vals: unknown[] = [];
  let i = 1;

  if (updates.title !== undefined)           { sets.push(`title = $${i++}`);            vals.push(updates.title); }
  if (updates.description !== undefined)     { sets.push(`description = $${i++}`);      vals.push(updates.description); }
  if (updates.motivation !== undefined)      { sets.push(`motivation = $${i++}`);       vals.push(updates.motivation); }
  if (updates.level !== undefined)           { sets.push(`level = $${i++}`);            vals.push(updates.level); }
  if (updates.priority !== undefined)        { sets.push(`priority = $${i++}`);         vals.push(updates.priority); }
  if (updates.status !== undefined)          { sets.push(`status = $${i++}`);           vals.push(updates.status); }
  if (updates.parentId !== undefined)        { sets.push(`parent_id = $${i++}`);        vals.push(updates.parentId); }
  if (updates.successCriteria !== undefined) { sets.push(`success_criteria = $${i++}`); vals.push(updates.successCriteria); }
  if (updates.progressNotes !== undefined)   { sets.push(`progress_notes = $${i++}`);   vals.push(updates.progressNotes); }

  if (sets.length === 1) return; // nothing to update
  vals.push(id);
  await getPool().query(`UPDATE brain.goals SET ${sets.join(', ')} WHERE id = $${i}`, vals);
}

export async function touchGoalEvaluated(id: string): Promise<void> {
  await getPool().query(
    `UPDATE brain.goals SET last_evaluated_at = now(), updated_at = now() WHERE id = $1`,
    [id]
  );
}

export async function countGoals(): Promise<number> {
  const { rows } = await getPool().query<{ count: string }>(`SELECT COUNT(*) as count FROM brain.goals`);
  return parseInt(rows[0].count, 10);
}

// ---------------------------------------------------------------------------
// Goal Actions
// ---------------------------------------------------------------------------

export async function createGoalAction(params: {
  goalId: string;
  cycleId?: string;
  description: string;
  rationale?: string;
  score?: number;
  status?: ActionStatus;
}): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO brain.goal_actions (goal_id, cycle_id, description, rationale, score, status)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [
      params.goalId,
      params.cycleId ?? null,
      params.description,
      params.rationale ?? null,
      params.score ?? null,
      params.status ?? 'proposed',
    ]
  );
  return rows[0].id;
}

export async function updateGoalAction(id: string, updates: Partial<{
  status: ActionStatus;
  score: number;
  jobId: string;
  outcomeText: string;
}>): Promise<void> {
  const sets: string[] = ['updated_at = now()'];
  const vals: unknown[] = [];
  let i = 1;

  if (updates.status !== undefined)      { sets.push(`status = $${i++}`);       vals.push(updates.status); }
  if (updates.score !== undefined)       { sets.push(`score = $${i++}`);        vals.push(updates.score); }
  if (updates.jobId !== undefined)       { sets.push(`job_id = $${i++}`);       vals.push(updates.jobId); }
  if (updates.outcomeText !== undefined) { sets.push(`outcome_text = $${i++}`); vals.push(updates.outcomeText); }

  vals.push(id);
  await getPool().query(`UPDATE brain.goal_actions SET ${sets.join(', ')} WHERE id = $${i}`, vals);
}

export async function listGoalActions(goalId: string, limit = 20): Promise<GoalAction[]> {
  const { rows } = await getPool().query<GoalAction>(
    `SELECT * FROM brain.goal_actions WHERE goal_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [goalId, limit]
  );
  return rows;
}

export async function getGoalActionByJobId(jobId: string): Promise<GoalAction | null> {
  const { rows } = await getPool().query<GoalAction>(
    `SELECT * FROM brain.goal_actions WHERE job_id = $1 LIMIT 1`,
    [jobId]
  );
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Goal Cycles
// ---------------------------------------------------------------------------

export async function createCycle(): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO brain.goal_cycles DEFAULT VALUES RETURNING id`
  );
  return rows[0].id;
}

export async function completeCycle(id: string, goalsAssessed: number, candidatesGenerated: number, actionSelectedId: string | null, notes: string | null): Promise<void> {
  await getPool().query(
    `UPDATE brain.goal_cycles
     SET status = 'done', goals_assessed = $1, candidates_generated = $2,
         action_selected_id = $3, cycle_notes = $4, completed_at = now()
     WHERE id = $5`,
    [goalsAssessed, candidatesGenerated, actionSelectedId, notes, id]
  );
}

export async function failCycle(id: string, notes: string): Promise<void> {
  await getPool().query(
    `UPDATE brain.goal_cycles
     SET status = 'failed', cycle_notes = $1, completed_at = now()
     WHERE id = $2`,
    [notes, id]
  );
}

export async function listCycles(limit = 20): Promise<GoalCycle[]> {
  const { rows } = await getPool().query<GoalCycle>(
    `SELECT * FROM brain.goal_cycles ORDER BY started_at DESC LIMIT $1`,
    [limit]
  );
  return rows;
}

export async function getLatestCycle(): Promise<GoalCycle | null> {
  const { rows } = await getPool().query<GoalCycle>(
    `SELECT * FROM brain.goal_cycles ORDER BY started_at DESC LIMIT 1`
  );
  return rows[0] ?? null;
}

export function _resetPool(): void {
  pool = null;
}

function log(level: string, msg: string, extra?: Record<string, unknown>): void {
  console.log(JSON.stringify({ level, msg, component: 'goal-registry', ts: new Date().toISOString(), ...extra }));
}
