/**
 * Autonomic Layer — continuous health monitoring, no LLM.
 *
 * Monitors run on fixed intervals and report their status as MonitorResults.
 * When anomalies are detected they are published to NATS (`layer.autonomic.alert`)
 * and persisted to brain.layer_events for the reflexive layer to triage.
 *
 * Monitors:
 *   - HTTP endpoints (brain :3103, canvas :3001, kanban :3000)
 *   - PostgreSQL connectivity + schema presence
 *   - NATS connectivity
 *   - Process memory (current Node process)
 *   - Disk space at /agent
 */

import type { NatsConnection } from 'nats';
import { StringCodec } from 'nats';
import type { MonitorResult, LayerStatus } from './types.js';
import { recordLayerEvent, getSchedulerState, setSchedulerState } from './registry.js';
import pg from 'pg';

const sc = StringCodec();

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let monitorTimer: ReturnType<typeof setInterval> | null = null;
let lastActivity: Date | null = null;
let lastResults: MonitorResult[] = [];

const MONITOR_INTERVAL_MS = 60_000; // 1 minute
const SCHEDULER_KEY = 'autonomic-monitor';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function startAutonomicLayer(nats: NatsConnection): void {
  if (monitorTimer) return;

  // Run immediately, then on interval
  runAllMonitors(nats);
  monitorTimer = setInterval(() => runAllMonitors(nats), MONITOR_INTERVAL_MS);

  // Async: check persisted state — for 60s intervals the server is nearly always
  // overdue after a restart, so this mainly ensures we persist nextRunAt going forward.
  recoverSchedule(nats, MONITOR_INTERVAL_MS);

  log('info', 'Autonomic layer started', { intervalMs: MONITOR_INTERVAL_MS });
}

function recoverSchedule(nats: NatsConnection, intervalMs: number): void {
  getSchedulerState(SCHEDULER_KEY)
    .then((state) => {
      if (!state?.nextRunAt) return; // No prior state — interval is already correct

      const remaining = new Date(state.nextRunAt as string).getTime() - Date.now();

      if (remaining <= 0) {
        // Overdue — already ran immediately above; nothing extra to do
        log('info', 'Autonomic monitor was overdue — already ran on startup', { overdueMs: -remaining });
      } else if (remaining < intervalMs) {
        // Due sooner than the full interval — reschedule
        clearInterval(monitorTimer!);
        log('info', 'Autonomic monitor rescheduling to match persisted schedule', { remainingMs: remaining });
        monitorTimer = setTimeout(() => {
          runAllMonitors(nats).catch(() => {});
          monitorTimer = setInterval(() => runAllMonitors(nats), intervalMs);
        }, remaining) as unknown as ReturnType<typeof setInterval>;
      }
    })
    .catch(() => {}); // Non-critical
}

export function stopAutonomicLayer(): void {
  if (monitorTimer) {
    clearInterval(monitorTimer);
    monitorTimer = null;
  }
  log('info', 'Autonomic layer stopped');
}

export function getAutonomicStatus(): LayerStatus {
  return {
    layer: 'autonomic',
    running: monitorTimer !== null,
    lastActivity,
    metadata: {
      intervalMs: MONITOR_INTERVAL_MS,
      lastResults: lastResults.map((r) => ({ name: r.name, status: r.status })),
    },
  };
}

export function getLastMonitorResults(): MonitorResult[] {
  return lastResults;
}

// ---------------------------------------------------------------------------
// Monitor runner
// ---------------------------------------------------------------------------

async function runAllMonitors(nats: NatsConnection): Promise<void> {
  setSchedulerState(SCHEDULER_KEY, {
    lastRunAt: new Date().toISOString(),
    nextRunAt: new Date(Date.now() + MONITOR_INTERVAL_MS).toISOString(),
  }).catch(() => {});

  const results = await Promise.all([
    checkHttpEndpoint('brain-server', 'http://localhost:3103/health'),
    checkHttpEndpoint('canvas-api', 'http://localhost:3001/health'),
    checkHttpEndpoint('kanban-api', 'http://localhost:3000/health'),
    checkPostgres(),
    checkNats(nats),
    checkMemory(),
    checkDisk(),
  ]);

  lastResults = results;
  lastActivity = new Date();

  const critical = results.filter((r) => r.status === 'critical');
  const warnings = results.filter((r) => r.status === 'warning');

  // Publish heartbeat
  publishNats(nats, 'layer.autonomic.heartbeat', {
    ts: new Date().toISOString(),
    ok: critical.length === 0,
    critical: critical.length,
    warnings: warnings.length,
    monitors: results.map((r) => ({ name: r.name, status: r.status })),
  });

  // Alert on critical/warning conditions
  for (const r of [...critical, ...warnings]) {
    const severity = r.status === 'critical' ? 'critical' : 'warning';

    publishNats(nats, 'layer.autonomic.alert', {
      monitor: r.name,
      severity,
      message: r.message,
      data: r.data ?? {},
      ts: new Date().toISOString(),
    });

    recordLayerEvent({
      layer: 'autonomic',
      eventType: 'alert',
      severity,
      payload: { monitor: r.name, message: r.message, data: r.data ?? {} },
    }).catch(() => {});
  }

  if (critical.length > 0) {
    log('warn', 'Autonomic alert: critical monitors', { monitors: critical.map((r) => r.name) });
  }
}

// ---------------------------------------------------------------------------
// Individual monitors
// ---------------------------------------------------------------------------

async function checkHttpEndpoint(name: string, url: string): Promise<MonitorResult> {
  const start = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const durationMs = Date.now() - start;

    if (res.ok) {
      return { name, status: 'ok', message: `${res.status} in ${durationMs}ms`, durationMs };
    }

    return {
      name,
      status: 'warning',
      message: `HTTP ${res.status} from ${url}`,
      durationMs,
    };
  } catch (err) {
    return {
      name,
      status: 'critical',
      message: `Unreachable: ${String(err)}`,
      durationMs: Date.now() - start,
    };
  }
}

async function checkPostgres(): Promise<MonitorResult> {
  const start = Date.now();
  const connectionString = process.env.JANE_DATABASE_URL;
  if (!connectionString) {
    return { name: 'postgres', status: 'critical', message: 'JANE_DATABASE_URL not set' };
  }

  const pool = new pg.Pool({ connectionString, max: 1 });
  try {
    const { rows } = await pool.query<{ schema_name: string }>(
      `SELECT schema_name FROM information_schema.schemata WHERE schema_name IN ('brain','kanban','canvas') ORDER BY schema_name`
    );
    const schemas = rows.map((r) => r.schema_name);
    const durationMs = Date.now() - start;

    const missingSchemas = ['brain', 'kanban', 'canvas'].filter((s) => !schemas.includes(s));
    if (missingSchemas.length > 0) {
      return {
        name: 'postgres',
        status: 'warning',
        message: `Missing schemas: ${missingSchemas.join(', ')}`,
        durationMs,
        data: { schemas, missingSchemas },
      };
    }

    return { name: 'postgres', status: 'ok', message: `3 schemas OK in ${durationMs}ms`, durationMs };
  } catch (err) {
    return {
      name: 'postgres',
      status: 'critical',
      message: `DB error: ${String(err)}`,
      durationMs: Date.now() - start,
    };
  } finally {
    await pool.end().catch(() => {});
  }
}

function checkNats(nats: NatsConnection): MonitorResult {
  const closed = (nats as unknown as { isClosed?: () => boolean }).isClosed?.() ?? false;
  if (closed) {
    return { name: 'nats', status: 'critical', message: 'NATS connection closed' };
  }
  return { name: 'nats', status: 'ok', message: 'Connected' };
}

function checkMemory(): MonitorResult {
  const mem = process.memoryUsage();
  const heapMB = Math.round(mem.heapUsed / 1024 / 1024);
  const rssMB = Math.round(mem.rss / 1024 / 1024);

  if (rssMB > 500) {
    return {
      name: 'memory',
      status: 'critical',
      message: `RSS ${rssMB}MB exceeds 500MB threshold`,
      data: { heapMB, rssMB },
    };
  }
  if (rssMB > 300) {
    return {
      name: 'memory',
      status: 'warning',
      message: `RSS ${rssMB}MB — elevated`,
      data: { heapMB, rssMB },
    };
  }
  return {
    name: 'memory',
    status: 'ok',
    message: `RSS ${rssMB}MB, heap ${heapMB}MB`,
    data: { heapMB, rssMB },
  };
}

async function checkDisk(): Promise<MonitorResult> {
  try {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);

    const { stdout } = await execFileAsync('df', ['-m', '/agent'], { timeout: 5000 });
    const lines = stdout.trim().split('\n');
    const parts = lines[1]?.split(/\s+/);
    if (!parts || parts.length < 5) {
      return { name: 'disk', status: 'warning', message: 'Could not parse df output' };
    }

    const usedMB = parseInt(parts[2], 10);
    const availMB = parseInt(parts[3], 10);
    const usePct = parseInt(parts[4], 10);

    if (usePct >= 90) {
      return {
        name: 'disk',
        status: 'critical',
        message: `Disk ${usePct}% full — ${availMB}MB available`,
        data: { usedMB, availMB, usePct },
      };
    }
    if (usePct >= 80) {
      return {
        name: 'disk',
        status: 'warning',
        message: `Disk ${usePct}% full — ${availMB}MB available`,
        data: { usedMB, availMB, usePct },
      };
    }
    return {
      name: 'disk',
      status: 'ok',
      message: `${usePct}% used, ${availMB}MB free`,
      data: { usedMB, availMB, usePct },
    };
  } catch (err) {
    return { name: 'disk', status: 'warning', message: `df failed: ${String(err)}` };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function publishNats(nats: NatsConnection, subject: string, payload: Record<string, unknown>): void {
  try {
    nats.publish(subject, sc.encode(JSON.stringify(payload)));
  } catch (err) { log('warn', 'Failed to publish NATS event', { subject, error: String(err) }); }
}

function log(level: string, msg: string, extra?: Record<string, unknown>): void {
  console.log(JSON.stringify({ level, msg, component: 'autonomic-layer', ts: new Date().toISOString(), ...extra }));
}
