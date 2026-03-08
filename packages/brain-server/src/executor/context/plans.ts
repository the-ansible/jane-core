/**
 * Context plan management — load and resolve plans from DB or defaults.
 *
 * Plans control token budgets, summarization thresholds, and which
 * context modules run for a given role.
 */

import pg from 'pg';
import type { ContextPlanConfig, ResolvedContextPlan } from './types.js';

const { Pool } = pg;

let pool: pg.Pool | null = null;

function getPool(): pg.Pool {
  if (pool) return pool;
  const connectionString = process.env.JANE_DATABASE_URL;
  if (!connectionString) throw new Error('JANE_DATABASE_URL is required');
  pool = new Pool({ connectionString });
  return pool;
}

// Default plan if nothing is in the DB
const DEFAULT_PLAN: ContextPlanConfig = {
  summaryChunkSize: 6,
  summaryModel: 'haiku',
  summaryPromptTemplate: 'default_v1',
  rawSummarizationThreshold: 12,
  maxSummaries: 10,
  modelContextSize: 200_000,
  tokenBudgetPct: 0.06,
  overrides: {
    composer: { maxSummaries: 3, tokenBudgetPct: 0.02 },
    scorer: { maxSummaries: 0, tokenBudgetPct: 0.01, modules: ['system-state'] },
    reviewer: { maxSummaries: 5, tokenBudgetPct: 0.04, modules: ['memory', 'system-state'] },
  },
  topicTrackingEnabled: false,
  associativeRetrievalEnabled: false,
};

const DEFAULT_MODULES = ['conversation', 'semantic-facts', 'memory', 'system-state'];

let planCache: { plan: ContextPlanConfig; name: string; time: number } | null = null;
const CACHE_TTL = 30_000;

/**
 * Load the active context plan from the DB.
 * Falls back to DEFAULT_PLAN if no DB plan exists.
 */
export async function getActivePlan(): Promise<{ name: string; config: ContextPlanConfig }> {
  const now = Date.now();
  if (planCache && now - planCache.time < CACHE_TTL) {
    return { name: planCache.name, config: planCache.plan };
  }

  try {
    const { rows } = await getPool().query<{ name: string; config: ContextPlanConfig }>(
      'SELECT name, config FROM context.plans WHERE is_active = TRUE LIMIT 1'
    );

    if (rows.length > 0) {
      const config = typeof rows[0].config === 'string'
        ? JSON.parse(rows[0].config as unknown as string)
        : rows[0].config;
      planCache = { plan: config, name: rows[0].name, time: now };
      return { name: rows[0].name, config };
    }
  } catch {
    // DB not available or schema not created; use default
  }

  planCache = { plan: DEFAULT_PLAN, name: 'default', time: now };
  return { name: 'default', config: DEFAULT_PLAN };
}

/**
 * Resolve a plan for a specific role, applying per-role overrides.
 */
export function resolvePlan(config: ContextPlanConfig, role: string): ResolvedContextPlan {
  const overrides = config.overrides?.[role] ?? {};

  const maxSummaries = overrides.maxSummaries ?? config.maxSummaries;
  const tokenBudgetPct = overrides.tokenBudgetPct ?? config.tokenBudgetPct;
  const modules = overrides.modules ?? DEFAULT_MODULES;
  const tokenBudget = Math.floor(config.modelContextSize * tokenBudgetPct);

  return {
    ...config,
    maxSummaries,
    tokenBudgetPct,
    tokenBudget,
    modules,
  };
}

/** Initialize the context schema if it doesn't exist */
export async function initContextSchema(): Promise<void> {
  const p = getPool();
  await p.query('CREATE SCHEMA IF NOT EXISTS context');
  await p.query(`
    CREATE TABLE IF NOT EXISTS context.plans (
      name         TEXT PRIMARY KEY,
      config       JSONB NOT NULL,
      is_active    BOOLEAN DEFAULT FALSE,
      description  TEXT,
      created_at   TIMESTAMPTZ DEFAULT NOW(),
      updated_at   TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await p.query(`
    CREATE TABLE IF NOT EXISTS context.summaries (
      id              UUID PRIMARY KEY,
      session_id      TEXT NOT NULL,
      summary         TEXT NOT NULL,
      topics          TEXT[] DEFAULT '{}',
      entities        TEXT[] DEFAULT '{}',
      msg_start_idx   INT NOT NULL,
      msg_end_idx     INT NOT NULL,
      msg_count       INT NOT NULL,
      ts_start        TIMESTAMPTZ NOT NULL,
      ts_end          TIMESTAMPTZ NOT NULL,
      model           TEXT NOT NULL,
      prompt_tokens   INT,
      output_tokens   INT,
      latency_ms      INT,
      plan_name       TEXT NOT NULL,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await p.query('CREATE INDEX IF NOT EXISTS idx_ctx_summaries_session ON context.summaries (session_id)');
  await p.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_ctx_summaries_session_time
    ON context.summaries (session_id, ts_end)
  `);
  await p.query(`
    CREATE TABLE IF NOT EXISTS context.assembly_log (
      id                  UUID PRIMARY KEY,
      session_id          TEXT NOT NULL,
      event_id            TEXT,
      plan_name           TEXT NOT NULL,
      modules_run         TEXT[] DEFAULT '{}',
      fragment_count      INT NOT NULL DEFAULT 0,
      total_tokens        INT NOT NULL DEFAULT 0,
      assembly_ms         INT NOT NULL,
      assembled_at        TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await p.query('CREATE INDEX IF NOT EXISTS idx_ctx_assembly_session ON context.assembly_log (session_id)');
}

export function _resetPlanCache(): void {
  planCache = null;
}

export function _resetPool(): void {
  pool = null;
}
