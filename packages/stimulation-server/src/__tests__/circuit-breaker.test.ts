import { describe, it, expect } from 'vitest';
import {
  CircuitBreaker,
  FloodDetector,
  LlmLoopDetector,
} from '../safety/circuit-breaker.js';

describe('CircuitBreaker', () => {
  it('starts closed and allows actions', () => {
    const cb = new CircuitBreaker({ name: 'test', threshold: 3, resetTimeMs: 5000 });
    expect(cb.isAllowed()).toBe(true);
    expect(cb.status().state).toBe('closed');
  });

  it('trips after threshold consecutive failures', () => {
    const cb = new CircuitBreaker({ name: 'test', threshold: 3, resetTimeMs: 5000 });
    expect(cb.recordFailure()).toBe(false); // 1
    expect(cb.recordFailure()).toBe(false); // 2
    expect(cb.recordFailure()).toBe(true);  // 3 — trips!
    expect(cb.isAllowed()).toBe(false);
    expect(cb.status().state).toBe('open');
  });

  it('transitions to half-open after reset time', () => {
    const cb = new CircuitBreaker({ name: 'test', threshold: 2, resetTimeMs: 1000 });
    const now = 10000;
    cb.recordFailure(now);
    cb.recordFailure(now); // trips

    expect(cb.isAllowed(now + 500)).toBe(false);  // still open
    expect(cb.isAllowed(now + 1000)).toBe(true);   // half-open
    expect(cb.status(now + 1000).state).toBe('half-open');
  });

  it('closes on success in half-open state', () => {
    const cb = new CircuitBreaker({ name: 'test', threshold: 1, resetTimeMs: 100 });
    cb.recordFailure(1000); // trips
    cb.isAllowed(1101); // transition to half-open
    cb.recordSuccess();
    expect(cb.status().state).toBe('closed');
    expect(cb.status().failures).toBe(0);
  });

  it('force trip and reset work', () => {
    const cb = new CircuitBreaker({ name: 'test', threshold: 5, resetTimeMs: 5000 });
    cb.trip();
    expect(cb.isAllowed()).toBe(false);
    cb.reset();
    expect(cb.isAllowed()).toBe(true);
    expect(cb.status().failures).toBe(0);
  });
});

describe('FloodDetector', () => {
  it('allows events under the limit', () => {
    const fd = new FloodDetector('test', 3, 1000);
    expect(fd.record(1000)).toBe(false);
    expect(fd.record(1000)).toBe(false);
    expect(fd.record(1000)).toBe(false);
    expect(fd.isTripped()).toBe(false);
  });

  it('trips when limit exceeded in window', () => {
    const fd = new FloodDetector('test', 2, 1000);
    fd.record(1000);
    fd.record(1000);
    expect(fd.record(1000)).toBe(true); // 3rd in window of 2
    expect(fd.isTripped()).toBe(true);
  });

  it('stays tripped even after window expires (manual reset required)', () => {
    const fd = new FloodDetector('test', 1, 100);
    fd.record(1000);
    fd.record(1000); // trips
    expect(fd.isTripped()).toBe(true);

    // Even after window expires, stays tripped
    fd.record(2000);
    expect(fd.isTripped()).toBe(true);
  });

  it('manual reset clears tripped state', () => {
    const fd = new FloodDetector('test', 1, 100);
    fd.record(1000);
    fd.record(1000);
    expect(fd.isTripped()).toBe(true);
    fd.reset();
    expect(fd.isTripped()).toBe(false);
  });

  it('status reports current state', () => {
    const fd = new FloodDetector('outbound', 5, 1000);
    fd.record(1000);
    fd.record(1000);
    const status = fd.status();
    expect(status.name).toBe('outbound');
    expect(status.current).toBe(2);
    expect(status.limit).toBe(5);
    expect(status.tripped).toBe(false);
  });
});

describe('LlmLoopDetector', () => {
  it('allows calls under threshold', () => {
    const ld = new LlmLoopDetector(3, 60_000);
    const now = Date.now();
    expect(ld.recordCall('chat', now)).toBe(false); // 1
    expect(ld.recordCall('chat', now)).toBe(false); // 2
    expect(ld.recordCall('chat', now)).toBe(false); // 3
    expect(ld.isBlocked('chat', now)).toBe(false);
  });

  it('blocks event type after exceeding threshold', () => {
    const ld = new LlmLoopDetector(2, 60_000);
    const now = Date.now();
    ld.recordCall('chat', now); // 1
    ld.recordCall('chat', now); // 2
    expect(ld.recordCall('chat', now)).toBe(true); // 3 — over threshold
    expect(ld.isBlocked('chat', now)).toBe(true);
  });

  it('tracks event types independently', () => {
    const ld = new LlmLoopDetector(2, 60_000);
    const now = Date.now();
    ld.recordCall('chat', now);
    ld.recordCall('chat', now);
    ld.recordCall('chat', now); // blocks chat

    expect(ld.isBlocked('chat', now)).toBe(true);
    expect(ld.isBlocked('email', now)).toBe(false);
    expect(ld.recordCall('email', now)).toBe(false);
  });

  it('auto-unblocks after window expires', () => {
    const ld = new LlmLoopDetector(2, 10_000); // 10s window
    const t0 = 1000000;
    ld.recordCall('chat', t0);
    ld.recordCall('chat', t0);
    ld.recordCall('chat', t0); // blocks
    expect(ld.isBlocked('chat', t0)).toBe(true);

    // After window expires, should auto-unblock
    expect(ld.isBlocked('chat', t0 + 11_000)).toBe(false);
    // New calls should work again
    expect(ld.recordCall('chat', t0 + 11_000)).toBe(false);
  });

  it('resetType clears specific type', () => {
    const ld = new LlmLoopDetector(1, 60_000);
    const now = Date.now();
    ld.recordCall('chat', now);
    ld.recordCall('chat', now);
    expect(ld.isBlocked('chat', now)).toBe(true);
    ld.resetType('chat');
    expect(ld.isBlocked('chat', now)).toBe(false);
  });

  it('full reset clears everything', () => {
    const ld = new LlmLoopDetector(1, 60_000);
    const now = Date.now();
    ld.recordCall('chat', now);
    ld.recordCall('chat', now);
    ld.recordCall('email', now);
    ld.recordCall('email', now);
    ld.reset();
    expect(ld.isBlocked('chat', now)).toBe(false);
    expect(ld.isBlocked('email', now)).toBe(false);
  });
});
