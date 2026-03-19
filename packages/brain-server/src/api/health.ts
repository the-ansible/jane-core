/**
 * Health check module — verifies DB connectivity, NATS, and engine status.
 *
 * Used by GET /health (enhanced) and the PM2 health-check script.
 */

import pg from 'pg';

const { Pool } = pg;

const SCHEMA = process.env.BRAIN_SCHEMA ?? 'brain';

let pool: pg.Pool | null = null;

function getPool(): pg.Pool {
  if (pool) return pool;
  const connectionString = process.env.JANE_DATABASE_URL;
  if (!connectionString) throw new Error('JANE_DATABASE_URL is required');
  pool = new Pool({ connectionString, max: 2 });
  return pool;
}

export interface DatabaseHealthResult {
  status: 'ok' | 'error';
  latencyMs: number;
  error?: string;
}

export interface HealthCheckResult {
  status: 'ok' | 'degraded' | 'error';
  service: string;
  uptime: number;
  database: DatabaseHealthResult;
  nats: { status: 'ok' | 'error'; connected: boolean };
  ts: string;
}

export async function checkDatabaseHealth(): Promise<DatabaseHealthResult> {
  const start = Date.now();
  try {
    const p = getPool();
    await p.query('SELECT 1');
    return { status: 'ok', latencyMs: Date.now() - start };
  } catch (err) {
    return {
      status: 'error',
      latencyMs: Date.now() - start,
      error: String(err),
    };
  }
}

export async function fullHealthCheck(
  natsConnected: boolean,
  uptimeMs: number,
): Promise<HealthCheckResult> {
  const db = await checkDatabaseHealth();
  const natsStatus = natsConnected ? 'ok' : 'error';

  let overallStatus: 'ok' | 'degraded' | 'error' = 'ok';
  if (db.status === 'error') {
    overallStatus = 'error';
  } else if (!natsConnected) {
    overallStatus = 'degraded';
  }

  return {
    status: overallStatus,
    service: 'brain-server',
    uptime: Math.floor(uptimeMs / 1000),
    database: db,
    nats: { status: natsStatus, connected: natsConnected },
    ts: new Date().toISOString(),
  };
}
