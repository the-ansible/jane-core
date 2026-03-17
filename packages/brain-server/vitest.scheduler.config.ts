/**
 * Vitest config for the scheduler regression test suite.
 *
 * Runs ONLY the safe-timeout tests — no database required.
 * These tests verify that the TimeoutOverflowWarning guard works correctly
 * and that setTimeout is never called with NaN or out-of-range values.
 *
 * Used by CI on every pull request (no PostgreSQL service needed).
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/safe-timeout.test.ts'],
    // No globalSetup or setupFiles — safe-timeout.ts has no DB dependencies
  },
});
