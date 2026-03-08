/**
 * System state context module — active goals, running jobs, recent alerts.
 *
 * Gives the agent awareness of what else is happening in the system.
 */

import pg from 'pg';
import type { ContextModule, ContextModuleParams, ContextFragment } from '../types.js';
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

const systemStateModule: ContextModule = {
  name: 'system-state',

  async assemble(params: ContextModuleParams): Promise<ContextFragment | null> {
    try {
      const parts: string[] = ['SYSTEM STATE:'];

      // Active goals
      const { rows: goals } = await getPool().query<{ title: string; priority: number; status: string }>(
        `SELECT title, priority, status FROM brain.goals
         WHERE status = 'active'
         ORDER BY priority DESC
         LIMIT 10`
      );

      if (goals.length > 0) {
        parts.push('\nActive Goals:');
        for (const g of goals) {
          parts.push(`  - [P${g.priority}] ${g.title}`);
        }
      }

      // Running jobs
      const { rows: jobs } = await getPool().query<{ id: string; job_type: string; started_at: string }>(
        `SELECT id, job_type, started_at FROM brain.agent_jobs
         WHERE status = 'running'
         ORDER BY started_at ASC`
      );

      if (jobs.length > 0) {
        parts.push(`\nRunning Jobs: ${jobs.length}`);
        for (const j of jobs) {
          const age = formatAge(new Date(j.started_at));
          parts.push(`  - ${j.job_type} (${age})`);
        }
      }

      // Recent critical alerts (last 2 hours)
      const { rows: alerts } = await getPool().query<{ payload: Record<string, unknown>; created_at: string }>(
        `SELECT payload, created_at FROM brain.layer_events
         WHERE severity = 'critical' AND created_at > NOW() - INTERVAL '2 hours'
         ORDER BY created_at DESC
         LIMIT 5`
      );

      if (alerts.length > 0) {
        parts.push(`\nRecent Critical Alerts: ${alerts.length}`);
        for (const a of alerts) {
          const msg = (a.payload as Record<string, string>)?.message || JSON.stringify(a.payload).slice(0, 100);
          parts.push(`  - ${msg}`);
        }
      }

      if (parts.length === 1) return null; // only header, nothing interesting

      const text = parts.join('\n');
      return {
        source: 'system-state',
        text,
        tokenEstimate: estimateTokens(text),
        meta: { goalCount: goals.length, jobCount: jobs.length, alertCount: alerts.length },
      };
    } catch (err) {
      log('warn', 'System state module failed', { error: String(err) });
      return null;
    }
  },
};

export default systemStateModule;

function formatAge(d: Date): string {
  const ms = Date.now() - d.getTime();
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

function log(level: string, msg: string, extra?: Record<string, unknown>): void {
  console.log(JSON.stringify({ level, msg, component: 'context.system-state', ts: new Date().toISOString(), ...extra }));
}

export function _resetPool(): void { pool = null; }
