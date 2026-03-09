/**
 * Brain Job Registry — PostgreSQL persistence for agent job lifecycle.
 * Schema: ${SCHEMA}.agent_jobs
 */

import pg from 'pg';
import type { AgentJob, JobStatus, JobType } from './types.js';

const { Pool } = pg;

const SCHEMA = process.env.BRAIN_SCHEMA ?? 'brain';

let pool: pg.Pool | null = null;

function getPool(): pg.Pool {
  if (pool) return pool;
  const connectionString = process.env.JANE_DATABASE_URL;
  if (!connectionString) throw new Error('JANE_DATABASE_URL is required');
  pool = new Pool({ connectionString });
  return pool;
}

export async function initJobRegistry(): Promise<void> {
  const p = getPool();
  await p.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
  await p.query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.agent_jobs (
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
  // Add session_id column if not present (executor integration)
  await p.query(`
    DO $$ BEGIN
      ALTER TABLE ${SCHEMA}.agent_jobs ADD COLUMN IF NOT EXISTS session_id UUID;
    EXCEPTION WHEN duplicate_column THEN NULL;
    END $$
  `);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_brain_jobs_status ON ${SCHEMA}.agent_jobs (status)`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_brain_jobs_created ON ${SCHEMA}.agent_jobs (created_at DESC)`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_brain_jobs_session ON ${SCHEMA}.agent_jobs (session_id) WHERE session_id IS NOT NULL`);

  log('info', 'Brain job registry initialized');
}

export async function createJob(params: {
  jobType: JobType;
  prompt: string;
  contextJson: Record<string, unknown>;
  natsReplySubject?: string;
}): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO ${SCHEMA}.agent_jobs (job_type, status, prompt, context_json, nats_reply_subject)
     VALUES ($1, 'queued', $2, $3, $4)
     RETURNING id`,
    [params.jobType, params.prompt, JSON.stringify(params.contextJson), params.natsReplySubject ?? null]
  );
  return rows[0].id;
}

export async function markJobRunning(jobId: string, pid: number, opts?: {
  worktreePath?: string;
  scratchDir?: string;
  outputFile?: string;
}): Promise<void> {
  await getPool().query(
    `UPDATE ${SCHEMA}.agent_jobs
     SET status = 'running', pid = $1, started_at = now(), last_activity_at = now(), updated_at = now(),
         worktree_path = $2, scratch_dir = $3, output_file = $4
     WHERE id = $5`,
    [pid, opts?.worktreePath ?? null, opts?.scratchDir ?? null, opts?.outputFile ?? null, jobId]
  );
}

export async function updateHeartbeat(jobId: string): Promise<void> {
  await getPool().query(
    `UPDATE ${SCHEMA}.agent_jobs
     SET last_heartbeat_at = now(), last_activity_at = now(), updated_at = now()
     WHERE id = $1`,
    [jobId]
  );
}

export async function markJobDone(jobId: string, resultText: string): Promise<void> {
  await getPool().query(
    `UPDATE ${SCHEMA}.agent_jobs
     SET status = 'done', result_text = $1, completed_at = now(), pid = null, updated_at = now()
     WHERE id = $2`,
    [resultText, jobId]
  );
}

export async function markJobFailed(jobId: string, error: string): Promise<void> {
  await getPool().query(
    `UPDATE ${SCHEMA}.agent_jobs
     SET status = 'failed', error_message = $1, completed_at = now(), pid = null, updated_at = now()
     WHERE id = $2`,
    [error, jobId]
  );
}

export async function markJobUnresponsive(jobId: string): Promise<void> {
  await getPool().query(
    `UPDATE ${SCHEMA}.agent_jobs
     SET status = 'unresponsive', updated_at = now()
     WHERE id = $1`,
    [jobId]
  );
}

export async function killJob(jobId: string): Promise<{ pid: number | null }> {
  const { rows } = await getPool().query<{ pid: number | null }>(
    `UPDATE ${SCHEMA}.agent_jobs
     SET status = 'failed', error_message = 'manually_killed', completed_at = now(), updated_at = now()
     WHERE id = $1
     RETURNING pid`,
    [jobId]
  );
  return { pid: rows[0]?.pid ?? null };
}

export async function getJob(jobId: string): Promise<AgentJob | null> {
  const { rows } = await getPool().query<AgentJob>(
    `SELECT * FROM ${SCHEMA}.agent_jobs WHERE id = $1`,
    [jobId]
  );
  return rows[0] ?? null;
}

export async function listJobs(limit = 50): Promise<AgentJob[]> {
  const { rows } = await getPool().query<AgentJob>(
    `SELECT * FROM ${SCHEMA}.agent_jobs ORDER BY created_at DESC LIMIT $1`,
    [limit]
  );
  return rows;
}

export async function getRunningJobs(): Promise<AgentJob[]> {
  const { rows } = await getPool().query<AgentJob>(
    `SELECT * FROM ${SCHEMA}.agent_jobs WHERE status = 'running' ORDER BY created_at ASC`
  );
  return rows;
}

export async function updateJobStatus(jobId: string, status: JobStatus): Promise<void> {
  await getPool().query(
    `UPDATE ${SCHEMA}.agent_jobs SET status = $1, updated_at = now() WHERE id = $2`,
    [status, jobId]
  );
}

function log(level: string, msg: string, extra?: Record<string, unknown>): void {
  console.log(JSON.stringify({ level, msg, component: 'brain-registry', ts: new Date().toISOString(), ...extra }));
}

/** For testing */
export function _resetPool(): void {
  pool = null;
}
