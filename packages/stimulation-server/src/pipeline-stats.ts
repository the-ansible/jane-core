/**
 * Pipeline Stats — rolling-window latency tracking and success/failure counters.
 * Provides p50/p95/p99 percentiles for agent, composer, and total pipeline latency.
 */

const WINDOW_SIZE = 200; // Keep last N measurements

interface LatencySample {
  ms: number;
  ts: number; // Unix timestamp
}

class LatencyTracker {
  private samples: LatencySample[] = [];
  private total = 0;
  private count = 0;

  record(ms: number): void {
    this.samples.push({ ms, ts: Date.now() });
    this.total += ms;
    this.count++;

    // Trim to window
    if (this.samples.length > WINDOW_SIZE) {
      this.samples = this.samples.slice(-WINDOW_SIZE);
    }
  }

  percentile(p: number): number | null {
    if (this.samples.length === 0) return null;
    const sorted = [...this.samples].map(s => s.ms).sort((a, b) => a - b);
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, idx)];
  }

  stats(): LatencyStats {
    return {
      count: this.count,
      p50: this.percentile(50),
      p95: this.percentile(95),
      p99: this.percentile(99),
      avg: this.count > 0 ? Math.round(this.total / this.count) : null,
      min: this.samples.length > 0 ? Math.min(...this.samples.map(s => s.ms)) : null,
      max: this.samples.length > 0 ? Math.max(...this.samples.map(s => s.ms)) : null,
      windowSize: this.samples.length,
    };
  }

  reset(): void {
    this.samples = [];
    this.total = 0;
    this.count = 0;
  }
}

export interface LatencyStats {
  count: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  avg: number | null;
  min: number | null;
  max: number | null;
  windowSize: number;
}

export interface PipelineOutcome {
  action: string;
  responded: boolean;
  agentMs?: number;
  composerMs?: number;
  totalMs: number;
  error?: string;
}

export interface PipelineStats {
  total: number;
  responded: number;
  failed: number;
  responseRate: number; // 0-1
  byAction: Record<string, { count: number; responded: number }>;
  latency: {
    agent: LatencyStats;
    composer: LatencyStats;
    total: LatencyStats;
  };
  recentErrors: string[];
}

// --- Singleton state ---

const agentLatency = new LatencyTracker();
const composerLatency = new LatencyTracker();
const totalLatency = new LatencyTracker();

let totalCount = 0;
let respondedCount = 0;
let failedCount = 0;
const actionCounts: Record<string, { count: number; responded: number }> = {};
const recentErrors: string[] = [];
const MAX_RECENT_ERRORS = 20;

/**
 * Record the outcome of a pipeline run.
 */
export function recordPipelineOutcome(outcome: PipelineOutcome): void {
  totalCount++;

  if (outcome.responded) {
    respondedCount++;
  }
  if (outcome.error) {
    failedCount++;
    recentErrors.push(`[${new Date().toISOString()}] ${outcome.action}: ${outcome.error}`);
    if (recentErrors.length > MAX_RECENT_ERRORS) {
      recentErrors.shift();
    }
  }

  // Track by action type
  if (!actionCounts[outcome.action]) {
    actionCounts[outcome.action] = { count: 0, responded: 0 };
  }
  actionCounts[outcome.action].count++;
  if (outcome.responded) {
    actionCounts[outcome.action].responded++;
  }

  // Record latencies
  if (outcome.agentMs !== undefined) {
    agentLatency.record(outcome.agentMs);
  }
  if (outcome.composerMs !== undefined) {
    composerLatency.record(outcome.composerMs);
  }
  totalLatency.record(outcome.totalMs);
}

/**
 * Get current pipeline stats.
 */
export function getPipelineStats(): PipelineStats {
  return {
    total: totalCount,
    responded: respondedCount,
    failed: failedCount,
    responseRate: totalCount > 0 ? Math.round((respondedCount / totalCount) * 1000) / 1000 : 0,
    byAction: { ...actionCounts },
    latency: {
      agent: agentLatency.stats(),
      composer: composerLatency.stats(),
      total: totalLatency.stats(),
    },
    recentErrors: [...recentErrors],
  };
}

/**
 * Reset all stats (for testing).
 */
export function resetPipelineStats(): void {
  totalCount = 0;
  respondedCount = 0;
  failedCount = 0;
  Object.keys(actionCounts).forEach(k => delete actionCounts[k]);
  recentErrors.length = 0;
  agentLatency.reset();
  composerLatency.reset();
  totalLatency.reset();
}
