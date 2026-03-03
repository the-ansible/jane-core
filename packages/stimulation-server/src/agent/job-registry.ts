/**
 * Agent Job Registry — PostgreSQL-backed persistence for agent job state.
 * Enables recovery of in-flight jobs across server restarts.
 */

import pg from 'pg';

const { Pool } = pg;

let pool: pg.Pool | null = null;

function getPool(): pg.Pool {
  if (pool) return pool;
  const connectionString = process.env.JANE_DATABASE_URL;
  if (!connectionString) throw new Error('JANE_DATABASE_URL environment variable is required');
  pool = new Pool({ connectionString });
  return pool;
}

export const jobDb = {
  async query<T extends Record<string, any> = any>(
    sql: string,
    params?: any[]
  ): Promise<{ rows: T[] }> {
    const result = await getPool().query<T>(sql, params);
    return { rows: result.rows };
  },
};

export interface AgentJob {
  id: string;
  session_id: string;
  pid: number | null;
  status: string;
  command: string;
  context_json: any;
  output_file: string | null;
  created_at: Date;
  updated_at: Date;
  last_heartbeat_at: Date | null;
  outbound_published_at: Date | null;
  retry_count: number;
  error_message: string | null;
}

export async function initJobRegistry(): Promise<void> {
  const p = getPool();
  await p.query('CREATE SCHEMA IF NOT EXISTS stimulation');
  await p.query(`
    CREATE TABLE IF NOT EXISTS stimulation.agent_jobs (
      id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      session_id            TEXT NOT NULL,
      pid                   INTEGER,
      status                TEXT NOT NULL DEFAULT 'queued',
      command               TEXT NOT NULL,
      context_json          JSONB NOT NULL,
      output_file           TEXT,
      created_at            TIMESTAMPTZ DEFAULT now(),
      updated_at            TIMESTAMPTZ DEFAULT now(),
      last_heartbeat_at     TIMESTAMPTZ,
      outbound_published_at TIMESTAMPTZ,
      retry_count           INTEGER NOT NULL DEFAULT 0,
      error_message         TEXT
    )
  `);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_agent_jobs_status ON stimulation.agent_jobs (status)`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_agent_jobs_session ON stimulation.agent_jobs (session_id)`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_agent_jobs_created ON stimulation.agent_jobs (created_at)`);

  console.log(JSON.stringify({
    level: 'info',
    msg: 'Agent job registry initialized',
    component: 'job-registry',
    ts: new Date().toISOString(),
  }));
}

export async function createJob(params: {
  sessionId: string;
  command: string;
  contextJson: object;
  outputFile: string;
}): Promise<string> {
  const { rows } = await jobDb.query<{ id: string }>(
    `INSERT INTO stimulation.agent_jobs (session_id, status, command, context_json, output_file)
     VALUES ($1, 'queued', $2, $3, $4) RETURNING id`,
    [params.sessionId, params.command, JSON.stringify(params.contextJson), params.outputFile]
  );
  return rows[0].id;
}

export async function markJobCompleted(jobId: string): Promise<void> {
  await jobDb.query(
    `UPDATE stimulation.agent_jobs
     SET status = 'completed', outbound_published_at = now(), updated_at = now()
     WHERE id = $1`,
    [jobId]
  );
}

export async function markJobFailed(jobId: string, error: string): Promise<void> {
  await jobDb.query(
    `UPDATE stimulation.agent_jobs
     SET status = 'failed', error_message = $1, updated_at = now()
     WHERE id = $2`,
    [error, jobId]
  );
}

export async function markJobDeadLetter(jobId: string, error: string): Promise<void> {
  await jobDb.query(
    `UPDATE stimulation.agent_jobs
     SET status = 'dead_letter', error_message = $1, updated_at = now()
     WHERE id = $2`,
    [error, jobId]
  );
}

export async function getStaleJobs(): Promise<AgentJob[]> {
  const { rows } = await jobDb.query<AgentJob>(
    `SELECT * FROM stimulation.agent_jobs
     WHERE status IN ('running', 'queued', 'agent_done')
     AND created_at > now() - interval '2 hours'
     ORDER BY created_at ASC`
  );
  return rows;
}

export async function requeueJob(jobId: string): Promise<void> {
  await jobDb.query(
    `UPDATE stimulation.agent_jobs
     SET status = 'queued', pid = null, retry_count = retry_count + 1, updated_at = now()
     WHERE id = $1`,
    [jobId]
  );
}

export async function getJobById(jobId: string): Promise<AgentJob | null> {
  const { rows } = await jobDb.query<AgentJob>(
    `SELECT * FROM stimulation.agent_jobs WHERE id = $1`,
    [jobId]
  );
  return rows[0] || null;
}

export interface PanicResult {
  clearedQueued: number;
  clearedRunning: number;
  killedPids: number[];
}

/**
 * Panic clear: mark stuck jobs as failed.
 * Always clears queued + recovered + agent_done. Optionally kills running job PIDs too.
 */
export async function panicClearJobs(includeRunning: boolean): Promise<PanicResult> {
  // Mark queued + recovered + agent_done as failed
  const { rows: clearedRows } = await jobDb.query<{ id: string }>(
    `UPDATE stimulation.agent_jobs
     SET status = 'failed', error_message = 'panic_button', updated_at = now()
     WHERE status IN ('queued', 'recovered', 'agent_done')
     RETURNING id`,
  );

  let killedPids: number[] = [];
  let clearedRunning = 0;

  if (includeRunning) {
    const { rows: runningRows } = await jobDb.query<{ id: string; pid: number | null }>(
      `UPDATE stimulation.agent_jobs
       SET status = 'failed', error_message = 'panic_button (forced)', updated_at = now()
       WHERE status = 'running'
       RETURNING id, pid`,
    );
    clearedRunning = runningRows.length;

    for (const row of runningRows) {
      if (row.pid) {
        try {
          process.kill(row.pid, 'SIGKILL');
          killedPids.push(row.pid);
        } catch {
          // Process may already be gone — that's fine
        }
      }
    }
  }

  return {
    clearedQueued: clearedRows.length,
    clearedRunning,
    killedPids,
  };
}

/** For testing: reset pool */
export function _resetJobPool(): void {
  pool = null;
}
