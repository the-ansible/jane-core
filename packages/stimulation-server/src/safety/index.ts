/**
 * Unified safety gate — single entry point for all safety checks.
 * Combines rate limiters and circuit breakers into actionable decisions.
 */

import { createDefaultLimiters, type RateLimiters } from './rate-limiter.js';
import {
  createDefaultBreakers,
  type CircuitBreakers,
} from './circuit-breaker.js';

export interface SafetyCheckResult {
  allowed: boolean;
  reasons: string[];
}

export interface SafetyStatus {
  paused: boolean;
  rateLimits: Record<string, { allowed: boolean; current: number; limit: number }>;
  circuitBreakers: Record<string, { state: string; failures?: number; tripped?: boolean }>;
  llmLoop: { blockedTypes: string[] };
  memory: { rssBytes: number; underPressure: boolean };
}

function log(msg: string, data?: Record<string, unknown>) {
  console.log(JSON.stringify({
    level: 'warn',
    msg,
    component: 'safety',
    ...data,
    ts: new Date().toISOString(),
  }));
}

export class SafetyGate {
  readonly limiters: RateLimiters;
  readonly breakers: CircuitBreakers;
  private paused = false;

  constructor(opts?: {
    limiters?: RateLimiters;
    breakers?: CircuitBreakers;
  }) {
    this.limiters = opts?.limiters || createDefaultLimiters();
    this.breakers = opts?.breakers || createDefaultBreakers();
  }

  // --- Manual override ---

  pause(): void {
    this.paused = true;
    log('Safety: PAUSED — all actions blocked by manual override');
  }

  resume(): void {
    this.paused = false;
    log('Safety: RESUMED — manual override lifted');
  }

  isPaused(): boolean {
    return this.paused;
  }

  // --- Action checks ---

  /** Check if outbound message sending is allowed */
  canSend(now = Date.now()): SafetyCheckResult {
    const reasons: string[] = [];

    if (this.paused) reasons.push('System paused by manual override');
    if (!this.limiters.outboundMessages.check(now)) reasons.push('Outbound rate limit exceeded (30/hr)');
    if (!this.breakers.consecutiveErrors.isAllowed(now)) reasons.push('Circuit breaker open: consecutive errors');
    if (this.breakers.outboundFlood.isTripped()) reasons.push('Outbound flood detected (>10/min)');
    if (this.breakers.memory.isUnderPressure()) reasons.push('Memory pressure — shedding load');

    return { allowed: reasons.length === 0, reasons };
  }

  /** Record an outbound send (call after successful send) */
  recordSend(now = Date.now()): void {
    this.limiters.outboundMessages.record(now);
    const flooded = this.breakers.outboundFlood.record(now);
    if (flooded) {
      log('FLOOD DETECTED — outbound hard stop', { action: 'outbound_flood_trip' });
    }
  }

  /** Check if local LLM call is allowed */
  canCallLocalLlm(eventType: string, now = Date.now()): SafetyCheckResult {
    const reasons: string[] = [];

    if (this.paused) reasons.push('System paused by manual override');
    if (!this.limiters.llmLocal.check(now)) reasons.push('Local LLM rate limit exceeded (100/hr)');
    if (this.breakers.llmLoop.isBlocked(eventType)) reasons.push(`LLM loop detected for event type: ${eventType}`);
    if (this.breakers.memory.isUnderPressure()) reasons.push('Memory pressure — shedding load');

    return { allowed: reasons.length === 0, reasons };
  }

  /** Check if Claude API call is allowed */
  canCallClaude(eventType: string, now = Date.now()): SafetyCheckResult {
    const reasons: string[] = [];

    if (this.paused) reasons.push('System paused by manual override');
    if (!this.limiters.llmClaude.check(now)) reasons.push('Claude rate limit exceeded (10/hr)');
    if (this.breakers.llmLoop.isBlocked(eventType)) reasons.push(`LLM loop detected for event type: ${eventType}`);
    if (!this.breakers.consecutiveErrors.isAllowed(now)) reasons.push('Circuit breaker open: consecutive errors');

    return { allowed: reasons.length === 0, reasons };
  }

  /** Check if event processing is allowed (total throughput) */
  canProcess(now = Date.now()): SafetyCheckResult {
    const reasons: string[] = [];

    if (this.paused) reasons.push('System paused by manual override');
    if (!this.limiters.totalEvents.check(now)) reasons.push('Total event rate limit exceeded (500/hr)');

    return { allowed: reasons.length === 0, reasons };
  }

  /** Record event processing */
  recordProcess(now = Date.now()): void {
    this.limiters.totalEvents.record(now);
  }

  /** Record an LLM call (local or Claude) */
  recordLlmCall(type: 'local' | 'claude', eventType: string, now = Date.now()): void {
    if (type === 'local') {
      this.limiters.llmLocal.record(now);
    } else {
      this.limiters.llmClaude.record(now);
    }
    const looped = this.breakers.llmLoop.recordCall(eventType);
    if (looped) {
      log('LLM LOOP DETECTED — event type circuit-broken', { eventType });
    }
  }

  /** Record an action error (for consecutive error breaker) */
  recordError(now = Date.now()): boolean {
    const tripped = this.breakers.consecutiveErrors.recordFailure(now);
    if (tripped) {
      log('CIRCUIT BREAKER TRIPPED — consecutive errors', { action: 'error_breaker_trip' });
    }
    return tripped;
  }

  /** Record an action success (resets consecutive error count if half-open) */
  recordSuccess(): void {
    this.breakers.consecutiveErrors.recordSuccess();
  }

  // --- Status ---

  status(now = Date.now()): SafetyStatus {
    const outboundStatus = this.limiters.outboundMessages.status(now);
    const llmLocalStatus = this.limiters.llmLocal.status(now);
    const llmClaudeStatus = this.limiters.llmClaude.status(now);
    const totalStatus = this.limiters.totalEvents.status(now);
    const errorStatus = this.breakers.consecutiveErrors.status(now);
    const floodStatus = this.breakers.outboundFlood.status();
    const memoryStatus = this.breakers.memory.status();
    const llmLoopStatus = this.breakers.llmLoop.status();

    return {
      paused: this.paused,
      rateLimits: {
        outbound_messages: { allowed: outboundStatus.allowed, current: outboundStatus.current, limit: outboundStatus.limit },
        llm_local: { allowed: llmLocalStatus.allowed, current: llmLocalStatus.current, limit: llmLocalStatus.limit },
        llm_claude: { allowed: llmClaudeStatus.allowed, current: llmClaudeStatus.current, limit: llmClaudeStatus.limit },
        total_events: { allowed: totalStatus.allowed, current: totalStatus.current, limit: totalStatus.limit },
      },
      circuitBreakers: {
        consecutive_errors: { state: errorStatus.state, failures: errorStatus.failures },
        outbound_flood: { state: floodStatus.tripped ? 'tripped' : 'ok', tripped: floodStatus.tripped },
      },
      llmLoop: { blockedTypes: llmLoopStatus.blockedTypes },
      memory: { rssBytes: memoryStatus.rssBytes, underPressure: memoryStatus.underPressure },
    };
  }

  /** Full reset — use for testing */
  reset(): void {
    this.paused = false;
    this.limiters.outboundMessages.reset();
    this.limiters.llmLocal.reset();
    this.limiters.llmClaude.reset();
    this.limiters.totalEvents.reset();
    this.breakers.consecutiveErrors.reset();
    this.breakers.outboundFlood.reset();
    this.breakers.llmLoop.reset();
  }
}
