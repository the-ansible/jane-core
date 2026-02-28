/**
 * Unified safety gate — single entry point for all safety checks.
 * Combines rate limiters and circuit breakers into actionable decisions.
 */

import { createDefaultLimiters, type RateLimiters } from './rate-limiter.js';
import {
  createDefaultBreakers,
  type CircuitBreakers,
} from './circuit-breaker.js';
import type { NatsClient } from '../nats/client.js';

export interface SafetyCheckResult {
  allowed: boolean;
  reasons: string[];
}

export interface SafetyStatus {
  paused: boolean;
  rateLimits: Record<string, { allowed: boolean; current: number; limit: number; alertOnly: boolean; exceeded: boolean }>;
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
  private nats: NatsClient | null = null;

  constructor(opts?: {
    limiters?: RateLimiters;
    breakers?: CircuitBreakers;
  }) {
    this.limiters = opts?.limiters || createDefaultLimiters();
    this.breakers = opts?.breakers || createDefaultBreakers();
  }

  /** Set NATS client for publishing alert events */
  setNats(nats: NatsClient): void {
    this.nats = nats;
  }

  /** Publish an alert event to NATS for visibility */
  private async publishAlert(alertType: string, details: Record<string, unknown>): Promise<void> {
    if (!this.nats?.isConnected()) return;
    try {
      await this.nats.publish('communication.internal.safety-alert', {
        id: `alert-${Date.now()}`,
        sessionId: 'system',
        channelType: 'internal',
        direction: 'outbound' as const,
        contentType: 'markdown' as const,
        content: `Safety alert: ${alertType}`,
        sender: { id: 'safety-gate', type: 'system' },
        recipients: [{ id: 'jane', type: 'agent' }],
        metadata: { alertType, ...details },
        timestamp: new Date().toISOString(),
      });
    } catch {
      // Don't let alert publishing failures cascade
    }
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

    const outboundStatus = this.limiters.outboundMessages.status(now);
    if (outboundStatus.exceeded) {
      const msg = `Outbound rate limit exceeded (${outboundStatus.current}/${outboundStatus.limit} per window)`;
      if (outboundStatus.alertOnly) {
        log('RATE ALERT: ' + msg, { limiter: 'outbound_messages', current: outboundStatus.current, limit: outboundStatus.limit });
        this.publishAlert('rate-limit-exceeded', { limiter: 'outbound_messages', current: outboundStatus.current, limit: outboundStatus.limit });
      } else {
        reasons.push(msg);
      }
    }

    if (!this.breakers.consecutiveErrors.isAllowed(now)) reasons.push('Circuit breaker open: consecutive errors');
    if (this.breakers.outboundFlood.isTripped()) reasons.push('Outbound flood detected');
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

    const localStatus = this.limiters.llmLocal.status(now);
    if (localStatus.exceeded) {
      const msg = `Local LLM rate limit exceeded (${localStatus.current}/${localStatus.limit} per window)`;
      if (localStatus.alertOnly) {
        log('RATE ALERT: ' + msg, { limiter: 'llm_local', current: localStatus.current, limit: localStatus.limit });
        this.publishAlert('rate-limit-exceeded', { limiter: 'llm_local', current: localStatus.current, limit: localStatus.limit });
      } else {
        reasons.push(msg);
      }
    }

    if (this.breakers.llmLoop.isBlocked(eventType)) reasons.push(`LLM loop detected for event type: ${eventType}`);
    if (this.breakers.memory.isUnderPressure()) reasons.push('Memory pressure — shedding load');

    return { allowed: reasons.length === 0, reasons };
  }

  /** Check if Claude API call is allowed */
  canCallClaude(eventType: string, now = Date.now()): SafetyCheckResult {
    const reasons: string[] = [];

    if (this.paused) reasons.push('System paused by manual override');

    const claudeStatus = this.limiters.llmClaude.status(now);
    if (claudeStatus.exceeded) {
      const msg = `Claude rate limit exceeded (${claudeStatus.current}/${claudeStatus.limit} per window)`;
      if (claudeStatus.alertOnly) {
        log('RATE ALERT: ' + msg, { limiter: 'llm_claude', current: claudeStatus.current, limit: claudeStatus.limit });
        this.publishAlert('rate-limit-exceeded', { limiter: 'llm_claude', current: claudeStatus.current, limit: claudeStatus.limit });
      } else {
        reasons.push(msg);
      }
    }

    if (this.breakers.llmLoop.isBlocked(eventType)) reasons.push(`LLM loop detected for event type: ${eventType}`);
    if (!this.breakers.consecutiveErrors.isAllowed(now)) reasons.push('Circuit breaker open: consecutive errors');

    return { allowed: reasons.length === 0, reasons };
  }

  /** Check if event processing is allowed (total throughput) */
  canProcess(now = Date.now()): SafetyCheckResult {
    const reasons: string[] = [];

    if (this.paused) reasons.push('System paused by manual override');

    const totalStatus = this.limiters.totalEvents.status(now);
    if (totalStatus.exceeded) {
      const msg = `Total event rate limit exceeded (${totalStatus.current}/${totalStatus.limit} per window)`;
      if (totalStatus.alertOnly) {
        log('RATE ALERT: ' + msg, { limiter: 'total_events', current: totalStatus.current, limit: totalStatus.limit });
        this.publishAlert('rate-limit-exceeded', { limiter: 'total_events', current: totalStatus.current, limit: totalStatus.limit });
      } else {
        reasons.push(msg);
      }
    }

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
        outbound_messages: { allowed: outboundStatus.allowed, current: outboundStatus.current, limit: outboundStatus.limit, alertOnly: outboundStatus.alertOnly, exceeded: outboundStatus.exceeded },
        llm_local: { allowed: llmLocalStatus.allowed, current: llmLocalStatus.current, limit: llmLocalStatus.limit, alertOnly: llmLocalStatus.alertOnly, exceeded: llmLocalStatus.exceeded },
        llm_claude: { allowed: llmClaudeStatus.allowed, current: llmClaudeStatus.current, limit: llmClaudeStatus.limit, alertOnly: llmClaudeStatus.alertOnly, exceeded: llmClaudeStatus.exceeded },
        total_events: { allowed: totalStatus.allowed, current: totalStatus.current, limit: totalStatus.limit, alertOnly: totalStatus.alertOnly, exceeded: totalStatus.exceeded },
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
