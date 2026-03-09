/**
 * Communication Context DB -- schema management for summaries, plans, and assembly logs.
 * Uses the `brain` schema alongside existing brain tables.
 */

import pg from 'pg';

const { Pool } = pg;

let pool: pg.Pool | null = null;

function getPool(): pg.Pool {
  if (pool) return pool;
  const connectionString = process.env.JANE_DATABASE_URL;
  if (!connectionString) {
    throw new Error('JANE_DATABASE_URL environment variable is required');
  }
  pool = new Pool({ connectionString });
  return pool;
}

const SCHEMA = 'brain';

export const db = {
  async query<T extends Record<string, any> = any>(
    sql: string,
    params?: any[]
  ): Promise<{ rows: T[] }> {
    const result = await getPool().query<T>(sql, params);
    return { rows: result.rows };
  },
  async exec(sql: string): Promise<void> {
    await getPool().query(sql);
  },
};

const BASELINE_PLAN = {
  summaryChunkSize: 6,
  summaryModel: 'haiku',
  summaryPromptTemplate: 'default_v1',
  rawSummarizationThreshold: 12,
  maxSummaries: 10,
  modelContextSize: 200000,
  tokenBudgetPct: 0.06,
  composer: {
    maxSummaries: 3,
    tokenBudgetPct: 0.02,
  },
  topicTrackingEnabled: false,
  associativeRetrievalEnabled: false,
};

export async function initCommContextSchema(): Promise<void> {
  const p = getPool();

  // Ensure brain schema exists (should already from other brain modules)
  await p.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.comm_summaries (
      id            UUID PRIMARY KEY,
      session_id    TEXT NOT NULL,
      summary       TEXT NOT NULL,
      topics        TEXT[] NOT NULL DEFAULT '{}',
      entities      TEXT[] NOT NULL DEFAULT '{}',
      msg_start_idx INT NOT NULL,
      msg_end_idx   INT NOT NULL,
      msg_count     INT NOT NULL,
      ts_start      TIMESTAMPTZ NOT NULL,
      ts_end        TIMESTAMPTZ NOT NULL,
      model         TEXT NOT NULL,
      prompt_tokens INT,
      output_tokens INT,
      latency_ms    INT,
      plan_name     TEXT NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await db.exec(`CREATE INDEX IF NOT EXISTS idx_comm_summaries_session ON ${SCHEMA}.comm_summaries (session_id)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_comm_summaries_topics ON ${SCHEMA}.comm_summaries USING GIN (topics)`);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.comm_plans (
      name          TEXT PRIMARY KEY,
      config        JSONB NOT NULL,
      is_active     BOOLEAN NOT NULL DEFAULT FALSE,
      description   TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.comm_assembly_log (
      id                UUID PRIMARY KEY,
      session_id        TEXT NOT NULL,
      event_id          TEXT,
      plan_name         TEXT NOT NULL,
      summary_count     INT NOT NULL,
      raw_msg_count     INT NOT NULL,
      total_msg_coverage INT NOT NULL,
      estimated_tokens  INT NOT NULL,
      raw_tokens        INT NOT NULL,
      summary_tokens    INT NOT NULL,
      summary_budget    INT NOT NULL,
      budget_utilization REAL NOT NULL,
      raw_over_budget   BOOLEAN NOT NULL DEFAULT FALSE,
      assembly_ms       INT NOT NULL,
      summarization_ms  INT,
      pipeline_succeeded BOOLEAN,
      assembled_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await db.exec(`CREATE INDEX IF NOT EXISTS idx_comm_assembly_session ON ${SCHEMA}.comm_assembly_log (session_id)`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_comm_assembly_time ON ${SCHEMA}.comm_assembly_log (assembled_at)`);

  await db.exec(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'uq_comm_summaries_session_time'
      ) THEN
        ALTER TABLE ${SCHEMA}.comm_summaries
          ADD CONSTRAINT uq_comm_summaries_session_time UNIQUE (session_id, ts_end);
      END IF;
    END $$
  `);

  // Seed baseline plan if no plans exist
  const { rows } = await db.query<{ count: string }>(`SELECT count(*) as count FROM ${SCHEMA}.comm_plans`);
  if (parseInt(rows[0].count, 10) === 0) {
    await db.query(
      `INSERT INTO ${SCHEMA}.comm_plans (name, config, is_active, description)
       VALUES ($1, $2, TRUE, $3)`,
      [
        'baseline_v1',
        JSON.stringify(BASELINE_PLAN),
        'Initial baseline. 6-message summary chunks, Haiku model. Summarize when raw section exceeds 12 messages.',
      ]
    );
  }

  console.log(JSON.stringify({
    level: 'info',
    msg: 'Communication context DB initialized',
    component: 'comm.context',
    ts: new Date().toISOString(),
  }));
}

export async function updateAssemblyOutcome(assemblyLogId: string, succeeded: boolean): Promise<void> {
  await db.query(
    `UPDATE ${SCHEMA}.comm_assembly_log SET pipeline_succeeded = $1 WHERE id = $2`,
    [succeeded, assemblyLogId]
  );
}

export function _resetPool(): void {
  pool = null;
}
