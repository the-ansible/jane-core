/**
 * Ingestion Log — tracks which session chunks have been ingested into Graphiti.
 * Prevents re-ingestion on restart and supports backfill status tracking.
 */

import pg from 'pg';

const { Pool } = pg;

let pool: pg.Pool | null = null;

function getPool(): pg.Pool {
  if (pool) return pool;
  const connectionString = process.env.JANE_DATABASE_URL;
  if (!connectionString) throw new Error('JANE_DATABASE_URL is required');
  pool = new Pool({ connectionString });
  return pool;
}

export interface IngestionLogEntry {
  id: string;
  session_id: string;
  graphiti_episode_id: string | null;
  message_count: number;
  ts_start: string | null;
  ts_end: string | null;
  ingested_at: string;
  status: 'success' | 'failed';
  error: string | null;
}

export async function initIngestionLog(): Promise<void> {
  const p = getPool();

  await p.query(`
    CREATE TABLE IF NOT EXISTS brain.memory_ingestion_log (
      id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      session_id          TEXT NOT NULL,
      graphiti_episode_id TEXT,
      message_count       INT NOT NULL DEFAULT 0,
      ts_start            TIMESTAMPTZ,
      ts_end              TIMESTAMPTZ,
      ingested_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
      status              TEXT NOT NULL DEFAULT 'success' CHECK (status IN ('success', 'failed')),
      error               TEXT
    )
  `);

  await p.query(`
    CREATE INDEX IF NOT EXISTS idx_ingestion_log_session
      ON brain.memory_ingestion_log (session_id, ingested_at DESC)
  `);

  log('info', 'Ingestion log initialized');
}

export async function recordIngestion(params: {
  sessionId: string;
  graphitiEpisodeId: string | null;
  messageCount: number;
  tsStart: string | null;
  tsEnd: string | null;
  status: 'success' | 'failed';
  error?: string;
}): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO brain.memory_ingestion_log
       (session_id, graphiti_episode_id, message_count, ts_start, ts_end, status, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      params.sessionId,
      params.graphitiEpisodeId,
      params.messageCount,
      params.tsStart,
      params.tsEnd,
      params.status,
      params.error ?? null,
    ]
  );
  return rows[0].id;
}

export async function getIngestionHistory(sessionId: string): Promise<IngestionLogEntry[]> {
  const { rows } = await getPool().query<IngestionLogEntry>(
    `SELECT * FROM brain.memory_ingestion_log
     WHERE session_id = $1
     ORDER BY ingested_at DESC`,
    [sessionId]
  );
  return rows;
}

export async function countIngestedSessions(): Promise<number> {
  const { rows } = await getPool().query<{ count: string }>(
    `SELECT COUNT(DISTINCT session_id) AS count
     FROM brain.memory_ingestion_log
     WHERE status = 'success'`
  );
  return parseInt(rows[0].count, 10);
}

export async function getIngestedSessionIds(): Promise<Set<string>> {
  const { rows } = await getPool().query<{ session_id: string }>(
    `SELECT DISTINCT session_id FROM brain.memory_ingestion_log WHERE status = 'success'`
  );
  return new Set(rows.map((r) => r.session_id));
}

export function _resetPool(): void {
  pool = null;
}

function log(level: string, msg: string, extra?: Record<string, unknown>): void {
  console.log(
    JSON.stringify({ level, msg, component: 'ingestion-log', ts: new Date().toISOString(), ...extra })
  );
}
