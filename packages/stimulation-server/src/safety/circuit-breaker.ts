/**
 * Circuit breakers for safety-critical failure modes.
 * Each breaker tracks a specific failure pattern and trips when thresholds are exceeded.
 */

export type BreakerState = 'closed' | 'open' | 'half-open';

export interface BreakerStatus {
  name: string;
  state: BreakerState;
  failures: number;
  threshold: number;
  /** When the breaker will auto-reset (0 if closed) */
  resetsAtMs: number;
  lastFailureAt: string | null;
}

export interface BreakerConfig {
  name: string;
  /** Number of failures before tripping */
  threshold: number;
  /** How long to stay open before trying half-open (ms) */
  resetTimeMs: number;
}

export class CircuitBreaker {
  private state: BreakerState = 'closed';
  private failures = 0;
  private openedAt = 0;
  private lastFailureAt: string | null = null;
  private readonly config: BreakerConfig;

  constructor(config: BreakerConfig) {
    this.config = config;
  }

  /** Record a failure. Returns true if breaker just tripped. */
  recordFailure(now = Date.now()): boolean {
    this.failures++;
    this.lastFailureAt = new Date(now).toISOString();

    if (this.failures >= this.config.threshold && this.state === 'closed') {
      this.state = 'open';
      this.openedAt = now;
      return true; // just tripped
    }
    return false;
  }

  /** Record a success. Resets if half-open, no-op if closed. */
  recordSuccess(): void {
    if (this.state === 'half-open') {
      this.state = 'closed';
      this.failures = 0;
    }
  }

  /** Check if action is allowed. Transitions open → half-open after reset time. */
  isAllowed(now = Date.now()): boolean {
    if (this.state === 'closed') return true;

    if (this.state === 'open') {
      if (now - this.openedAt >= this.config.resetTimeMs) {
        this.state = 'half-open';
        return true; // allow one attempt
      }
      return false;
    }

    // half-open: allow (waiting for success/failure to decide)
    return true;
  }

  /** Force trip the breaker */
  trip(now = Date.now()): void {
    this.state = 'open';
    this.openedAt = now;
    this.failures = this.config.threshold;
  }

  /** Force reset the breaker */
  reset(): void {
    this.state = 'closed';
    this.failures = 0;
    this.openedAt = 0;
  }

  status(now = Date.now()): BreakerStatus {
    // Check for auto-transition
    if (this.state === 'open' && now - this.openedAt >= this.config.resetTimeMs) {
      this.state = 'half-open';
    }

    return {
      name: this.config.name,
      state: this.state,
      failures: this.failures,
      threshold: this.config.threshold,
      resetsAtMs: this.state === 'open'
        ? Math.max(0, this.openedAt + this.config.resetTimeMs - now)
        : 0,
      lastFailureAt: this.lastFailureAt,
    };
  }
}

// --- Outbound flood detector (separate pattern: count-per-window, not consecutive) ---

export class FloodDetector {
  private timestamps: number[] = [];
  private tripped = false;
  private readonly name: string;
  private readonly limit: number;
  private readonly windowMs: number;

  constructor(name: string, limit: number, windowMs: number) {
    this.name = name;
    this.limit = limit;
    this.windowMs = windowMs;
  }

  /** Record an outbound event. Returns true if flood detected. */
  record(now = Date.now()): boolean {
    this.prune(now);
    this.timestamps.push(now);
    if (this.timestamps.length > this.limit) {
      this.tripped = true;
      return true;
    }
    return false;
  }

  isTripped(): boolean {
    return this.tripped;
  }

  /** Manual reset only — flood detection requires human intervention */
  reset(): void {
    this.tripped = false;
    this.timestamps = [];
  }

  status(): { name: string; tripped: boolean; current: number; limit: number } {
    return {
      name: this.name,
      tripped: this.tripped,
      current: this.timestamps.length,
      limit: this.limit,
    };
  }

  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    while (this.timestamps.length > 0 && this.timestamps[0] < cutoff) {
      this.timestamps.shift();
    }
  }
}

// --- LLM loop detector (per event-type tracking with sliding window) ---

export class LlmLoopDetector {
  private callTimestamps = new Map<string, number[]>();
  private blockedTypes = new Set<string>();
  private readonly threshold: number;
  private readonly windowMs: number;

  constructor(threshold = 10, windowMs = 60_000) {
    this.threshold = threshold;
    this.windowMs = windowMs;
  }

  /** Record an LLM call for an event type. Returns true if loop detected. */
  recordCall(eventType: string, now = Date.now()): boolean {
    const cutoff = now - this.windowMs;
    const timestamps = this.callTimestamps.get(eventType) || [];
    // Keep only timestamps within the window
    const recent = timestamps.filter(t => t > cutoff);
    recent.push(now);
    this.callTimestamps.set(eventType, recent);

    if (recent.length > this.threshold) {
      this.blockedTypes.add(eventType);
      return true;
    }
    // Auto-unblock if we've dropped below threshold (window expired)
    this.blockedTypes.delete(eventType);
    return false;
  }

  /** Check if an event type is blocked */
  isBlocked(eventType: string, now = Date.now()): boolean {
    if (!this.blockedTypes.has(eventType)) return false;
    // Re-check with current window — auto-unblock if calls aged out
    const cutoff = now - this.windowMs;
    const timestamps = this.callTimestamps.get(eventType) || [];
    const recent = timestamps.filter(t => t > cutoff);
    this.callTimestamps.set(eventType, recent);
    if (recent.length <= this.threshold) {
      this.blockedTypes.delete(eventType);
      return false;
    }
    return true;
  }

  /** Reset counts for a specific event type */
  resetType(eventType: string): void {
    this.callTimestamps.delete(eventType);
    this.blockedTypes.delete(eventType);
  }

  /** Full reset */
  reset(): void {
    this.callTimestamps.clear();
    this.blockedTypes.clear();
  }

  status(): { blockedTypes: string[]; callCounts: Record<string, number> } {
    return {
      blockedTypes: Array.from(this.blockedTypes),
      callCounts: Object.fromEntries(
        Array.from(this.callTimestamps.entries()).map(([k, v]) => [k, v.length])
      ),
    };
  }
}

// --- Memory pressure monitor ---

export class MemoryMonitor {
  private readonly thresholdBytes: number;

  constructor(thresholdMb = 512) {
    this.thresholdBytes = thresholdMb * 1024 * 1024;
  }

  isUnderPressure(): boolean {
    return process.memoryUsage().rss > this.thresholdBytes;
  }

  status(): { rssBytes: number; thresholdBytes: number; underPressure: boolean } {
    const rss = process.memoryUsage().rss;
    return {
      rssBytes: rss,
      thresholdBytes: this.thresholdBytes,
      underPressure: rss > this.thresholdBytes,
    };
  }
}

// --- Default circuit breakers per spec ---

const FIVE_MINUTES = 5 * 60 * 1000;
const ONE_MINUTE = 60 * 1000;

export function createDefaultBreakers() {
  return {
    consecutiveErrors: new CircuitBreaker({
      name: 'consecutive_errors',
      threshold: 5,
      resetTimeMs: FIVE_MINUTES,
    }),
    outboundFlood: new FloodDetector('outbound_flood', 10, ONE_MINUTE),
    llmLoop: new LlmLoopDetector(15, ONE_MINUTE),
    memory: new MemoryMonitor(256),
  };
}

export type CircuitBreakers = ReturnType<typeof createDefaultBreakers>;
