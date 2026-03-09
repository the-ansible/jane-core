import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Create brain_test schema once before any workers start
    globalSetup: ['src/test/global-setup.ts'],
    // Set BRAIN_SCHEMA=brain_test in every test worker before modules load
    setupFiles: ['src/test/setup.ts'],
  },
});
