/**
 * Layer Registry — DB persistence for cross-layer events and directives.
 *
 * Tables:
 *   brain.layer_events    — all cross-layer events (alerts, heartbeats, results, etc.)
 *   brain.layer_directives — strategic directives to lower layers
 */

import pg from 'pg';
import type { LayerEvent, LayerEventType, LayerName, LayerDirective, DirectiveStatus } from './types.js';

const { Pool } = pg;

let pool: pg.Pool | null = null;

function getPool(): pg.Pool {
  if (pool) return pool;
  const connectionString = process.env.JANE_DATABASE_URL;
  if (!connectionString) throw new Error('JANE_DATABASE_URL is required');
  pool = new Pool({ connectionString });
  return pool;
}

export async function initLayerRegistry(): Promise<void> {
  const p = getPool();

  await p.query(`
    CREATE TABLE IF NOT EXISTS brain.layer_events (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      layer       TEXT NOT NULL,
      event_type  TEXT NOT NULL,
      severity    TEXT,
      payload     JSONB NOT NULL DEFAULT '{}',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_layer_events_layer ON brain.layer_events (layer)`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_layer_events_created ON brain.layer_events (created_at DESC)`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_layer_events_type ON brain.layer_events (event_type)`);

  await p.query(`
    CREATE TABLE IF NOT EXISTS brain.layer_directives (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      target_layer TEXT NOT NULL,
      directive    TEXT NOT NULL,
      params       JSONB NOT NULL DEFAULT '{}',
      status       TEXT NOT NULL DEFAULT 'pending',
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      applied_at   TIMESTAMPTZ
    )
  `);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_layer_directives_status ON brain.layer_directives (status)`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_layer_directives_target ON brain.layer_directives (target_layer)`);

  log('info', 'Layer registry initialized');
}

// ---------------------------------------------------------------------------
// Layer events
// ---------------------------------------------------------------------------

export async function recordLayerEvent(params: {
  layer: LayerName;
  eventType: LayerEventType;
  severity?: 'info' | 'warning' | 'critical';
  payload?: Record<string, unknown>;
}): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO brain.layer_events (layer, event_type, severity, payload)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [params.layer, params.eventType, params.severity ?? 'info', JSON.stringify(params.payload ?? {})]
  );
  return rows[0].id;
}

export async function listLayerEvents(opts: {
  layer?: LayerName;
  eventType?: LayerEventType;
  severity?: string;
  limit?: number;
} = {}): Promise<LayerEvent[]> {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (opts.layer) { conditions.push(`layer = $${idx++}`); values.push(opts.layer); }
  if (opts.eventType) { conditions.push(`event_type = $${idx++}`); values.push(opts.eventType); }
  if (opts.severity) { conditions.push(`severity = $${idx++}`); values.push(opts.severity); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = Math.min(opts.limit ?? 50, 500);
  values.push(limit);

  const { rows } = await getPool().query<{
    id: string; layer: string; event_type: string; severity: string | null;
    payload: Record<string, unknown>; created_at: Date;
  }>(
    `SELECT id, layer, event_type, severity, payload, created_at
     FROM brain.layer_events
     ${where}
     ORDER BY created_at DESC LIMIT $${idx}`,
    values
  );

  return rows.map((r) => ({
    id: r.id,
    layer: r.layer as LayerName,
    eventType: r.event_type as LayerEventType,
    severity: (r.severity ?? 'info') as LayerEvent['severity'],
    payload: r.payload,
    createdAt: r.created_at,
  }));
}

// ---------------------------------------------------------------------------
// Directives
// ---------------------------------------------------------------------------

export async function createDirective(params: {
  targetLayer: LayerName;
  directive: string;
  params?: Record<string, unknown>;
}): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO brain.layer_directives (target_layer, directive, params)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [params.targetLayer, params.directive, JSON.stringify(params.params ?? {})]
  );
  return rows[0].id;
}

export async function applyDirective(id: string): Promise<void> {
  await getPool().query(
    `UPDATE brain.layer_directives SET status = 'applied', applied_at = now() WHERE id = $1`,
    [id]
  );
}

export async function listDirectives(targetLayer?: LayerName, status?: DirectiveStatus): Promise<LayerDirective[]> {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (targetLayer) { conditions.push(`target_layer = $${idx++}`); values.push(targetLayer); }
  if (status) { conditions.push(`status = $${idx++}`); values.push(status); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const { rows } = await getPool().query<{
    id: string; target_layer: string; directive: string; params: Record<string, unknown>;
    status: string; created_at: Date; applied_at: Date | null;
  }>(
    `SELECT id, target_layer, directive, params, status, created_at, applied_at
     FROM brain.layer_directives
     ${where}
     ORDER BY created_at DESC LIMIT 100`,
    values
  );

  return rows.map((r) => ({
    id: r.id,
    targetLayer: r.target_layer as LayerName,
    directive: r.directive,
    params: r.params,
    status: r.status as DirectiveStatus,
    createdAt: r.created_at,
    appliedAt: r.applied_at,
  }));
}

function log(level: string, msg: string, extra?: Record<string, unknown>): void {
  console.log(JSON.stringify({ level, msg, component: 'layer-registry', ts: new Date().toISOString(), ...extra }));
}

/** For testing */
export function _resetLayerPool(): void {
  pool = null;
}
