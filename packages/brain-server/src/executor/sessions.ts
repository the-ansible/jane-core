/**
 * Session registry — tracks session hierarchy for sub-session context inheritance.
 *
 * Records sessions and their parent relationships in brain.sessions.
 * The parent-session context module reads from this table to provide
 * sub-sessions with awareness of the broader context they were spawned from.
 */

import pg from 'pg';

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

// ---------------------------------------------------------------------------
// Schema init
// ---------------------------------------------------------------------------

export async function initSessionsSchema(): Promise<void> {
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.sessions (
      id             UUID PRIMARY KEY,
      parent_id      UUID REFERENCES ${SCHEMA}.sessions(id) ON DELETE SET NULL,
      metadata       JSONB NOT NULL DEFAULT '{}',
      status         TEXT NOT NULL DEFAULT 'active',
      created_at     TIMESTAMPTZ DEFAULT now(),
      last_active_at TIMESTAMPTZ DEFAULT now()
    )
  `);
  log('info', 'Sessions schema initialized');
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

/**
 * Register a session, optionally with a parent session.
 * Idempotent — safe to call multiple times for the same session.
 */
export async function registerSession(
  sessionId: string,
  parentSessionId?: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  await getPool().query(`
    INSERT INTO ${SCHEMA}.sessions (id, parent_id, metadata, last_active_at)
    VALUES ($1, $2, $3, now())
    ON CONFLICT (id) DO UPDATE SET
      last_active_at = now(),
      metadata = COALESCE(NULLIF($3::jsonb, '{}'::jsonb), ${SCHEMA}.sessions.metadata)
  `, [sessionId, parentSessionId ?? null, JSON.stringify(metadata ?? {})]);
}

/**
 * Get the parent session ID for a session, or null if it has no parent.
 */
export async function getParentSessionId(sessionId: string): Promise<string | null> {
  const { rows } = await getPool().query<{ parent_id: string | null }>(
    `SELECT parent_id FROM ${SCHEMA}.sessions WHERE id = $1`,
    [sessionId],
  );
  return rows[0]?.parent_id ?? null;
}

/**
 * Get session info, or null if not found.
 */
export async function getSession(sessionId: string): Promise<{
  id: string;
  parentId: string | null;
  status: string;
  createdAt: string;
  lastActiveAt: string;
  metadata: Record<string, unknown>;
} | null> {
  const { rows } = await getPool().query<{
    id: string;
    parent_id: string | null;
    status: string;
    created_at: string;
    last_active_at: string;
    metadata: Record<string, unknown>;
  }>(
    `SELECT id, parent_id, status, created_at, last_active_at, metadata
     FROM ${SCHEMA}.sessions WHERE id = $1`,
    [sessionId],
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    id: r.id,
    parentId: r.parent_id,
    status: r.status,
    createdAt: r.created_at,
    lastActiveAt: r.last_active_at,
    metadata: r.metadata,
  };
}

export interface SessionInfo {
  id: string;
  parentId: string | null;
  status: string;
  createdAt: string;
  lastActiveAt: string;
  metadata: Record<string, unknown>;
}

/**
 * List sessions, optionally filtered by status.
 * Returns newest first, capped at 100.
 */
export async function listSessions(opts?: {
  status?: string;
  parentId?: string | null;
  limit?: number;
}): Promise<SessionInfo[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (opts?.status) {
    params.push(opts.status);
    conditions.push(`status = $${params.length}`);
  }
  if (opts?.parentId !== undefined) {
    if (opts.parentId === null) {
      conditions.push('parent_id IS NULL');
    } else {
      params.push(opts.parentId);
      conditions.push(`parent_id = $${params.length}`);
    }
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = opts?.limit ?? 100;
  params.push(limit);

  const { rows } = await getPool().query<{
    id: string;
    parent_id: string | null;
    status: string;
    created_at: string;
    last_active_at: string;
    metadata: Record<string, unknown>;
  }>(
    `SELECT id, parent_id, status, created_at, last_active_at, metadata
     FROM ${SCHEMA}.sessions
     ${where}
     ORDER BY last_active_at DESC
     LIMIT $${params.length}`,
    params,
  );

  return rows.map(r => ({
    id: r.id,
    parentId: r.parent_id,
    status: r.status,
    createdAt: r.created_at,
    lastActiveAt: r.last_active_at,
    metadata: r.metadata,
  }));
}

/**
 * List child sessions for a given parent.
 */
export async function listChildSessions(parentSessionId: string): Promise<SessionInfo[]> {
  return listSessions({ parentId: parentSessionId });
}

/**
 * Close a session (mark status = 'closed').
 */
export async function closeSession(sessionId: string): Promise<void> {
  await getPool().query(
    `UPDATE ${SCHEMA}.sessions SET status = 'closed', last_active_at = now() WHERE id = $1`,
    [sessionId],
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(level: string, msg: string, extra?: Record<string, unknown>): void {
  console.log(JSON.stringify({ level, msg, component: 'sessions', ts: new Date().toISOString(), ...extra }));
}

/** For testing */
export function _resetPool(): void {
  pool = null;
}
