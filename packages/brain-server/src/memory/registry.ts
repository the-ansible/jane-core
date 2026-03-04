/**
 * Memory Registry — PostgreSQL persistence for Jane's memory system.
 *
 * Tables:
 *   brain.memories         — episodic, semantic, procedural, working memories
 *   brain.memory_patterns  — learned patterns extracted by the consolidator
 */

import pg from 'pg';
import type { Memory, MemoryPattern, MemoryInput, MemoryType, MemorySource } from './types.js';

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

export async function initMemoryRegistry(): Promise<void> {
  const p = getPool();

  await p.query(`
    CREATE TABLE IF NOT EXISTS brain.memories (
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

  await p.query(`
    CREATE TABLE IF NOT EXISTS brain.memory_patterns (
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

  await p.query(`CREATE INDEX IF NOT EXISTS idx_memories_type       ON brain.memories (type)`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_memories_source     ON brain.memories (source)`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_memories_importance ON brain.memories (importance DESC)`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_memories_created    ON brain.memories (created_at DESC)`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_memories_expires    ON brain.memories (expires_at) WHERE expires_at IS NOT NULL`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_memory_patterns_type ON brain.memory_patterns (pattern_type)`);

  log('info', 'Memory registry initialized');
}

// ---------------------------------------------------------------------------
// Memories — CRUD
// ---------------------------------------------------------------------------

export async function recordMemory(input: MemoryInput): Promise<string> {
  const expiresAt = input.expiresInMs
    ? new Date(Date.now() + input.expiresInMs)
    : null;

  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO brain.memories (type, source, title, content, tags, importance, metadata, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      input.type,
      input.source,
      input.title,
      input.content,
      JSON.stringify(input.tags ?? []),
      input.importance ?? 0.5,
      JSON.stringify(input.metadata ?? {}),
      expiresAt,
    ]
  );

  log('debug', 'Memory recorded', { id: rows[0].id, type: input.type, source: input.source, title: input.title });
  return rows[0].id;
}

export async function getMemory(id: string): Promise<Memory | null> {
  const { rows } = await getPool().query<Memory>(
    `UPDATE brain.memories
     SET last_accessed_at = now(), access_count = access_count + 1
     WHERE id = $1
     RETURNING *`,
    [id]
  );
  return rows[0] ?? null;
}

export async function listMemories(opts: {
  type?: MemoryType;
  source?: MemorySource;
  tags?: string[];
  minImportance?: number;
  limit?: number;
  includeExpired?: boolean;
} = {}): Promise<Memory[]> {
  const conditions: string[] = [];
  const vals: unknown[] = [];
  let i = 1;

  if (!opts.includeExpired) {
    conditions.push(`(expires_at IS NULL OR expires_at > now())`);
  }
  if (opts.type) {
    conditions.push(`type = $${i++}`);
    vals.push(opts.type);
  }
  if (opts.source) {
    conditions.push(`source = $${i++}`);
    vals.push(opts.source);
  }
  if (opts.minImportance !== undefined) {
    conditions.push(`importance >= $${i++}`);
    vals.push(opts.minImportance);
  }
  if (opts.tags && opts.tags.length > 0) {
    conditions.push(`tags ?| $${i++}`);
    vals.push(opts.tags);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = Math.min(opts.limit ?? 50, 500);
  vals.push(limit);

  const { rows } = await getPool().query<Memory>(
    `SELECT * FROM brain.memories ${where} ORDER BY importance DESC, created_at DESC LIMIT $${i}`,
    vals
  );
  return rows;
}

export async function searchMemories(query: string, limit = 20): Promise<Memory[]> {
  // Full-text keyword search across title + content
  const { rows } = await getPool().query<Memory>(
    `SELECT *, ts_rank(
       to_tsvector('english', title || ' ' || content),
       plainto_tsquery('english', $1)
     ) AS rank
     FROM brain.memories
     WHERE (expires_at IS NULL OR expires_at > now())
       AND to_tsvector('english', title || ' ' || content) @@ plainto_tsquery('english', $1)
     ORDER BY rank DESC, importance DESC
     LIMIT $2`,
    [query, limit]
  );
  return rows;
}

export async function updateMemoryImportance(id: string, importance: number): Promise<void> {
  await getPool().query(
    `UPDATE brain.memories SET importance = $1 WHERE id = $2`,
    [Math.max(0, Math.min(1, importance)), id]
  );
}

export async function deleteMemory(id: string): Promise<boolean> {
  const { rowCount } = await getPool().query(
    `DELETE FROM brain.memories WHERE id = $1`,
    [id]
  );
  return (rowCount ?? 0) > 0;
}

export async function purgeExpiredMemories(): Promise<number> {
  const { rowCount } = await getPool().query(
    `DELETE FROM brain.memories WHERE expires_at IS NOT NULL AND expires_at <= now()`
  );
  const count = rowCount ?? 0;
  if (count > 0) log('info', 'Purged expired memories', { count });
  return count;
}

export async function countMemories(): Promise<number> {
  const { rows } = await getPool().query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM brain.memories WHERE expires_at IS NULL OR expires_at > now()`
  );
  return parseInt(rows[0].count, 10);
}

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

export async function recordPattern(params: {
  patternType: string;
  description: string;
  confidence: number;
  exampleMemoryIds?: string[];
}): Promise<string> {
  // Upsert by description (avoid duplicates)
  const existing = await getPool().query<{ id: string; evidence_count: number }>(
    `SELECT id, evidence_count FROM brain.memory_patterns WHERE description = $1 LIMIT 1`,
    [params.description]
  );

  if (existing.rows[0]) {
    const { id, evidence_count } = existing.rows[0];
    const newConfidence = Math.min(1, (params.confidence + existing.rows[0].evidence_count * 0.1) / (1 + 0.1));
    await getPool().query(
      `UPDATE brain.memory_patterns
       SET evidence_count = $1, confidence = $2, last_reinforced_at = now(),
           example_memory_ids = COALESCE(
             (
               SELECT jsonb_agg(v) FROM (
                 SELECT jsonb_array_elements_text(example_memory_ids) AS v
                 UNION
                 SELECT unnest($3::text[]) AS v
                 LIMIT 5
               ) sub
             ),
             '[]'::jsonb
           )
       WHERE id = $4`,
      [evidence_count + 1, newConfidence, params.exampleMemoryIds ?? [], id]
    );
    return id;
  }

  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO brain.memory_patterns (pattern_type, description, confidence, example_memory_ids)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [
      params.patternType,
      params.description,
      params.confidence,
      JSON.stringify(params.exampleMemoryIds ?? []),
    ]
  );
  return rows[0].id;
}

export async function listPatterns(opts: {
  patternType?: string;
  minConfidence?: number;
  limit?: number;
} = {}): Promise<MemoryPattern[]> {
  const conditions: string[] = [];
  const vals: unknown[] = [];
  let i = 1;

  if (opts.patternType) { conditions.push(`pattern_type = $${i++}`); vals.push(opts.patternType); }
  if (opts.minConfidence !== undefined) { conditions.push(`confidence >= $${i++}`); vals.push(opts.minConfidence); }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  vals.push(Math.min(opts.limit ?? 50, 200));

  const { rows } = await getPool().query<MemoryPattern>(
    `SELECT * FROM brain.memory_patterns ${where} ORDER BY confidence DESC, evidence_count DESC LIMIT $${i}`,
    vals
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Decay — reduce importance of old, unaccessed memories
// ---------------------------------------------------------------------------

export async function applyImportanceDecay(opts: {
  olderThanDays?: number;
  maxAccessCount?: number;
  decayFactor?: number;
} = {}): Promise<number> {
  const olderThan = opts.olderThanDays ?? 30;
  const maxAccess = opts.maxAccessCount ?? 2;
  const decay = opts.decayFactor ?? 0.1;

  const { rowCount } = await getPool().query(
    `UPDATE brain.memories
     SET importance = GREATEST(0, importance - $1)
     WHERE created_at < now() - interval '${olderThan} days'
       AND access_count <= $2
       AND type = 'episodic'
       AND importance > 0.1`,
    [decay, maxAccess]
  );
  return rowCount ?? 0;
}

export function _resetPool(): void {
  pool = null;
}

function log(level: string, msg: string, extra?: Record<string, unknown>): void {
  console.log(JSON.stringify({ level, msg, component: 'memory-registry', ts: new Date().toISOString(), ...extra }));
}
