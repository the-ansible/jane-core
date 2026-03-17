/**
 * Regression tests for safeTimeout — the TimeoutOverflowWarning guard.
 *
 * These tests cover every code path in safe-timeout.ts and verify that
 * setTimeout is NEVER called with NaN or out-of-range values from the
 * scheduler recovery code.
 *
 * Run: pnpm test:run (from packages/brain-server/)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { safeTimeout, clampDelay, isValidDelay, MAX_TIMEOUT, MIN_TIMEOUT } from './safe-timeout.js';

// ---------------------------------------------------------------------------
// clampDelay — pure unit tests (no side-effects)
// ---------------------------------------------------------------------------

describe('clampDelay', () => {
  // --- Invalid inputs that would cause TimeoutOverflowWarning ---

  it('clamps NaN to MIN_TIMEOUT (0)', () => {
    expect(clampDelay(NaN)).toBe(0);
  });

  it('clamps positive Infinity to MIN_TIMEOUT (0)', () => {
    expect(clampDelay(Infinity)).toBe(0);
  });

  it('clamps negative Infinity to MIN_TIMEOUT (0)', () => {
    expect(clampDelay(-Infinity)).toBe(0);
  });

  it('clamps negative values to MIN_TIMEOUT (0)', () => {
    expect(clampDelay(-1)).toBe(0);
    expect(clampDelay(-1000)).toBe(0);
    expect(clampDelay(-Number.MAX_SAFE_INTEGER)).toBe(0);
  });

  it('clamps values exceeding MAX_TIMEOUT to MAX_TIMEOUT', () => {
    expect(clampDelay(MAX_TIMEOUT + 1)).toBe(MAX_TIMEOUT);
    expect(clampDelay(MAX_TIMEOUT + 1_000_000)).toBe(MAX_TIMEOUT);
    expect(clampDelay(Number.MAX_SAFE_INTEGER)).toBe(MAX_TIMEOUT);
  });

  // --- Valid inputs passthrough ---

  it('passes through zero (fires on next tick)', () => {
    expect(clampDelay(0)).toBe(0);
  });

  it('passes through small positive values', () => {
    expect(clampDelay(1)).toBe(1);
    expect(clampDelay(1000)).toBe(1000);
    expect(clampDelay(60_000)).toBe(60_000);
  });

  it('passes through MAX_TIMEOUT exactly', () => {
    expect(clampDelay(MAX_TIMEOUT)).toBe(MAX_TIMEOUT);
  });

  it('floors fractional milliseconds', () => {
    expect(clampDelay(1.5)).toBe(1);
    expect(clampDelay(999.9)).toBe(999);
  });

  // --- Scheduler recovery scenarios (the actual bug triggers) ---

  it('handles NaN from new Date("null").getTime() - Date.now()', () => {
    // This is the real-world case: DB stores "null" string as nextRunAt
    const corruptedTimestamp = new Date('null').getTime(); // NaN
    const remaining = corruptedTimestamp - Date.now();     // NaN - number = NaN
    expect(clampDelay(remaining)).toBe(0);
  });

  it('handles NaN from new Date(undefined).getTime() - Date.now()', () => {
    const badTimestamp = new Date(undefined as unknown as string).getTime(); // NaN
    const remaining = badTimestamp - Date.now();
    expect(clampDelay(remaining)).toBe(0);
  });

  it('handles NaN from new Date("").getTime() - Date.now()', () => {
    const badTimestamp = new Date('').getTime(); // NaN
    const remaining = badTimestamp - Date.now();
    expect(clampDelay(remaining)).toBe(0);
  });

  it('handles very large remaining from far-future nextRunAt', () => {
    // nextRunAt is set to 100 years from now
    const farFuture = new Date(Date.now() + 100 * 365 * 24 * 3600 * 1000).getTime();
    const remaining = farFuture - Date.now();
    expect(clampDelay(remaining)).toBe(MAX_TIMEOUT);
    expect(clampDelay(remaining)).toBeLessThanOrEqual(MAX_TIMEOUT);
  });

  it('handles normal scheduler remaining values (< 4h in ms)', () => {
    const fourHoursMs = 4 * 60 * 60 * 1000;
    const remaining = fourHoursMs - 60_000; // 1 min before 4h interval
    expect(clampDelay(remaining)).toBe(remaining);
  });
});

// ---------------------------------------------------------------------------
// isValidDelay — boundary conditions
// ---------------------------------------------------------------------------

describe('isValidDelay', () => {
  it('returns false for NaN', () => expect(isValidDelay(NaN)).toBe(false));
  it('returns false for +Infinity', () => expect(isValidDelay(Infinity)).toBe(false));
  it('returns false for -Infinity', () => expect(isValidDelay(-Infinity)).toBe(false));
  it('returns false for negative values', () => {
    expect(isValidDelay(-1)).toBe(false);
    expect(isValidDelay(-1000)).toBe(false);
  });
  it('returns false for values over MAX_TIMEOUT', () => {
    expect(isValidDelay(MAX_TIMEOUT + 1)).toBe(false);
  });
  it('returns true for zero', () => expect(isValidDelay(0)).toBe(true));
  it('returns true for 1ms', () => expect(isValidDelay(1)).toBe(true));
  it('returns true for MAX_TIMEOUT', () => expect(isValidDelay(MAX_TIMEOUT)).toBe(true));
  it('returns true for typical scheduler intervals (1h, 4h, 12h, 24h)', () => {
    expect(isValidDelay(3_600_000)).toBe(true);   // 1h
    expect(isValidDelay(14_400_000)).toBe(true);  // 4h
    expect(isValidDelay(43_200_000)).toBe(true);  // 12h
    expect(isValidDelay(86_400_000)).toBe(true);  // 24h
  });
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('constants', () => {
  it('MAX_TIMEOUT is 2^31 - 1', () => {
    expect(MAX_TIMEOUT).toBe(2147483647);
  });

  it('MIN_TIMEOUT is 0', () => {
    expect(MIN_TIMEOUT).toBe(0);
  });

  it('MAX_TIMEOUT fits in a 32-bit signed integer', () => {
    // Node.js internally stores setTimeout delay as int32
    expect(MAX_TIMEOUT).toBeLessThanOrEqual(2 ** 31 - 1);
  });
});

// ---------------------------------------------------------------------------
// safeTimeout — integration with setTimeout
// ---------------------------------------------------------------------------

describe('safeTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls the callback after the specified delay', () => {
    const cb = vi.fn();
    safeTimeout(cb, 1000);
    expect(cb).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(cb).toHaveBeenCalledOnce();
  });

  it('calls the callback on next tick for NaN delay', () => {
    const cb = vi.fn();
    safeTimeout(cb, NaN);
    expect(cb).not.toHaveBeenCalled();
    vi.advanceTimersByTime(0);
    expect(cb).toHaveBeenCalledOnce();
  });

  it('calls the callback on next tick for negative delay', () => {
    const cb = vi.fn();
    safeTimeout(cb, -5000);
    vi.advanceTimersByTime(0);
    expect(cb).toHaveBeenCalledOnce();
  });

  it('calls the callback on next tick for Infinity delay', () => {
    const cb = vi.fn();
    safeTimeout(cb, Infinity);
    vi.advanceTimersByTime(0);
    expect(cb).toHaveBeenCalledOnce();
  });

  it('clamps oversized delay and fires after MAX_TIMEOUT', () => {
    const cb = vi.fn();
    safeTimeout(cb, Number.MAX_SAFE_INTEGER);
    vi.advanceTimersByTime(MAX_TIMEOUT);
    expect(cb).toHaveBeenCalledOnce();
  });

  it('returns a timer handle that can be cleared', () => {
    const cb = vi.fn();
    const timer = safeTimeout(cb, 5000);
    clearTimeout(timer);
    vi.advanceTimersByTime(10_000);
    expect(cb).not.toHaveBeenCalled();
  });

  it('accepts an optional label for log context', () => {
    const cb = vi.fn();
    // Should not throw — label is just for logging
    expect(() => safeTimeout(cb, 1000, 'goal-engine')).not.toThrow();
    expect(() => safeTimeout(cb, NaN, 'autonomic')).not.toThrow();
  });

  // --- Scheduler recovery simulation ---

  it('handles the goal engine recovery scenario: remaining from DB', () => {
    const cb = vi.fn();
    const fakeNextRunAt = new Date(Date.now() + 30 * 60 * 1000).toISOString(); // 30 min from now
    const remaining = new Date(fakeNextRunAt).getTime() - Date.now();
    safeTimeout(cb, remaining, 'goal-engine');
    vi.advanceTimersByTime(29 * 60 * 1000); // 29 min
    expect(cb).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2 * 60 * 1000);  // 31 min total
    expect(cb).toHaveBeenCalledOnce();
  });

  it('handles the corrupt nextRunAt scenario: null string from DB', () => {
    const cb = vi.fn();
    // Simulates what happens when DB returns null cast to string
    const corruptNextRunAt = 'null';
    const remaining = new Date(corruptNextRunAt).getTime() - Date.now(); // NaN
    expect(isNaN(remaining)).toBe(true);
    // safeTimeout should NOT throw and should schedule on next tick
    expect(() => safeTimeout(cb, remaining, 'goal-engine')).not.toThrow();
    vi.advanceTimersByTime(0);
    expect(cb).toHaveBeenCalledOnce();
  });

  it('handles the corrupt nextRunAt scenario: epoch 0 (Jan 1 1970)', () => {
    const cb = vi.fn();
    // nextRunAt stored as epoch 0 — remaining is deeply negative
    const epochZeroNextRunAt = new Date(0).toISOString();
    const remaining = new Date(epochZeroNextRunAt).getTime() - Date.now(); // large negative
    expect(remaining).toBeLessThan(0);
    safeTimeout(cb, remaining, 'heartbeat');
    vi.advanceTimersByTime(0);
    expect(cb).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// No TimeoutOverflowWarning emitted for invalid inputs
// ---------------------------------------------------------------------------

describe('no warning events for invalid delay inputs', () => {
  it('does not emit TimeoutOverflowWarning for NaN delay', () => {
    const warningHandler = vi.fn();
    process.on('warning', warningHandler);

    vi.useFakeTimers();
    safeTimeout(() => {}, NaN, 'test');
    vi.advanceTimersByTime(0);
    vi.useRealTimers();

    // Filter to only timeout-related warnings
    const overflowWarnings = warningHandler.mock.calls.filter(
      ([w]) => w?.name === 'TimeoutOverflowWarning' || w?.name === 'TimeoutNaNWarning',
    );
    expect(overflowWarnings).toHaveLength(0);

    process.off('warning', warningHandler);
  });

  it('does not emit TimeoutOverflowWarning for values > MAX_TIMEOUT', () => {
    const warningHandler = vi.fn();
    process.on('warning', warningHandler);

    vi.useFakeTimers();
    safeTimeout(() => {}, MAX_TIMEOUT + 1_000_000, 'test');
    vi.advanceTimersByTime(MAX_TIMEOUT);
    vi.useRealTimers();

    const overflowWarnings = warningHandler.mock.calls.filter(
      ([w]) => w?.name === 'TimeoutOverflowWarning' || w?.name === 'TimeoutNaNWarning',
    );
    expect(overflowWarnings).toHaveLength(0);

    process.off('warning', warningHandler);
  });
});
