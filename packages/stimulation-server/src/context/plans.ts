/**
 * Plan management — CRUD + cached active plan loading.
 */

import { db } from './db.js';
import type { ContextPlanConfig } from './types.js';

interface PlanRow {
  name: string;
  config: ContextPlanConfig;
  is_active: boolean;
  description: string | null;
  created_at: string;
  updated_at: string;
}

let activePlanCache: { plan: ContextPlanConfig; name: string; time: number } | null = null;
const CACHE_TTL = 30_000; // 30 seconds

export async function getActivePlan(): Promise<{ name: string; config: ContextPlanConfig }> {
  const now = Date.now();
  if (activePlanCache && now - activePlanCache.time < CACHE_TTL) {
    return { name: activePlanCache.name, config: activePlanCache.plan };
  }

  const { rows } = await db.query<PlanRow>(
    'SELECT name, config FROM context.plans WHERE is_active = TRUE LIMIT 1'
  );

  if (rows.length === 0) {
    throw new Error('No active context plan found');
  }

  const config = typeof rows[0].config === 'string'
    ? JSON.parse(rows[0].config)
    : rows[0].config;

  activePlanCache = { plan: config, name: rows[0].name, time: now };
  return { name: rows[0].name, config };
}

export function resolvePlan(
  config: ContextPlanConfig,
  component: 'agent' | 'composer'
): { maxSummaries: number; tokenBudgetPct: number } & ContextPlanConfig {
  const overrides = config[component] || {};
  return {
    ...config,
    maxSummaries: overrides.maxSummaries ?? config.maxSummaries,
    tokenBudgetPct: overrides.tokenBudgetPct ?? config.tokenBudgetPct,
  };
}

export async function listPlans(): Promise<PlanRow[]> {
  const { rows } = await db.query<PlanRow>(
    'SELECT name, config, is_active, description, created_at, updated_at FROM context.plans ORDER BY created_at'
  );
  return rows;
}

export async function createPlan(
  name: string,
  config: ContextPlanConfig,
  description?: string
): Promise<void> {
  await db.query(
    `INSERT INTO context.plans (name, config, is_active, description)
     VALUES ($1, $2, FALSE, $3)`,
    [name, JSON.stringify(config), description || null]
  );
}

export async function setActivePlan(name: string): Promise<void> {
  await db.query('UPDATE context.plans SET is_active = FALSE, updated_at = NOW()');
  const { rows } = await db.query<{ name: string }>(
    'UPDATE context.plans SET is_active = TRUE, updated_at = NOW() WHERE name = $1 RETURNING name',
    [name]
  );
  if (rows.length === 0) {
    throw new Error(`Plan "${name}" not found`);
  }
  // Invalidate cache
  activePlanCache = null;
}

/** For testing */
export function _resetPlanCache(): void {
  activePlanCache = null;
}
