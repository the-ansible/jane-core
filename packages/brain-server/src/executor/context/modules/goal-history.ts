/**
 * Goal history context module — prior actions and outcomes for the current goal.
 *
 * When an agent is running as a goal action executor, it should know what prior
 * actions have already been attempted and what their outcomes were. This prevents
 * re-doing completed work and provides continuity across goal cycles.
 *
 * How it resolves the goal:
 * 1. Looks up the session in brain.sessions for metadata.goalId
 * 2. If no goalId in metadata, falls back to checking if sessionId itself is a goal ID
 * 3. Queries brain.goal_actions for recent completed/failed actions on that goal
 */

import pg from 'pg';
import type { ContextModule, ContextModuleParams, ContextFragment } from '../types.js';
import { estimateTokens } from '../tokens.js';

const { Pool } = pg;

const SCHEMA = process.env.BRAIN_SCHEMA ?? 'brain';
const MAX_ACTIONS = 10;
const TOKEN_BUDGET = 3000;

/** Orphaned startup recovery outcomes — infrastructure interruptions, not real work failures. */
const ORPHANED_OUTCOME_PREFIX = 'Recovered at startup:';

let pool: pg.Pool | null = null;

function getPool(): pg.Pool {
  if (pool) return pool;
  const connectionString = process.env.JANE_DATABASE_URL;
  if (!connectionString) throw new Error('JANE_DATABASE_URL is required');
  pool = new Pool({ connectionString });
  return pool;
}

interface GoalActionRow {
  id: string;
  description: string;
  status: string;
  outcome_text: string | null;
  review_text: string | null;
  created_at: string;
  updated_at: string;
}

interface GoalRow {
  id: string;
  title: string;
  description: string;
}

const goalHistoryModule: ContextModule = {
  name: 'goal-history',

  async assemble(params: ContextModuleParams): Promise<ContextFragment | null> {
    if (!params.sessionId) return null;

    try {
      // Step 1: resolve the goal ID — check session metadata first
      const goalId = await resolveGoalId(params.sessionId);
      if (!goalId) return null;

      // Step 2: load goal details
      const { rows: goalRows } = await getPool().query<GoalRow>(
        `SELECT id, title, description FROM ${SCHEMA}.goals WHERE id = $1`,
        [goalId],
      );
      const goal = goalRows[0];
      if (!goal) return null;

      // Step 3: load recent completed/failed actions (skip rejected — they were never executed)
      const { rows: actions } = await getPool().query<GoalActionRow>(
        `SELECT id, description, status, outcome_text, review_text, created_at, updated_at
         FROM ${SCHEMA}.goal_actions
         WHERE goal_id = $1
           AND status IN ('done', 'failed')
         ORDER BY updated_at DESC
         LIMIT $2`,
        [goalId, MAX_ACTIONS],
      );

      if (actions.length === 0) return null;

      // Separate real work attempts from infrastructure interruptions (orphaned jobs)
      const orphanedCount = actions.filter(
        (a) => a.outcome_text?.startsWith(ORPHANED_OUTCOME_PREFIX),
      ).length;
      const realActions = actions.filter(
        (a) => !a.outcome_text?.startsWith(ORPHANED_OUTCOME_PREFIX),
      );

      // Step 4: format the fragment
      const headerNote = orphanedCount > 0
        ? ` (${orphanedCount} infrastructure interruption${orphanedCount > 1 ? 's' : ''} excluded — brain-server restarts that cut off in-flight jobs)`
        : '';
      const lines: string[] = [
        `GOAL HISTORY — "${goal.title}"`,
        `Goal: ${goal.description.slice(0, 300)}`,
        '',
        `Prior actions (${realActions.length}, newest first)${headerNote}:`,
      ];

      if (realActions.length === 0) {
        lines.push('  No completed work attempts yet.');
        const text = lines.join('\n');
        return {
          source: 'goal-history',
          text,
          tokenEstimate: estimateTokens(text),
          meta: { goalId, goalTitle: goal.title, actionCount: 0, orphanedCount },
        };
      }

      let tokenEstimate = estimateTokens(lines.join('\n'));

      for (const action of realActions) {
        const date = new Date(action.updated_at).toISOString().slice(0, 16);
        const statusTag = action.status === 'done' ? '✓' : '✗';
        const actionLines: string[] = [
          `  [${statusTag} ${date}] ${action.description.slice(0, 200)}`,
        ];

        if (action.outcome_text) {
          actionLines.push(`    Outcome: ${action.outcome_text.slice(0, 400)}`);
        }
        if (action.review_text) {
          actionLines.push(`    Review: ${action.review_text.slice(0, 300)}`);
        }

        const actionText = actionLines.join('\n');
        const actionTokens = estimateTokens(actionText);

        // Stop adding actions if we'd exceed budget
        if (tokenEstimate + actionTokens > TOKEN_BUDGET) break;

        lines.push(actionText);
        tokenEstimate += actionTokens;
      }

      const text = lines.join('\n');
      return {
        source: 'goal-history',
        text,
        tokenEstimate: estimateTokens(text),
        meta: { goalId, goalTitle: goal.title, actionCount: realActions.length, orphanedCount },
      };
    } catch (err) {
      log('warn', 'Goal history module failed', { error: String(err) });
      return null;
    }
  },
};

export default goalHistoryModule;

/**
 * Resolve the goal ID for a session.
 * Checks session metadata for a goalId field first, then treats the session ID
 * itself as a potential goal ID (for backward compatibility with goal sessions
 * registered before metadata was added).
 */
async function resolveGoalId(sessionId: string): Promise<string | null> {
  try {
    // Check session metadata
    const { rows: sessionRows } = await getPool().query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM ${SCHEMA}.sessions WHERE id = $1`,
      [sessionId],
    );

    if (sessionRows.length > 0) {
      const metadata = sessionRows[0].metadata;
      if (metadata?.goalId && typeof metadata.goalId === 'string') {
        return metadata.goalId;
      }
    }

    // Fall back: check if the session ID itself is a goal ID
    const { rows: goalRows } = await getPool().query<{ id: string }>(
      `SELECT id FROM ${SCHEMA}.goals WHERE id = $1`,
      [sessionId],
    );
    if (goalRows.length > 0) return goalRows[0].id;

    return null;
  } catch {
    return null;
  }
}

function log(level: string, msg: string, extra?: Record<string, unknown>): void {
  console.log(JSON.stringify({ level, msg, component: 'context.goal-history', ts: new Date().toISOString(), ...extra }));
}

export function _resetPool(): void { pool = null; }
