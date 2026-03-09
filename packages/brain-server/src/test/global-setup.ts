/**
 * Vitest Global Setup — runs once in the main process before any test workers start.
 *
 * Creates the brain_test schema and all required tables so test workers can
 * run against isolated data. The brain_test schema mirrors brain but is
 * completely separate from production data.
 */

import pg from 'pg';

const { Pool } = pg;

const TEST_SCHEMA = 'brain_test';

export async function setup(): Promise<void> {
  const connectionString = process.env.JANE_DATABASE_URL;
  if (!connectionString) {
    throw new Error('JANE_DATABASE_URL is required for tests');
  }

  const pool = new Pool({ connectionString });

  try {
    // Create the test schema
    await pool.query(`CREATE SCHEMA IF NOT EXISTS ${TEST_SCHEMA}`);

    // agent_jobs must be created first (goal_actions references it)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${TEST_SCHEMA}.agent_jobs (
        id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        job_type             TEXT NOT NULL DEFAULT 'task',
        status               TEXT NOT NULL DEFAULT 'queued',
        prompt               TEXT NOT NULL,
        context_json         JSONB NOT NULL DEFAULT '{}',
        pid                  INTEGER,
        worktree_path        TEXT,
        scratch_dir          TEXT,
        output_file          TEXT,
        result_text          TEXT,
        nats_reply_subject   TEXT,
        session_id           UUID,
        created_at           TIMESTAMPTZ DEFAULT now(),
        updated_at           TIMESTAMPTZ DEFAULT now(),
        started_at           TIMESTAMPTZ,
        completed_at         TIMESTAMPTZ,
        last_heartbeat_at    TIMESTAMPTZ,
        last_activity_at     TIMESTAMPTZ,
        retry_count          INTEGER NOT NULL DEFAULT 0,
        error_message        TEXT
      )
    `);

    // goals (self-referencing FK)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${TEST_SCHEMA}.goals (
        id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        title            TEXT NOT NULL,
        description      TEXT NOT NULL,
        motivation       TEXT,
        level            TEXT NOT NULL CHECK (level IN ('asymptotic','strategic','tactical','operational')),
        priority         INTEGER NOT NULL DEFAULT 50 CHECK (priority BETWEEN 1 AND 100),
        status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','achieved','abandoned')),
        parent_id        UUID REFERENCES ${TEST_SCHEMA}.goals(id),
        success_criteria TEXT,
        progress_notes   TEXT,
        last_evaluated_at TIMESTAMPTZ,
        created_at       TIMESTAMPTZ DEFAULT now(),
        updated_at       TIMESTAMPTZ DEFAULT now()
      )
    `);

    // goal_actions
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${TEST_SCHEMA}.goal_actions (
        id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        goal_id      UUID NOT NULL REFERENCES ${TEST_SCHEMA}.goals(id),
        cycle_id     UUID,
        description  TEXT NOT NULL,
        rationale    TEXT,
        status       TEXT NOT NULL DEFAULT 'proposed'
                     CHECK (status IN ('proposed','selected','executing','reviewing','done','failed','rejected')),
        score        NUMERIC(5,2),
        job_id       UUID REFERENCES ${TEST_SCHEMA}.agent_jobs(id),
        outcome_text TEXT,
        review_text  TEXT,
        review_job_id UUID REFERENCES ${TEST_SCHEMA}.agent_jobs(id),
        created_at   TIMESTAMPTZ DEFAULT now(),
        updated_at   TIMESTAMPTZ DEFAULT now()
      )
    `);

    // goal_cycles
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${TEST_SCHEMA}.goal_cycles (
        id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        status               TEXT NOT NULL DEFAULT 'running'
                             CHECK (status IN ('running','done','failed')),
        goals_assessed       INTEGER NOT NULL DEFAULT 0,
        candidates_generated INTEGER NOT NULL DEFAULT 0,
        action_selected_id   UUID REFERENCES ${TEST_SCHEMA}.goal_actions(id),
        cycle_notes          TEXT,
        started_at           TIMESTAMPTZ DEFAULT now(),
        completed_at         TIMESTAMPTZ
      )
    `);

    // memories
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${TEST_SCHEMA}.memories (
        id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        type             TEXT NOT NULL CHECK (type IN ('episodic','semantic','procedural','working')),
        source           TEXT NOT NULL CHECK (source IN ('goal_cycle','job_completion','layer_event','consolidation','manual','reflection')),
        title            TEXT NOT NULL,
        content          TEXT NOT NULL,
        tags             JSONB NOT NULL DEFAULT '[]',
        importance       NUMERIC(4,3) NOT NULL DEFAULT 0.5 CHECK (importance BETWEEN 0 AND 1),
        metadata         JSONB NOT NULL DEFAULT '{}',
        created_at       TIMESTAMPTZ DEFAULT now(),
        last_accessed_at TIMESTAMPTZ DEFAULT now(),
        access_count     INTEGER NOT NULL DEFAULT 0,
        expires_at       TIMESTAMPTZ
      )
    `);

    // memory_patterns
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${TEST_SCHEMA}.memory_patterns (
        id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        pattern_type        TEXT NOT NULL,
        description         TEXT NOT NULL,
        evidence_count      INTEGER NOT NULL DEFAULT 1,
        confidence          NUMERIC(4,3) NOT NULL DEFAULT 0.5 CHECK (confidence BETWEEN 0 AND 1),
        example_memory_ids  JSONB NOT NULL DEFAULT '[]',
        created_at          TIMESTAMPTZ DEFAULT now(),
        last_reinforced_at  TIMESTAMPTZ DEFAULT now()
      )
    `);

    // layer_events
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${TEST_SCHEMA}.layer_events (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        layer       TEXT NOT NULL,
        event_type  TEXT NOT NULL,
        severity    TEXT,
        payload     JSONB NOT NULL DEFAULT '{}',
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    // layer_directives
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${TEST_SCHEMA}.layer_directives (
        id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        target_layer TEXT NOT NULL,
        directive    TEXT NOT NULL,
        params       JSONB NOT NULL DEFAULT '{}',
        status       TEXT NOT NULL DEFAULT 'pending',
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        applied_at   TIMESTAMPTZ
      )
    `);

    // scheduler_state
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ${TEST_SCHEMA}.scheduler_state (
        key        TEXT PRIMARY KEY,
        value      JSONB NOT NULL DEFAULT '{}',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    // Indexes
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_test_goals_status ON ${TEST_SCHEMA}.goals (status)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_test_goals_level  ON ${TEST_SCHEMA}.goals (level)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_test_goal_actions_goal ON ${TEST_SCHEMA}.goal_actions (goal_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_test_goal_cycles_started ON ${TEST_SCHEMA}.goal_cycles (started_at DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_test_memories_type ON ${TEST_SCHEMA}.memories (type)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_test_memories_importance ON ${TEST_SCHEMA}.memories (importance DESC)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_test_layer_events_layer ON ${TEST_SCHEMA}.layer_events (layer)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_test_layer_directives_status ON ${TEST_SCHEMA}.layer_directives (status)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_test_jobs_status ON ${TEST_SCHEMA}.agent_jobs (status)`);

    console.log(`[test global-setup] brain_test schema ready`);
  } finally {
    await pool.end();
  }
}

export async function teardown(): Promise<void> {
  // Leave brain_test schema in place for inspection after failures.
  // Tables are isolated from production — no cleanup needed.
}
