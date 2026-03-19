/**
 * In-memory HTTP request metrics for Prometheus scraping.
 *
 * Tracks per-route (method + normalized path) request counts and duration histograms.
 * Paths are normalized: UUID segments → ':id', hex IDs → ':id'.
 *
 * Lightweight — no external dependencies. Counters survive server restarts only
 * as long as the process is running.
 */

// Prometheus histogram buckets (ms)
const DURATION_BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, Infinity];

interface RouteMetrics {
  count: number;
  sum: number;           // total duration ms
  buckets: number[];     // one per DURATION_BUCKETS entry (cumulative counts)
}

// method+path → metrics
const store = new Map<string, RouteMetrics>();

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const HEX_ID_RE = /\/[0-9a-f]{16,}(?=\/|$)/gi;

/**
 * Normalize a URL path to reduce metric cardinality.
 * Collapses UUID and hex-ID segments into ':id'.
 */
export function normalizePath(path: string): string {
  return path
    .replace(UUID_RE, ':id')
    .replace(HEX_ID_RE, '/:id');
}

/** Record a completed HTTP request. Call this after the response is sent. */
export function recordRequest(method: string, rawPath: string, durationMs: number): void {
  const path = normalizePath(rawPath);
  const key = `${method.toUpperCase()} ${path}`;

  let m = store.get(key);
  if (!m) {
    m = { count: 0, sum: 0, buckets: new Array(DURATION_BUCKETS.length).fill(0) };
    store.set(key, m);
  }

  m.count += 1;
  m.sum += durationMs;

  for (let i = 0; i < DURATION_BUCKETS.length; i++) {
    if (durationMs <= DURATION_BUCKETS[i]) {
      m.buckets[i] += 1;
    }
  }
}

export interface RouteMetricSummary {
  method: string;
  path: string;
  count: number;
  sumMs: number;
  p50Ms: number | null;
  p95Ms: number | null;
}

/** Return all request metrics as an array, sorted by count desc. */
export function getRequestMetrics(): RouteMetricSummary[] {
  const results: RouteMetricSummary[] = [];
  for (const [key, m] of store.entries()) {
    const [method, ...parts] = key.split(' ');
    const path = parts.join(' ');
    results.push({
      method,
      path,
      count: m.count,
      sumMs: m.sum,
      p50Ms: estimatePercentile(m, 0.50),
      p95Ms: estimatePercentile(m, 0.95),
    });
  }
  return results.sort((a, b) => b.count - a.count);
}

/**
 * Render request metrics in Prometheus text format.
 * Returns the metric block as a string (no trailing newline).
 */
export function renderRequestMetricsPrometheus(): string {
  if (store.size === 0) return '';

  const lines: string[] = [
    '# HELP brain_http_requests_total Total HTTP requests by method and path',
    '# TYPE brain_http_requests_total counter',
  ];

  const durationBucketLines: string[] = [
    '',
    '# HELP brain_http_request_duration_ms HTTP request duration in milliseconds',
    '# TYPE brain_http_request_duration_ms histogram',
  ];

  for (const [key, m] of store.entries()) {
    const [method, ...parts] = key.split(' ');
    const path = parts.join(' ');
    const labels = `method="${method}",path="${escapeLabelValue(path)}"`;

    lines.push(`brain_http_requests_total{${labels}} ${m.count}`);

    for (let i = 0; i < DURATION_BUCKETS.length; i++) {
      const le = DURATION_BUCKETS[i] === Infinity ? '+Inf' : String(DURATION_BUCKETS[i]);
      // Cumulative count up to this bucket
      const cumulative = m.buckets.slice(0, i + 1).reduce((a, b) => a + b, 0);
      durationBucketLines.push(`brain_http_request_duration_ms_bucket{${labels},le="${le}"} ${cumulative}`);
    }
    durationBucketLines.push(`brain_http_request_duration_ms_count{${labels}} ${m.count}`);
    durationBucketLines.push(`brain_http_request_duration_ms_sum{${labels}} ${m.sum.toFixed(3)}`);
  }

  return [...lines, ...durationBucketLines].join('\n');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeLabelValue(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/**
 * Estimate a percentile from histogram buckets using linear interpolation.
 * Returns null if count is 0.
 */
function estimatePercentile(m: RouteMetrics, percentile: number): number | null {
  if (m.count === 0) return null;
  const target = percentile * m.count;
  let cumulative = 0;
  for (let i = 0; i < DURATION_BUCKETS.length; i++) {
    const prevCumulative = cumulative;
    cumulative += m.buckets[i];
    if (cumulative >= target) {
      const lowerBound = i === 0 ? 0 : DURATION_BUCKETS[i - 1];
      const upperBound = DURATION_BUCKETS[i] === Infinity ? DURATION_BUCKETS[i - 1] * 2 : DURATION_BUCKETS[i];
      if (upperBound === lowerBound) return lowerBound;
      const fraction = (target - prevCumulative) / m.buckets[i];
      return lowerBound + fraction * (upperBound - lowerBound);
    }
  }
  return DURATION_BUCKETS[DURATION_BUCKETS.length - 2]; // last finite bucket
}
