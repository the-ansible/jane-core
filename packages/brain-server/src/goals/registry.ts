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
                   CHECK (status IN ('proposed','selected','executing','reviewing','done','failed','rejected')),
      score        NUMERIC(5,2),
      job_id       UUID REFERENCES brain.agent_jobs(id),
      outcome_text TEXT,
      review_text  TEXT,
      review_job_id UUID REFERENCES brain.agent_jobs(id),
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

  // Migrations for existing tables
  await p.query(`ALTER TABLE brain.goal_actions ADD COLUMN IF NOT EXISTS review_text TEXT`);
  await p.query(`ALTER TABLE brain.goal_actions ADD COLUMN IF NOT EXISTS review_job_id UUID REFERENCES brain.agent_jobs(id)`);
  // Update check constraint to include 'reviewing' status
  await p.query(`
    DO $$ BEGIN
      ALTER TABLE brain.goal_actions DROP CONSTRAINT IF EXISTS goal_actions_status_check;
      ALTER TABLE brain.goal_actions ADD CONSTRAINT goal_actions_status_check
        CHECK (status IN ('proposed','selected','executing','reviewing','done','failed','rejected'));
    END $$
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

/** Levenshtein edit distance between two strings. */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const prev: number[] = Array.from({ length: n + 1 }, (_, j) => j);
  const curr: number[] = new Array(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      curr[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j], curr[j - 1], prev[j - 1]);
    }
    prev.splice(0, prev.length, ...curr);
  }
  return prev[n];
}

/** Normalized similarity score 0..1 based on Levenshtein distance. */
function titleSimilarity(a: string, b: string): number {
  const na = a.toLowerCase().trim();
  const nb = b.toLowerCase().trim();
  if (na === nb) return 1.0;
  const maxLen = Math.max(na.length, nb.length);
  if (maxLen === 0) return 1.0;
  return 1 - levenshtein(na, nb) / maxLen;
}

/**
 * Find an existing non-abandoned goal whose title is similar to the given title
 * (similarity >= threshold). Returns the first match or null.
 */
export async function findDuplicateGoal(title: string, threshold = 0.90): Promise<Goal | null> {
  const { rows } = await getPool().query<Goal>(
    `SELECT * FROM brain.goals WHERE status != 'abandoned' ORDER BY created_at ASC`
  );
  for (const goal of rows) {
    const sim = titleSimilarity(goal.title, title);
    if (sim >= threshold) return goal;
  }
  return null;
}

export async function createGoal(params: {
  title: string;
  description: string;
  motivation?: string;
  level: GoalLevel;
  priority?: number;
  parentId?: string;
  successCriteria?: string;
}): Promise<string> {
  // Deduplication: skip insert if a similar goal already exists
  const duplicate = await findDuplicateGoal(params.title, 0.90);
  if (duplicate) {
    log('warn', 'Skipping duplicate goal — similar title already exists', {
      newTitle: params.title,
      existingTitle: duplicate.title,
      existingId: duplicate.id,
      existingStatus: duplicate.status,
    });
    return duplicate.id;
  }

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
  reviewText: string;
  reviewJobId: string;
}>): Promise<void> {
  const sets: string[] = ['updated_at = now()'];
  const vals: unknown[] = [];
  let i = 1;

  if (updates.status !== undefined)      { sets.push(`status = $${i++}`);       vals.push(updates.status); }
  if (updates.score !== undefined)       { sets.push(`score = $${i++}`);        vals.push(updates.score); }
  if (updates.jobId !== undefined)       { sets.push(`job_id = $${i++}`);       vals.push(updates.jobId); }
  if (updates.outcomeText !== undefined) { sets.push(`outcome_text = $${i++}`); vals.push(updates.outcomeText); }
  if (updates.reviewText !== undefined)  { sets.push(`review_text = $${i++}`);  vals.push(updates.reviewText); }
  if (updates.reviewJobId !== undefined) { sets.push(`review_job_id = $${i++}`); vals.push(updates.reviewJobId); }

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

export async function getGoalAction(id: string): Promise<GoalAction | null> {
  const { rows } = await getPool().query<GoalAction>(
    `SELECT * FROM brain.goal_actions WHERE id = $1`,
    [id]
  );
  return rows[0] ?? null;
}

/** Return the most recent completed (done/failed) actions across all goals, for deduplication context. */
export async function listRecentDoneActions(limit = 6): Promise<{ description: string; status: string; goalTitle: string }[]> {
  const { rows } = await getPool().query<{ description: string; status: string; goal_title: string }>(
    `SELECT ga.description, ga.status, g.title AS goal_title
     FROM brain.goal_actions ga
     JOIN brain.goals g ON g.id = ga.goal_id
     WHERE ga.status IN ('done', 'failed')
     ORDER BY ga.updated_at DESC
     LIMIT $1`,
    [limit]
  );
  return rows.map((r) => ({ description: r.description, status: r.status, goalTitle: r.goal_title }));
}

/**
 * Return the most recent completed (done/failed) actions per goal, grouped by goal.
 * More useful than a global limit when multiple goals are active — ensures each goal's
 * recent history appears in context, preventing re-selection loops on any single goal.
 */
export async function listRecentDoneActionsPerGoal(
  goalIds: string[],
  limitPerGoal = 5
): Promise<Record<string, { description: string; status: string; review_text: string | null }[]>> {
  if (goalIds.length === 0) return {};

  const { rows } = await getPool().query<{ goal_id: string; description: string; status: string; review_text: string | null }>(
    `SELECT goal_id, description, status, review_text
     FROM (
       SELECT ga.goal_id, ga.description, ga.status, ga.review_text,
              ROW_NUMBER() OVER (PARTITION BY ga.goal_id ORDER BY ga.updated_at DESC) AS rn
       FROM brain.goal_actions ga
       WHERE ga.status IN ('done', 'failed')
         AND ga.goal_id = ANY($1)
     ) ranked
     WHERE rn <= $2
     ORDER BY goal_id, rn`,
    [goalIds, limitPerGoal]
  );

  const result: Record<string, { description: string; status: string; review_text: string | null }[]> = {};
  for (const r of rows) {
    if (!result[r.goal_id]) result[r.goal_id] = [];
    result[r.goal_id].push({ description: r.description, status: r.status, review_text: r.review_text });
  }
  return result;
}

export async function getGoalActionByJobId(jobId: string): Promise<GoalAction | null> {
  const { rows } = await getPool().query<GoalAction>(
    `SELECT * FROM brain.goal_actions WHERE job_id = $1 LIMIT 1`,
    [jobId]
  );
  return rows[0] ?? null;
}

export async function listExecutingGoalIds(): Promise<string[]> {
  const { rows } = await getPool().query<{ goal_id: string }>(
    `SELECT DISTINCT goal_id FROM brain.goal_actions WHERE status IN ('executing', 'reviewing')`
  );
  return rows.map((r) => r.goal_id);
}

/** Get all completed actions for a goal (for reviewer context). */
export async function listCompletedActionsForGoal(goalId: string): Promise<GoalAction[]> {
  const { rows } = await getPool().query<GoalAction>(
    `SELECT * FROM brain.goal_actions
     WHERE goal_id = $1 AND status IN ('done', 'failed')
     ORDER BY created_at ASC`,
    [goalId]
  );
  return rows;
}

/** Count done actions that have been reviewed (have review_text) but did not achieve the goal. */
export async function countReviewedUnachievedActions(goalId: string): Promise<number> {
  const { rows } = await getPool().query<{ count: string }>(
    `SELECT COUNT(*) as count FROM brain.goal_actions
     WHERE goal_id = $1 AND status IN ('done', 'failed') AND review_text IS NOT NULL`,
    [goalId]
  );
  return parseInt(rows[0].count, 10);
}

/** Find the goal action linked to a review job ID. */
export async function getGoalActionByReviewJobId(reviewJobId: string): Promise<GoalAction | null> {
  const { rows } = await getPool().query<GoalAction>(
    `SELECT * FROM brain.goal_actions WHERE review_job_id = $1 LIMIT 1`,
    [reviewJobId]
  );
  return rows[0] ?? null;
}

/**
 * At startup, recover goal_actions stuck in transitional states.
 *
 * For 'executing' actions:
 * - If the linked job already finished (done/failed), store the outcome but leave
 *   the action needing review. Returns these action IDs so the engine can spawn reviewers.
 * - If the linked job is orphaned (>30min no activity), mark for restart by the engine.
 *
 * For 'reviewing' actions:
 * - If the review job is dead, returns these so the engine can re-spawn reviewers.
 *
 * Returns arrays of actions needing attention so the engine can handle them
 * (spawning reviewers or restarting jobs) rather than blanket-failing.
 */
export interface StaleActionRecovery {
  /** Actions whose execution jobs finished but need review. */
  needsReview: { actionId: string; goalId: string }[];
  /** Actions whose execution jobs are orphaned and need restart. */
  needsRestart: { actionId: string; goalId: string; jobId: string }[];
  /** Actions stuck in reviewing with dead review jobs — need reviewer re-spawn. */
  needsReviewerRespawn: { actionId: string; goalId: string }[];
}

export async function recoverStaleGoalActions(): Promise<StaleActionRecovery> {
  const recovery: StaleActionRecovery = { needsReview: [], needsRestart: [], needsReviewerRespawn: [] };

  // Case 1: executing actions whose jobs already finished — capture outcome, flag for review
  const r1 = await getPool().query<{ id: string; goal_id: string }>(
    `UPDATE brain.goal_actions
     SET outcome_text = COALESCE(
           brain.goal_actions.outcome_text,
           COALESCE(aj.result_text, 'Recovered at startup: job was ' || aj.status)
         ),
         updated_at = now()
     FROM brain.agent_jobs aj
     WHERE brain.goal_actions.job_id = aj.id
       AND brain.goal_actions.status = 'executing'
       AND aj.status IN ('done', 'failed', 'unresponsive')
     RETURNING brain.goal_actions.id, brain.goal_actions.goal_id`
  );
  for (const row of r1.rows) {
    recovery.needsReview.push({ actionId: row.id, goalId: row.goal_id });
  }

  // Case 2: executing actions with orphaned running jobs (>30min no activity)
  const r2 = await getPool().query<{ id: string; goal_id: string; job_id: string }>(
    `SELECT brain.goal_actions.id, brain.goal_actions.goal_id, brain.goal_actions.job_id
     FROM brain.goal_actions
     JOIN brain.agent_jobs aj ON brain.goal_actions.job_id = aj.id
     WHERE brain.goal_actions.status = 'executing'
       AND aj.status = 'running'
       AND COALESCE(aj.last_activity_at, aj.started_at, aj.created_at) < now() - INTERVAL '30 minutes'`
  );
  for (const row of r2.rows) {
    recovery.needsRestart.push({ actionId: row.id, goalId: row.goal_id, jobId: row.job_id });
  }

  // Case 3: reviewing actions whose review jobs are dead
  const r3 = await getPool().query<{ id: string; goal_id: string }>(
    `SELECT brain.goal_actions.id, brain.goal_actions.goal_id
     FROM brain.goal_actions
     LEFT JOIN brain.agent_jobs aj ON brain.goal_actions.review_job_id = aj.id
     WHERE brain.goal_actions.status = 'reviewing'
       AND (aj.id IS NULL OR aj.status IN ('done', 'failed', 'unresponsive')
            OR (aj.status = 'running'
                AND COALESCE(aj.last_activity_at, aj.started_at, aj.created_at) < now() - INTERVAL '30 minutes'))`
  );
  for (const row of r3.rows) {
    recovery.needsReviewerRespawn.push({ actionId: row.id, goalId: row.goal_id });
  }

  return recovery;
}

/**
 * Return the N most recently completed (done/failed) actions across ALL goals,
 * ordered newest-first, with timestamps. Used by the candidate generator to
 * prevent re-proposing recent work within the last 24 hours.
 */
export async function listRecentCompletedActionsGlobal(limit = 18): Promise<{
  description: string;
  goalTitle: string;
  outcomeText: string | null;
  completedAt: Date;
}[]> {
  const { rows } = await getPool().query<{
    description: string;
    goal_title: string;
    outcome_text: string | null;
    completed_at: Date;
  }>(
    `SELECT ga.description, g.title AS goal_title, ga.outcome_text,
            COALESCE(ga.updated_at, ga.created_at) AS completed_at
     FROM brain.goal_actions ga
     JOIN brain.goals g ON g.id = ga.goal_id
     WHERE ga.status IN ('done', 'failed')
     ORDER BY ga.updated_at DESC
     LIMIT $1`,
    [limit]
  );
  return rows.map((r) => ({
    description: r.description,
    goalTitle: r.goal_title,
    outcomeText: r.outcome_text,
    completedAt: r.completed_at,
  }));
}

/**
 * Legacy recovery — used by the old recoverStaleGoalActions callers.
 * Returns the total count of recovered actions for backward compatibility.
 * @deprecated Use recoverStaleGoalActions() and handle the recovery arrays instead.
 */
export async function recoverStaleGoalActionsLegacyCount(): Promise<number> {
  const recovery = await recoverStaleGoalActions();
  return recovery.needsReview.length + recovery.needsRestart.length + recovery.needsReviewerRespawn.length;
}

/**
 * Fail a single executing goal_action by job_id. Called by the heartbeat monitor
 * when it marks a job as unresponsive, to unblock the goal cycle.
 */
export async function failExecutingGoalActionByJobId(jobId: string, reason: string): Promise<boolean> {
  const result = await getPool().query(
    `UPDATE brain.goal_actions
     SET status = 'failed',
         outcome_text = $1,
         updated_at = now()
     WHERE job_id = $2 AND status = 'executing'`,
    [reason.slice(0, 1000), jobId]
  );
  return (result.rowCount ?? 0) > 0;
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
