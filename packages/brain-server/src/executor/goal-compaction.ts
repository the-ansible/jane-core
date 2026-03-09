/**
 * Goal session auto-compaction.
 *
 * When a goal session accumulates too many goal-action-snapshot entries in
 * context.summaries, compact the oldest N entries into a single summary. This
 * keeps the parent-session context module from growing unbounded while
 * preserving the full history in a condensed form.
 *
 * Threshold: 15 entries → compact oldest 5 into 1.
 * Compacted entries use plan_name = 'goal-action-compacted'.
 */

import pg from 'pg';
import { summarizeTexts } from './context/summarizer.js';

const { Pool } = pg;

const COMPACT_THRESHOLD = 15;
const COMPACT_BATCH_SIZE = 5;

let pool: pg.Pool | null = null;

function getPool(): pg.Pool {
  if (pool) return pool;
  const connectionString = process.env.JANE_DATABASE_URL;
  if (!connectionString) throw new Error('JANE_DATABASE_URL is required');
  pool = new Pool({ connectionString });
  return pool;
}

interface SummaryRow {
  id: string;
  summary: string;
  topics: string[];
  entities: string[];
  ts_start: string;
  ts_end: string;
  msg_start_idx: number;
  msg_end_idx: number;
}

/**
 * Check if the goal session has exceeded the compaction threshold.
 * If so, compact the oldest COMPACT_BATCH_SIZE entries into a single entry.
 *
 * Safe to call after every snapshot write — does nothing if below threshold.
 * Non-blocking: errors are logged but not re-thrown.
 */
export async function compactGoalSessionIfNeeded(goalSessionId: string): Promise<void> {
  try {
    const p = getPool();

    // Count goal-action-snapshot entries for this session
    const { rows: countRows } = await p.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM context.summaries
       WHERE session_id = $1 AND plan_name = 'goal-action-snapshot'`,
      [goalSessionId],
    );
    const count = parseInt(countRows[0]?.count ?? '0', 10);

    if (count <= COMPACT_THRESHOLD) return;

    log('info', 'Goal session exceeds compaction threshold — compacting', {
      goalSessionId: goalSessionId.slice(0, 8),
      count,
      threshold: COMPACT_THRESHOLD,
      batchSize: COMPACT_BATCH_SIZE,
    });

    // Load the oldest COMPACT_BATCH_SIZE entries (lowest msg_start_idx)
    const { rows: oldestRows } = await p.query<SummaryRow>(
      `SELECT id, summary, topics, entities, ts_start, ts_end, msg_start_idx, msg_end_idx
       FROM context.summaries
       WHERE session_id = $1 AND plan_name = 'goal-action-snapshot'
       ORDER BY msg_start_idx ASC
       LIMIT $2`,
      [goalSessionId, COMPACT_BATCH_SIZE],
    );

    if (oldestRows.length < 2) {
      log('warn', 'Not enough entries to compact', {
        goalSessionId: goalSessionId.slice(0, 8),
        found: oldestRows.length,
      });
      return;
    }

    // Summarize them
    const texts = oldestRows.map((r) => r.summary);
    const result = await summarizeTexts(texts, { model: 'haiku' });

    // Merge topics and entities from all entries
    const allTopics = Array.from(new Set([
      ...oldestRows.flatMap((r) => r.topics),
      ...result.topics,
    ])).slice(0, 10);

    const allEntities = Array.from(new Set([
      ...oldestRows.flatMap((r) => r.entities),
      ...result.entities,
    ])).slice(0, 10);

    const tsStart = oldestRows[0].ts_start;
    const tsEnd = oldestRows[oldestRows.length - 1].ts_end;
    const msgStartIdx = oldestRows[0].msg_start_idx;
    const msgEndIdx = oldestRows[oldestRows.length - 1].msg_end_idx;
    const ids = oldestRows.map((r) => r.id);

    // Write the compacted entry + delete originals in a transaction
    await p.query('BEGIN');
    try {
      await p.query(
        `INSERT INTO context.summaries (
           id, session_id, summary, topics, entities,
           msg_start_idx, msg_end_idx, msg_count,
           ts_start, ts_end, model, plan_name
         ) VALUES (
           gen_random_uuid(), $1, $2, $3, $4,
           $5, $6, $7,
           $8, $9, 'goal-engine', 'goal-action-compacted'
         )`,
        [
          goalSessionId,
          result.summary,
          allTopics,
          allEntities,
          msgStartIdx,
          msgEndIdx,
          oldestRows.length,
          tsStart,
          tsEnd,
        ],
      );

      await p.query(
        `DELETE FROM context.summaries WHERE id = ANY($1)`,
        [ids],
      );

      await p.query('COMMIT');

      log('info', 'Goal session compacted successfully', {
        goalSessionId: goalSessionId.slice(0, 8),
        compactedCount: oldestRows.length,
        msgRange: `${msgStartIdx}-${msgEndIdx}`,
        summaryLength: result.summary.length,
        latencyMs: result.latencyMs,
      });
    } catch (err) {
      await p.query('ROLLBACK');
      throw err;
    }
  } catch (err) {
    log('warn', 'Goal session compaction failed', {
      goalSessionId: goalSessionId.slice(0, 8),
      error: String(err),
    });
  }
}

function log(level: string, msg: string, extra?: Record<string, unknown>): void {
  console.log(JSON.stringify({ level, msg, component: 'goal-compaction', ts: new Date().toISOString(), ...extra }));
}

/** For testing */
export function _resetPool(): void { pool = null; }
