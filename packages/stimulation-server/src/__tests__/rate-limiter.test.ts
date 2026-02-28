import { describe, it, expect } from 'vitest';
import { RateLimiter } from '../safety/rate-limiter.js';

describe('RateLimiter', () => {
  it('allows events under the limit', () => {
    const limiter = new RateLimiter({ name: 'test', limit: 3, windowMs: 1000 });
    expect(limiter.check()).toBe(true);
    expect(limiter.record()).toBe(true); // 1
    expect(limiter.record()).toBe(true); // 2
    expect(limiter.record()).toBe(true); // 3
  });

  it('blocks events over the limit', () => {
    const limiter = new RateLimiter({ name: 'test', limit: 2, windowMs: 1000 });
    const now = 1000;
    limiter.record(now); // 1
    limiter.record(now); // 2
    expect(limiter.check(now)).toBe(false);
    expect(limiter.record(now)).toBe(false); // 3 — over limit
  });

  it('allows events after window expires', () => {
    const limiter = new RateLimiter({ name: 'test', limit: 2, windowMs: 1000 });
    limiter.record(1000); // 1
    limiter.record(1000); // 2
    expect(limiter.check(1000)).toBe(false);

    // After window expires
    expect(limiter.check(2001)).toBe(true);
    expect(limiter.record(2001)).toBe(true);
  });

  it('status reports current state', () => {
    const limiter = new RateLimiter({ name: 'outbound', limit: 5, windowMs: 60000 });
    const now = 10000;
    limiter.record(now);
    limiter.record(now);

    const status = limiter.status(now);
    expect(status.name).toBe('outbound');
    expect(status.current).toBe(2);
    expect(status.limit).toBe(5);
    expect(status.allowed).toBe(true);
  });

  it('status shows blocked when at limit', () => {
    const limiter = new RateLimiter({ name: 'test', limit: 1, windowMs: 1000 });
    limiter.record(1000);
    const status = limiter.status(1000);
    expect(status.allowed).toBe(false);
    expect(status.current).toBe(1);
  });

  it('reset clears all timestamps', () => {
    const limiter = new RateLimiter({ name: 'test', limit: 1, windowMs: 60000 });
    limiter.record();
    expect(limiter.check()).toBe(false);
    limiter.reset();
    expect(limiter.check()).toBe(true);
  });

  it('sliding window prunes old entries', () => {
    const limiter = new RateLimiter({ name: 'test', limit: 2, windowMs: 100 });
    limiter.record(1000); // will expire
    limiter.record(1050); // will expire
    expect(limiter.check(1050)).toBe(false);

    // First entry expired, second still in window
    expect(limiter.check(1101)).toBe(true);
  });
});
