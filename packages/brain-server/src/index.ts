/**
 * Brain Server — Jane's multi-agent orchestration layer.
 *
 * - Listens on NATS `agent.jobs.request` for job submissions
 * - Spawns `claude --print` subprocesses for each job
 * - Tracks job lifecycle in PostgreSQL (brain schema)
 * - Monitors heartbeats, flags unresponsive jobs
 * - Publishes results to `agent.results.<jobId>` and `communication.agent-results.*`
 * - HTTP API on :3103 for monitoring and control
 * - Goal/desire engine — proactive action loop on configurable interval (default 4h)
 */

import { serve } from '@hono/node-server';
import { createNatsClient } from './nats/client.js';
import { startConsumer } from './nats/consumer.js';
import { startHeartbeatMonitor } from './jobs/heartbeat.js';
import { initJobRegistry } from './jobs/registry.js';
import { createApp, type ServerDeps } from './api/routes.js';
import { initGoalRegistry } from './goals/registry.js';
import { seedInitialGoals } from './goals/seeder.js';
import { startGoalEngine } from './goals/engine.js';
import { startHierarchicalControl } from './layers/controller.js';

const PORT = parseInt(process.env.PORT || '3103', 10);
const NATS_URL = process.env.NATS_URL || 'nats://life-system-nats:4222';

// Mutable deps — routes read nats via closure so it hot-updates when NATS connects
const deps: ServerDeps = { nats: null };
const app = createApp(deps);

// Start HTTP server immediately — /health available even if NATS is down
serve({ fetch: app.fetch, port: PORT }, (info) => {
  log('info', `Brain server listening on port ${info.port}`);
});

// Initialize DB schemas (idempotent — safe to call on every startup)
(async () => {
  try {
    await initJobRegistry();
    await initGoalRegistry();
    await seedInitialGoals();
  } catch (err) {
    log('error', 'Failed to initialize DB schemas', { error: String(err) });
  }
})();

// Connect to NATS, then start consuming, heartbeat monitoring, and goal engine
(async () => {
  try {
    deps.nats = await createNatsClient(NATS_URL);
    startConsumer(deps.nats);
    startHeartbeatMonitor(deps.nats);
    startGoalEngine(deps.nats);
    await startHierarchicalControl(deps.nats);
    log('info', 'Brain server fully initialized', { port: PORT, natsUrl: NATS_URL });
  } catch (err) {
    log('error', 'Failed to connect to NATS — job submission via NATS unavailable', { error: String(err) });
  }
})();

function log(level: string, msg: string, extra?: Record<string, unknown>): void {
  console.log(JSON.stringify({ level, msg, component: 'brain-server', ts: new Date().toISOString(), ...extra }));
}
