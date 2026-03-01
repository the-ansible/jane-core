import { describe, it, expect, beforeEach } from 'vitest';
import { SafetyGate } from '../safety/index.js';
import { createDefaultBreakers } from '../safety/circuit-breaker.js';
import { MemoryMonitor } from '../safety/circuit-breaker.js';
import { RateLimiter } from '../safety/rate-limiter.js';

function createTestGate() {
  const breakers = createDefaultBreakers();
  // Use a very high memory threshold so tests don't fail due to Vitest RSS
  (breakers as any).memory = new MemoryMonitor(4096);
  return new SafetyGate({ breakers });
}

/** Create a gate with enforcing (non-alertOnly) rate limiters for testing blocking behavior */
function createEnforcingGate() {
  const breakers = createDefaultBreakers();
  (breakers as any).memory = new MemoryMonitor(4096);
  const limiters = {
    outboundMessages: new RateLimiter({ name: 'outbound_messages', limit: 30, windowMs: 60_000, alertOnly: false }),
    llmLocal: new RateLimiter({ name: 'llm_local', limit: 100, windowMs: 60_000, alertOnly: false }),
    llmClaude: new RateLimiter({ name: 'llm_claude', limit: 10, windowMs: 60_000, alertOnly: false }),
    totalEvents: new RateLimiter({ name: 'total_events', limit: 500, windowMs: 3_600_000, alertOnly: false }),
  };
  return new SafetyGate({ limiters, breakers });
}

describe('SafetyGate', () => {
  let gate: SafetyGate;

  beforeEach(() => {
    gate = createTestGate();
  });

  describe('pause/resume', () => {
    it('blocks all actions when paused', () => {
      gate.pause();
      expect(gate.canSend().allowed).toBe(false);
      expect(gate.canSend().reasons).toContain('System paused by manual override');
      expect(gate.canProcess().allowed).toBe(false);
      expect(gate.canCallLocalLlm('chat').allowed).toBe(false);
      expect(gate.canCallClaude('chat').allowed).toBe(false);
    });

    it('allows actions after resume', () => {
      gate.pause();
      gate.resume();
      expect(gate.canSend().allowed).toBe(true);
      expect(gate.canProcess().allowed).toBe(true);
    });

    it('reports paused state', () => {
      expect(gate.isPaused()).toBe(false);
      gate.pause();
      expect(gate.isPaused()).toBe(true);
    });
  });

  describe('canSend (alert-only mode — default)', () => {
    it('allows sends within rate limit', () => {
      expect(gate.canSend().allowed).toBe(true);
    });

    it('still allows when rate limit exceeded in alert-only mode', () => {
      // Spread sends across time to avoid triggering flood detector (10/min circuit breaker)
      // Rate limit is 30/min, flood is 10/min — so we need to exceed 30 without 11 in one minute
      const now = Date.now();
      // Send 10 in minute 1, 10 in minute 2, 10 in minute 3 — 30 within the 1-min rate window won't work
      // Instead: just record directly to the rate limiter to test alert-only behavior
      for (let i = 0; i < 30; i++) {
        gate.limiters.outboundMessages.record(now);
      }
      // Alert-only: allowed is still true, but status shows exceeded
      expect(gate.canSend(now).allowed).toBe(true);
      const status = gate.status(now);
      expect(status.rateLimits.outbound_messages.exceeded).toBe(true);
      expect(status.rateLimits.outbound_messages.alertOnly).toBe(true);
    });

    it('blocks when consecutive error breaker is open', () => {
      const now = Date.now();
      for (let i = 0; i < 5; i++) {
        gate.recordError(now);
      }
      expect(gate.canSend(now).allowed).toBe(false);
      expect(gate.canSend(now).reasons[0]).toContain('Circuit breaker open');
    });

    it('blocks when outbound flood is tripped', () => {
      const now = Date.now();
      for (let i = 0; i < 11; i++) {
        gate.recordSend(now);
      }
      expect(gate.canSend(now).allowed).toBe(false);
      expect(gate.canSend(now).reasons.some(r => r.includes('flood'))).toBe(true);
    });
  });

  describe('canSend (enforcing mode)', () => {
    it('blocks after outbound rate limit exceeded', () => {
      const enforcing = createEnforcingGate();
      const now = Date.now();
      for (let i = 0; i < 30; i++) {
        enforcing.recordSend(now);
      }
      expect(enforcing.canSend(now).allowed).toBe(false);
      expect(enforcing.canSend(now).reasons[0]).toContain('Outbound rate limit');
    });
  });

  describe('canCallLocalLlm', () => {
    it('allows within limits', () => {
      expect(gate.canCallLocalLlm('chat').allowed).toBe(true);
    });

    it('still allows in alert-only mode when rate exceeded', () => {
      const now = Date.now();
      for (let i = 0; i < 100; i++) {
        gate.recordLlmCall('local', `type-${i}`, now); // different types to avoid loop detection
      }
      // Alert-only: still allowed
      expect(gate.canCallLocalLlm('new-type', now).allowed).toBe(true);
      const status = gate.status(now);
      expect(status.rateLimits.llm_local.exceeded).toBe(true);
    });

    it('blocks when LLM loop detected (circuit breaker, not rate limit)', () => {
      const now = Date.now();
      // 15 calls per event type threshold (within 60s window)
      for (let i = 0; i < 16; i++) {
        gate.recordLlmCall('local', 'chat', now);
      }
      expect(gate.canCallLocalLlm('chat', now).allowed).toBe(false);
      expect(gate.canCallLocalLlm('email', now).allowed).toBe(true); // different type is fine
    });
  });

  describe('canCallClaude', () => {
    it('still allows in alert-only mode when rate exceeded', () => {
      const now = Date.now();
      for (let i = 0; i < 10; i++) {
        gate.recordLlmCall('claude', `type-${i}`, now);
      }
      // Alert-only: still allowed
      expect(gate.canCallClaude('new-type', now).allowed).toBe(true);
      const status = gate.status(now);
      expect(status.rateLimits.llm_claude.exceeded).toBe(true);
    });

    it('blocks in enforcing mode when rate exceeded', () => {
      const enforcing = createEnforcingGate();
      const now = Date.now();
      for (let i = 0; i < 10; i++) {
        enforcing.recordLlmCall('claude', `type-${i}`, now);
      }
      expect(enforcing.canCallClaude('new-type', now).allowed).toBe(false);
    });
  });

  describe('canProcess', () => {
    it('allows within total event limit', () => {
      expect(gate.canProcess().allowed).toBe(true);
    });

    it('still allows in alert-only mode when total exceeded', () => {
      const now = Date.now();
      for (let i = 0; i < 500; i++) {
        gate.recordProcess(now);
      }
      // Alert-only: still allowed
      expect(gate.canProcess(now).allowed).toBe(true);
      const status = gate.status(now);
      expect(status.rateLimits.total_events.exceeded).toBe(true);
    });
  });

  describe('error tracking', () => {
    it('recordError returns true when breaker trips', () => {
      const now = Date.now();
      expect(gate.recordError(now)).toBe(false);
      expect(gate.recordError(now)).toBe(false);
      expect(gate.recordError(now)).toBe(false);
      expect(gate.recordError(now)).toBe(false);
      expect(gate.recordError(now)).toBe(true); // 5th — trips
    });

    it('recordSuccess resets after half-open transition', () => {
      const now = Date.now();
      for (let i = 0; i < 5; i++) gate.recordError(now);
      // Breaker is open, wait for reset time (5 min)
      const afterReset = now + 5 * 60 * 1000;
      expect(gate.canSend(afterReset).allowed).toBe(true); // half-open
      gate.recordSuccess();
      // Should be fully closed now
      const status = gate.status();
      expect(status.circuitBreakers.consecutive_errors.state).toBe('closed');
    });
  });

  describe('status', () => {
    it('returns full safety status', () => {
      const status = gate.status();
      expect(status.paused).toBe(false);
      expect(status.rateLimits.outbound_messages.allowed).toBe(true);
      expect(status.rateLimits.llm_local.allowed).toBe(true);
      expect(status.rateLimits.llm_claude.allowed).toBe(true);
      expect(status.rateLimits.total_events.allowed).toBe(true);
      expect(status.circuitBreakers.consecutive_errors.state).toBe('closed');
      expect(status.circuitBreakers.outbound_flood.tripped).toBe(false);
      expect(status.llmLoop.blockedTypes).toEqual([]);
      expect(status.memory.underPressure).toBe(false);
    });
  });

  describe('reset', () => {
    it('clears all state', () => {
      gate.pause();
      gate.recordSend();
      gate.recordError();
      gate.recordLlmCall('local', 'chat');
      gate.reset();

      expect(gate.isPaused()).toBe(false);
      expect(gate.canSend().allowed).toBe(true);
      const status = gate.status();
      expect(status.rateLimits.outbound_messages.current).toBe(0);
    });
  });
});
