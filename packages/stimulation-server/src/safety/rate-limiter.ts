/**
 * Rolling-window rate limiter.
 * Tracks timestamps of events in a sliding window and rejects when threshold is exceeded.
 */

export interface RateLimitConfig {
  /** Max events allowed in the window */
  limit: number;
  /** Window size in milliseconds */
  windowMs: number;
  /** Human-readable name for logging */
  name: string;
}

export interface RateLimitStatus {
  name: string;
  allowed: boolean;
  current: number;
  limit: number;
  windowMs: number;
  resetsInMs: number;
}

export class RateLimiter {
  private timestamps: number[] = [];
  private readonly config: RateLimitConfig;

  constructor(config: RateLimitConfig) {
    this.config = config;
  }

  /** Record an event and return whether it was within limits */
  record(now = Date.now()): boolean {
    this.prune(now);
    this.timestamps.push(now);
    return this.timestamps.length <= this.config.limit;
  }

  /** Check if an action would be allowed without recording it */
  check(now = Date.now()): boolean {
    this.prune(now);
    return this.timestamps.length < this.config.limit;
  }

  /** Get current status */
  status(now = Date.now()): RateLimitStatus {
    this.prune(now);
    const oldest = this.timestamps[0];
    const resetsInMs = oldest
      ? Math.max(0, oldest + this.config.windowMs - now)
      : 0;

    return {
      name: this.config.name,
      allowed: this.timestamps.length < this.config.limit,
      current: this.timestamps.length,
      limit: this.config.limit,
      windowMs: this.config.windowMs,
      resetsInMs,
    };
  }

  /** Remove timestamps outside the window */
  private prune(now: number): void {
    const cutoff = now - this.config.windowMs;
    while (this.timestamps.length > 0 && this.timestamps[0] < cutoff) {
      this.timestamps.shift();
    }
  }

  reset(): void {
    this.timestamps = [];
  }
}

// --- Default rate limiters per spec ---

const ONE_HOUR = 60 * 60 * 1000;

export function createDefaultLimiters() {
  return {
    outboundMessages: new RateLimiter({
      name: 'outbound_messages',
      limit: 30,
      windowMs: ONE_HOUR,
    }),
    llmLocal: new RateLimiter({
      name: 'llm_local',
      limit: 100,
      windowMs: ONE_HOUR,
    }),
    llmClaude: new RateLimiter({
      name: 'llm_claude',
      limit: 10,
      windowMs: ONE_HOUR,
    }),
    totalEvents: new RateLimiter({
      name: 'total_events',
      limit: 500,
      windowMs: ONE_HOUR,
    }),
  };
}

export type RateLimiters = ReturnType<typeof createDefaultLimiters>;
