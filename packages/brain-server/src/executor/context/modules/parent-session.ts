/**
 * Parent session context module — sub-session context inheritance.
 *
 * When a session has a parent_session_id (recorded in brain.sessions),
 * this module retrieves a summary of the parent session's context.
 * This gives sub-sessions awareness of the broader context they were
 * spawned from.
 *
 * Use case: a meta-session spawns sub-agents for specific phases of a
 * longer task (e.g., development lifecycle: plan → implement → review).
 * Each sub-session inherits the parent's accumulated conversation context.
 */

import pg from 'pg';
import type { ContextModule, ContextModuleParams, ContextFragment } from '../types.js';
import { getParentSessionId } from '../../sessions.js';
import { estimateTokens } from '../tokens.js';

const { Pool } = pg;

let pool: pg.Pool | null = null;

function getPool(): pg.Pool {
  if (pool) return pool;
  const connectionString = process.env.JANE_DATABASE_URL;
  if (!connectionString) throw new Error('JANE_DATABASE_URL is required');
  pool = new Pool({ connectionString });
  return pool;
}

interface DbSummaryRow {
  summary: string;
  topics: string[];
  msg_count: number;
  ts_start: string;
  ts_end: string;
}

const MAX_PARENT_SUMMARIES = 5;
const MAX_PARENT_TOKENS = 4_000;

const parentSessionModule: ContextModule = {
  name: 'parent-session',

  async assemble(params: ContextModuleParams): Promise<ContextFragment | null> {
    if (!params.sessionId) return null;

    try {
      // Look up parent session
      const parentId = await getParentSessionId(params.sessionId);
      if (!parentId) return null;

      // Load parent's most recent summaries (newest first, within budget)
      const { rows: summaries } = await getPool().query<DbSummaryRow>(
        `SELECT summary, topics, msg_count, ts_start, ts_end
         FROM context.summaries
         WHERE session_id = $1
         ORDER BY msg_end_idx DESC
         LIMIT $2`,
        [parentId, MAX_PARENT_SUMMARIES],
      );

      if (summaries.length === 0) return null;

      // Collect summaries within token budget
      const collected: DbSummaryRow[] = [];
      let totalTokens = 0;

      for (const s of summaries) {
        const t = estimateTokens(s.summary);
        if (totalTokens + t > MAX_PARENT_TOKENS) break;
        collected.push(s);
        totalTokens += t;
      }

      if (collected.length === 0) return null;

      // Reverse to chronological order
      collected.reverse();

      // Format output
      const parts: string[] = [`PARENT SESSION CONTEXT (session ${parentId.slice(0, 8)}…):`];
      parts.push('This session was spawned from a parent session. Here is its recent context:\n');

      for (const s of collected) {
        const timeRange = formatTimeRange(s.ts_start, s.ts_end);
        parts.push(`--- ${timeRange} (${s.msg_count} messages) ---`);
        if (s.topics.length > 0) {
          parts.push(`Topics: ${s.topics.join(', ')}`);
        }
        parts.push(s.summary);
        parts.push('');
      }

      const text = parts.join('\n');

      log('info', 'Parent session context assembled', {
        sessionId: params.sessionId,
        parentId,
        summaryCount: collected.length,
        tokenEstimate: estimateTokens(text),
      });

      return {
        source: 'parent-session',
        text,
        tokenEstimate: estimateTokens(text),
        meta: {
          parentSessionId: parentId,
          summaryCount: collected.length,
        },
      };
    } catch (err) {
      log('warn', 'Parent session module failed', { error: String(err), sessionId: params.sessionId });
      return null;
    }
  },
};

export default parentSessionModule;

function formatTimeRange(tsStart: string, tsEnd: string): string {
  const start = new Date(tsStart);
  const end = new Date(tsEnd);
  const opts: Intl.DateTimeFormatOptions = {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    timeZone: 'America/Los_Angeles',
  };
  const startStr = start.toLocaleString('en-US', opts);
  const endStr = end.toLocaleString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles' });
  return `${startStr} – ${endStr} Pacific`;
}

function log(level: string, msg: string, extra?: Record<string, unknown>): void {
  console.log(JSON.stringify({ level, msg, component: 'context.parent-session', ts: new Date().toISOString(), ...extra }));
}

export function _resetPool(): void { pool = null; }
