/**
 * Health check module tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DatabaseHealthResult, HealthCheckResult } from './health.js';

// Mock pg so we can control query behavior
vi.mock('pg', () => {
  const mockQuery = vi.fn();
  const MockPool = vi.fn(() => ({ query: mockQuery }));
  return { default: { Pool: MockPool }, Pool: MockPool, __mockQuery: mockQuery };
});

describe('fullHealthCheck', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('returns ok when DB responds and NATS is connected', async () => {
    const pg = await import('pg');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mockQuery = (pg as any).__mockQuery ?? (pg.default as any).__mockQuery;
    if (mockQuery) mockQuery.mockResolvedValue({ rows: [{ '?column?': 1 }] });

    const { fullHealthCheck } = await import('./health.js');
    const result: HealthCheckResult = await fullHealthCheck(true, 60000);

    expect(result.status).toBe('ok');
    expect(result.nats.connected).toBe(true);
    expect(result.nats.status).toBe('ok');
    expect(result.uptime).toBe(60);
    expect(result.service).toBe('brain-server');
  });

  it('returns degraded when NATS is disconnected but DB is ok', async () => {
    const pg = await import('pg');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mockQuery = (pg as any).__mockQuery ?? (pg.default as any).__mockQuery;
    if (mockQuery) mockQuery.mockResolvedValue({ rows: [{ '?column?': 1 }] });

    const { fullHealthCheck } = await import('./health.js');
    const result: HealthCheckResult = await fullHealthCheck(false, 30000);

    expect(result.status).toBe('degraded');
    expect(result.nats.connected).toBe(false);
    expect(result.nats.status).toBe('error');
  });

  it('returns error when DB is unreachable', async () => {
    const pg = await import('pg');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mockQuery = (pg as any).__mockQuery ?? (pg.default as any).__mockQuery;
    if (mockQuery) mockQuery.mockRejectedValue(new Error('connection refused'));

    const { fullHealthCheck } = await import('./health.js');
    const result: HealthCheckResult = await fullHealthCheck(true, 10000);

    expect(result.status).toBe('error');
    expect(result.database.status).toBe('error');
    expect(result.database.error).toMatch(/connection refused/);
  });
});

describe('checkDatabaseHealth', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('returns ok with latency when DB responds', async () => {
    const pg = await import('pg');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mockQuery = (pg as any).__mockQuery ?? (pg.default as any).__mockQuery;
    if (mockQuery) mockQuery.mockResolvedValue({ rows: [] });

    const { checkDatabaseHealth } = await import('./health.js');
    const result: DatabaseHealthResult = await checkDatabaseHealth();

    expect(result.status).toBe('ok');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.error).toBeUndefined();
  });

  it('returns error with message when DB throws', async () => {
    const pg = await import('pg');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mockQuery = (pg as any).__mockQuery ?? (pg.default as any).__mockQuery;
    if (mockQuery) mockQuery.mockRejectedValue(new Error('timeout'));

    const { checkDatabaseHealth } = await import('./health.js');
    const result: DatabaseHealthResult = await checkDatabaseHealth();

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/timeout/);
  });
});
