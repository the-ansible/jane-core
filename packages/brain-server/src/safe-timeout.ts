/**
 * safeTimeout — validated wrapper around setTimeout.
 *
 * Node.js emits a TimeoutOverflowWarning (or TimeoutNaNWarning) and fires the
 * callback immediately when setTimeout is called with a delay that is:
 *   - NaN
 *   - Infinite (positive or negative)
 *   - Greater than MAX_TIMEOUT (2^31 - 1 ms ≈ 24.8 days)
 *   - Negative (fires immediately)
 *
 * This wrapper validates the delay and clamps it to a safe range so
 * scheduler recovery code never triggers runaway loops.
 *
 * Usage:
 *   import { safeTimeout, MAX_TIMEOUT } from '../safe-timeout.js';
 *
 *   const timer = safeTimeout(() => doWork(), remaining);
 *   clearTimeout(timer);
 */

/** Maximum delay accepted by Node.js before triggering TimeoutOverflowWarning. */
export const MAX_TIMEOUT = 0x7fffffff; // 2^31 - 1 = 2,147,483,647 ms ≈ 24.8 days

/** Minimum delay — zero is valid; Node fires on the next event-loop tick. */
export const MIN_TIMEOUT = 0;

/**
 * Schedule `callback` after `delayMs` milliseconds, with safety validation.
 *
 * - NaN / non-finite → clamped to MIN_TIMEOUT (fires on next tick), warning logged
 * - Negative → clamped to MIN_TIMEOUT
 * - > MAX_TIMEOUT → clamped to MAX_TIMEOUT
 * - Otherwise → used as-is
 *
 * Returns the timer handle so callers can clearTimeout / clearInterval it.
 */
export function safeTimeout(
  callback: () => void,
  delayMs: number,
  label?: string,
): ReturnType<typeof setTimeout> {
  const safe = clampDelay(delayMs);
  if (safe !== delayMs) {
    const tag = label ? ` [${label}]` : '';
    console.log(
      JSON.stringify({
        level: 'warn',
        msg: `safeTimeout${tag}: clamping invalid delay`,
        requestedMs: delayMs,
        clampedMs: safe,
        ts: new Date().toISOString(),
      }),
    );
  }
  return setTimeout(callback, safe);
}

/**
 * Clamp a delay value to the valid range [0, MAX_TIMEOUT].
 * Exported for testing.
 */
export function clampDelay(delayMs: number): number {
  if (!isFinite(delayMs) || isNaN(delayMs)) return MIN_TIMEOUT;
  if (delayMs < MIN_TIMEOUT) return MIN_TIMEOUT;
  if (delayMs > MAX_TIMEOUT) return MAX_TIMEOUT;
  return Math.floor(delayMs);
}

/**
 * Returns true if the delay is valid (finite, non-negative, within Node.js limits).
 * Exported for testing and callers that want to validate before scheduling.
 */
export function isValidDelay(delayMs: number): boolean {
  return isFinite(delayMs) && !isNaN(delayMs) && delayMs >= MIN_TIMEOUT && delayMs <= MAX_TIMEOUT;
}
