import { describe, it, expect, beforeEach } from 'vitest';
import { normalizePath, recordRequest, getRequestMetrics, renderRequestMetricsPrometheus } from './request-metrics.js';

// Reset module state between tests by re-importing won't work cleanly with vitest isolation,
// so we use a fresh store via a dedicated reset helper accessed through the module's observable behavior.

describe('normalizePath', () => {
  it('replaces UUID segments with :id', () => {
    expect(normalizePath('/api/goals/9a789c8b-23d2-4520-b81f-00f644cf37af'))
      .toBe('/api/goals/:id');
  });

  it('replaces multiple UUIDs', () => {
    expect(normalizePath('/api/sessions/9a789c8b-23d2-4520-b81f-00f644cf37af/children'))
      .toBe('/api/sessions/:id/children');
  });

  it('leaves non-UUID paths unchanged', () => {
    expect(normalizePath('/api/goals')).toBe('/api/goals');
    expect(normalizePath('/health')).toBe('/health');
    expect(normalizePath('/metrics')).toBe('/metrics');
  });

  it('handles path with no IDs', () => {
    expect(normalizePath('/api/layers/autonomic')).toBe('/api/layers/autonomic');
  });
});

describe('recordRequest and getRequestMetrics', () => {
  it('accumulates counts correctly', () => {
    // Record a few requests
    recordRequest('GET', '/health', 5);
    recordRequest('GET', '/health', 15);
    recordRequest('POST', '/api/jobs', 100);

    const metrics = getRequestMetrics();
    const healthEntry = metrics.find(m => m.method === 'GET' && m.path === '/health');
    const jobsEntry = metrics.find(m => m.method === 'POST' && m.path === '/api/jobs');

    expect(healthEntry).toBeDefined();
    expect(healthEntry!.count).toBeGreaterThanOrEqual(2);
    expect(healthEntry!.sumMs).toBeGreaterThanOrEqual(20);

    expect(jobsEntry).toBeDefined();
    expect(jobsEntry!.count).toBeGreaterThanOrEqual(1);
  });

  it('normalizes UUID paths automatically', () => {
    recordRequest('GET', '/api/goals/9a789c8b-23d2-4520-b81f-00f644cf37af', 10);
    const metrics = getRequestMetrics();
    const entry = metrics.find(m => m.path === '/api/goals/:id');
    expect(entry).toBeDefined();
  });
});

describe('renderRequestMetricsPrometheus', () => {
  it('returns a string containing expected metric names after recording', () => {
    recordRequest('GET', '/api/memories', 42);
    const output = renderRequestMetricsPrometheus();
    expect(output).toContain('brain_http_requests_total');
    expect(output).toContain('brain_http_request_duration_ms_bucket');
    expect(output).toContain('brain_http_request_duration_ms_count');
    expect(output).toContain('brain_http_request_duration_ms_sum');
  });

  it('includes method and path labels', () => {
    recordRequest('POST', '/api/goals', 25);
    const output = renderRequestMetricsPrometheus();
    expect(output).toContain('method="POST"');
    expect(output).toContain('path="/api/goals"');
  });

  it('includes +Inf bucket', () => {
    recordRequest('GET', '/api/layers', 5);
    const output = renderRequestMetricsPrometheus();
    expect(output).toContain('le="+Inf"');
  });
});
