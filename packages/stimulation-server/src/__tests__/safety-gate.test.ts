import { describe, it, expect, beforeEach } from 'vitest';
import { SafetyGate } from '../safety/index.js';
import { createDefaultBreakers } from '../safety/circuit-breaker.js';
import { MemoryMonitor } from '../safety/circuit-breaker.js';

function createTestGate() {
  const breakers = createDefaultBreakers();
  // Use a very high memory threshold so tests don't fail due to Vitest RSS
  (breakers as any).memory = new MemoryMonitor(4096);
  return new SafetyGate({ breakers });
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

  describe('canSend', () => {
    it('allows sends within rate limit', () => {
      expect(gate.canSend().allowed).toBe(true);
    });

    it('blocks after outbound rate limit exceeded', () => {
      const now = Date.now();
      for (let i = 0; i < 30; i++) {
        gate.recordSend(now);
      }
      expect(gate.canSend(now).allowed).toBe(false);
      expect(gate.canSend(now).reasons[0]).toContain('Outbound rate limit');
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

  describe('canCallLocalLlm', () => {
    it('allows within limits', () => {
      expect(gate.canCallLocalLlm('chat').allowed).toBe(true);
    });

    it('blocks when rate limited', () => {
      const now = Date.now();
      for (let i = 0; i < 100; i++) {
        gate.recordLlmCall('local', 'chat', now);
      }
      expect(gate.canCallLocalLlm('chat', now).allowed).toBe(false);
    });

    it('blocks when LLM loop detected', () => {
      const now = Date.now();
      // 3 calls per event type threshold
      gate.recordLlmCall('local', 'chat', now);
      gate.recordLlmCall('local', 'chat', now);
      gate.recordLlmCall('local', 'chat', now);
      gate.recordLlmCall('local', 'chat', now); // 4th triggers loop detection
      expect(gate.canCallLocalLlm('chat', now).allowed).toBe(false);
      expect(gate.canCallLocalLlm('email', now).allowed).toBe(true); // different type is fine
    });
  });

  describe('canCallClaude', () => {
    it('blocks after Claude rate limit', () => {
      const now = Date.now();
      for (let i = 0; i < 10; i++) {
        gate.recordLlmCall('claude', `type-${i}`, now); // different types to avoid loop detection
      }
      expect(gate.canCallClaude('new-type', now).allowed).toBe(false);
    });
  });

  describe('canProcess', () => {
    it('allows within total event limit', () => {
      expect(gate.canProcess().allowed).toBe(true);
    });

    it('blocks after total event limit exceeded', () => {
      const now = Date.now();
      for (let i = 0; i < 500; i++) {
        gate.recordProcess(now);
      }
      expect(gate.canProcess(now).allowed).toBe(false);
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
