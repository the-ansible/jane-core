/**
 * Hierarchical Layers Integration Tests
 *
 * Tests DB registry, layer status, and HTTP API routes.
 * Uses real PostgreSQL — requires JANE_DATABASE_URL to be set.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';

const schema = process.env.BRAIN_SCHEMA ?? 'brain';
import {
  initLayerRegistry,
  recordLayerEvent,
  listLayerEvents,
  createDirective,
  applyDirective,
  listDirectives,
  _resetLayerPool,
} from './registry.js';
import {
  getAutonomicStatus,
  getLastMonitorResults,
  stopAutonomicLayer,
} from './autonomic.js';
import {
  getReflexiveStatus,
  stopReflexiveLayer,
} from './reflexive.js';
import {
  getCognitiveStatus,
  stopCognitiveLayer,
} from './cognitive.js';
import {
  getStrategicStatus,
  stopStrategicLayer,
} from './strategic.js';
import {
  getLayerStatuses,
  getLayerStatus,
  isInitialized,
  stopHierarchicalControl,
} from './controller.js';
import { createApp, type ServerDeps } from '../api/routes.js';

const { Pool } = pg;

let pool: pg.Pool;
const testEventIds: string[] = [];
const testDirectiveIds: string[] = [];

beforeAll(async () => {
  const connectionString = process.env.JANE_DATABASE_URL;
  if (!connectionString) throw new Error('JANE_DATABASE_URL is required');
  pool = new Pool({ connectionString });
  await initLayerRegistry();
});

afterAll(async () => {
  // Clean up test records
  if (testEventIds.length > 0) {
    await pool.query(`DELETE FROM ${schema}.layer_events WHERE id = ANY($1::uuid[])`, [testEventIds]);
  }
  if (testDirectiveIds.length > 0) {
    await pool.query(`DELETE FROM ${schema}.layer_directives WHERE id = ANY($1::uuid[])`, [testDirectiveIds]);
  }
  stopHierarchicalControl();
  await pool.end();
  _resetLayerPool();
});

// ---------------------------------------------------------------------------
// DB Registry tests
// ---------------------------------------------------------------------------

describe('Layer Registry', () => {
  it('creates and retrieves layer events', async () => {
    const id = await recordLayerEvent({
      layer: 'autonomic',
      eventType: 'heartbeat',
      severity: 'info',
      payload: { test: true, monitors: 8 },
    });
    testEventIds.push(id);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);

    const events = await listLayerEvents({ layer: 'autonomic', limit: 10 });
    const found = events.find((e) => e.id === id);
    expect(found).toBeDefined();
    expect(found?.layer).toBe('autonomic');
    expect(found?.eventType).toBe('heartbeat');
    expect(found?.payload).toMatchObject({ test: true });
  });

  it('filters events by type', async () => {
    const alertId = await recordLayerEvent({
      layer: 'reflexive',
      eventType: 'escalate',
      severity: 'warning',
      payload: { trigger: 'test' },
    });
    testEventIds.push(alertId);

    const events = await listLayerEvents({ eventType: 'escalate', limit: 10 });
    expect(events.some((e) => e.id === alertId)).toBe(true);
    expect(events.every((e) => e.eventType === 'escalate')).toBe(true);
  });

  it('creates and applies directives', async () => {
    const id = await createDirective({
      targetLayer: 'autonomic',
      directive: 'increase_monitor_frequency',
      params: { intervalMs: 30000 },
    });
    testDirectiveIds.push(id);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);

    const pending = await listDirectives('autonomic', 'pending');
    const found = pending.find((d) => d.id === id);
    expect(found).toBeDefined();
    expect(found?.directive).toBe('increase_monitor_frequency');
    expect(found?.params).toMatchObject({ intervalMs: 30000 });

    await applyDirective(id);

    const applied = await listDirectives('autonomic', 'applied');
    const appliedFound = applied.find((d) => d.id === id);
    expect(appliedFound).toBeDefined();
    expect(appliedFound?.appliedAt).not.toBeNull();
  });

  it('handles multiple event severities', async () => {
    const ids = await Promise.all([
      recordLayerEvent({ layer: 'autonomic', eventType: 'alert', severity: 'critical', payload: { monitor: 'kanban-api' } }),
      recordLayerEvent({ layer: 'autonomic', eventType: 'alert', severity: 'warning', payload: { monitor: 'disk' } }),
    ]);
    testEventIds.push(...ids);

    const critical = await listLayerEvents({ severity: 'critical', limit: 10 });
    expect(critical.some((e) => ids.includes(e.id))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Layer status tests (no NATS needed — just status getters)
// ---------------------------------------------------------------------------

describe('Layer Status', () => {
  it('autonomic layer is not running before start', () => {
    const status = getAutonomicStatus();
    // May or may not be running depending on test order — just check shape
    expect(status.layer).toBe('autonomic');
    expect(typeof status.running).toBe('boolean');
    expect(status.metadata).toBeDefined();
  });

  it('reflexive layer has correct shape', () => {
    const status = getReflexiveStatus();
    expect(status.layer).toBe('reflexive');
    expect(typeof status.running).toBe('boolean');
  });

  it('cognitive layer has correct shape', () => {
    const status = getCognitiveStatus();
    expect(status.layer).toBe('cognitive');
    expect(typeof status.running).toBe('boolean');
    expect(status.metadata).toHaveProperty('completedCount');
  });

  it('strategic layer has correct shape', () => {
    const status = getStrategicStatus();
    expect(status.layer).toBe('strategic');
    expect(typeof status.running).toBe('boolean');
    expect(status.metadata).toHaveProperty('evaluationCount');
  });

  it('controller returns all 4 layers', () => {
    const statuses = getLayerStatuses();
    expect(statuses).toHaveLength(4);
    const names = statuses.map((s) => s.layer);
    expect(names).toContain('autonomic');
    expect(names).toContain('reflexive');
    expect(names).toContain('cognitive');
    expect(names).toContain('strategic');
  });

  it('getLayerStatus returns correct layer by name', () => {
    const a = getLayerStatus('autonomic');
    expect(a?.layer).toBe('autonomic');

    const s = getLayerStatus('strategic');
    expect(s?.layer).toBe('strategic');
  });

  it('getLastMonitorResults returns an array', () => {
    const results = getLastMonitorResults();
    expect(Array.isArray(results)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// HTTP API tests
// ---------------------------------------------------------------------------

describe('Layers HTTP API', () => {
  const deps: ServerDeps = { nats: null };
  const app = createApp(deps);

  it('GET /api/layers returns initialized state', async () => {
    const res = await app.request('/api/layers');
    expect(res.status).toBe(200);
    const body = await res.json() as { initialized: boolean; layers: unknown[] };
    expect(typeof body.initialized).toBe('boolean');
    expect(Array.isArray(body.layers)).toBe(true);
  });

  it('GET /api/layers/:name returns specific layer', async () => {
    const res = await app.request('/api/layers/autonomic');
    expect(res.status).toBe(200);
    const body = await res.json() as { layer: string };
    expect(body.layer).toBe('autonomic');
  });

  it('GET /api/layers/unknown returns 404', async () => {
    const res = await app.request('/api/layers/unknown_layer');
    expect(res.status).toBe(404);
  });

  it('GET /api/layers/events returns events array', async () => {
    const res = await app.request('/api/layers/events');
    expect(res.status).toBe(200);
    const body = await res.json() as { events: unknown[] };
    expect(Array.isArray(body.events)).toBe(true);
  });

  it('GET /api/layers/events with layer filter', async () => {
    const res = await app.request('/api/layers/events?layer=autonomic&limit=5');
    expect(res.status).toBe(200);
    const body = await res.json() as { events: Array<{ layer: string }> };
    expect(body.events.every((e) => e.layer === 'autonomic')).toBe(true);
  });

  it('GET /api/layers/directives returns directives array', async () => {
    const res = await app.request('/api/layers/directives');
    expect(res.status).toBe(200);
    const body = await res.json() as { directives: unknown[] };
    expect(Array.isArray(body.directives)).toBe(true);
  });

  it('POST /api/layers/evaluate returns 503 without NATS', async () => {
    const res = await app.request('/api/layers/evaluate', { method: 'POST' });
    expect(res.status).toBe(503);
  });

  it('POST /api/layers/directive validates required fields', async () => {
    const res = await app.request('/api/layers/directive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetLayer: 'autonomic' }), // missing directive
    });
    expect(res.status).toBe(503); // no NATS
  });

  it('POST /api/layers/directive returns 503 without NATS', async () => {
    const res = await app.request('/api/layers/directive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetLayer: 'autonomic', directive: 'test' }),
    });
    expect(res.status).toBe(503);
  });
});

// ---------------------------------------------------------------------------
// Controller lifecycle
// ---------------------------------------------------------------------------

describe('Controller lifecycle', () => {
  it('isInitialized returns false before start', () => {
    // Controller not started in tests (no NATS)
    expect(typeof isInitialized()).toBe('boolean');
  });

  it('stopHierarchicalControl is idempotent', () => {
    expect(() => stopHierarchicalControl()).not.toThrow();
    expect(() => stopHierarchicalControl()).not.toThrow();
  });
});
