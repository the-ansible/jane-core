/**
 * Goal action snapshot writer.
 *
 * After a goal action completes (reviewed + status set to done/failed), this
 * module writes a context.summaries entry for the goal's session. This allows
 * the parent-session context module to surface prior goal action outcomes to
 * sub-agents spawned as children of the goal session.
 *
 * Complements the goal-history context module (which reads brain.goal_actions
 * directly). Both modules provide goal continuity — goal-history for executor
 * agents working on the goal; parent-session for sub-agents spawned by those
 * executors (e.g., implementation agents that inherit the goal context).
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

export interface GoalActionSnapshotParams {
  /** The goal's persistent session ID (= goal UUID). */
  goalSessionId: string;
  /** The action's description (what was attempted). */
  description: string;
  /** Executor output text (trimmed). */
  outcomeText: string | null;
  /** Reviewer assessment text (trimmed). */
  reviewText: string | null;
  /** When the action was created/started. */
  startedAt: Date;
  /** When the review completed (now). */
  completedAt: Date;
  /** Final action status ('done' | 'failed'). */
  status: string;
}

/**
 * Write a context.summaries entry for a completed goal action.
 * The entry is stored under the goal's session ID, allowing the
 * parent-session context module to surface it to child sessions.
 *
 * Uses sequential msg indices based on existing snapshot count.
 * Safe to call multiple times — the unique index on (session_id, ts_end)
 * prevents duplicate entries for the same completion timestamp.
 */
export async function writeGoalActionSnapshot(params: GoalActionSnapshotParams): Promise<void> {
  const p = getPool();

  // Count existing snapshots to determine next sequential index
  const { rows: countRows } = await p.query<{ count: string }>(
    `SELECT COUNT(*) as count FROM context.summaries WHERE session_id = $1 AND plan_name = 'goal-action-snapshot'`,
    [params.goalSessionId],
  );
  const existingCount = parseInt(countRows[0]?.count ?? '0', 10);
  const msgIdx = existingCount; // 0-based sequential index

  // Build summary text
  const statusLabel = params.status === 'done' ? 'COMPLETED' : 'FAILED';
  const parts: string[] = [
    `Action ${statusLabel}: ${params.description}`,
  ];

  if (params.outcomeText) {
    parts.push(`\nOutcome:\n${params.outcomeText.slice(0, 1500)}`);
  }

  if (params.reviewText) {
    parts.push(`\nReview:\n${params.reviewText.slice(0, 800)}`);
  }

  const summary = parts.join('\n');

  // Extract topics from description (first sentence, key phrases)
  const topics = extractTopics(params.description);

  await p.query(
    `INSERT INTO context.summaries (
       id, session_id, summary, topics, entities,
       msg_start_idx, msg_end_idx, msg_count,
       ts_start, ts_end, model, plan_name
     ) VALUES (
       gen_random_uuid(), $1, $2, $3, '{}',
       $4, $4, 1,
       $5, $6, 'goal-engine', 'goal-action-snapshot'
     )
     ON CONFLICT (session_id, ts_end) DO NOTHING`,
    [
      params.goalSessionId,
      summary,
      topics,
      msgIdx,
      params.startedAt.toISOString(),
      params.completedAt.toISOString(),
    ],
  );

  log('info', 'Goal action snapshot written', {
    goalSessionId: params.goalSessionId.slice(0, 8),
    msgIdx,
    status: params.status,
    summaryLength: summary.length,
  });
}

/**
 * Extract topic keywords from an action description.
 * Returns up to 5 short topic phrases.
 */
function extractTopics(description: string): string[] {
  const topics: string[] = [];

  // Extract capitalized proper nouns and file-path-style identifiers
  const identifiers = description.match(/[A-Z][a-zA-Z]+(?:\.[a-z]+)?|[a-z]+[A-Z][a-zA-Z]+|\w+\.ts|\w+\.js/g) ?? [];
  for (const id of identifiers.slice(0, 5)) {
    if (id.length > 3 && !topics.includes(id)) topics.push(id);
  }

  // If we got nothing useful, take first 3 words as topics
  if (topics.length === 0) {
    const words = description.split(/\s+/).slice(0, 3).map(w => w.replace(/[^a-zA-Z0-9]/g, ''));
    topics.push(...words.filter(w => w.length > 2));
  }

  return topics.slice(0, 5);
}

function log(level: string, msg: string, extra?: Record<string, unknown>): void {
  console.log(JSON.stringify({ level, msg, component: 'goal-snapshots', ts: new Date().toISOString(), ...extra }));
}

/** For testing */
export function _resetPool(): void { pool = null; }
