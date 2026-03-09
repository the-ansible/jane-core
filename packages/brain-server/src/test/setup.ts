/**
 * Vitest Per-Worker Setup — runs in each test worker before any test file is loaded.
 *
 * Points all registry modules at the brain_test schema so test data never
 * touches the production brain schema.
 */

import { afterAll } from 'vitest';

// Override the schema before any registry module is imported.
// Registry modules read process.env.BRAIN_SCHEMA at module load time,
// so this must run before any import that triggers registry initialization.
process.env.BRAIN_SCHEMA = 'brain_test';

// Reset all registry pools after each test file so the next file
// gets a fresh pool that picks up the correct schema env var.
afterAll(async () => {
  // Dynamic imports to avoid triggering module initialization at setup time
  const [goalsReg, memoryReg, layersReg, jobsReg] = await Promise.all([
    import('../goals/registry.js').catch(() => null),
    import('../memory/registry.js').catch(() => null),
    import('../layers/registry.js').catch(() => null),
    import('../jobs/registry.js').catch(() => null),
  ]);

  goalsReg?._resetPool?.();
  memoryReg?._resetPool?.();
  layersReg?._resetLayerPool?.();
  jobsReg?._resetPool?.();
});
