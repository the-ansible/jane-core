import { serve } from '@hono/node-server';
import { createApp, type ServerDeps } from './server.js';
import { createNatsClient } from '@jane-core/nats-client';
import { startConsumer, setSafetyGate, setNatsClient } from './nats/consumer.js';
import { SafetyGate } from './safety/index.js';
import { startRetryLoop, stopRetryLoop } from './outbound-queue.js';
import { initializeContextDb } from './context/db.js';
import { initJobRegistry } from './agent/job-registry.js';
import { recoverInFlightJobs } from './agent/recovery.js';
import { setAgentNatsConnection } from './agent/index.js';
import { resumeAliveJob } from './pipeline.js';
import { initPipelineRunsStore } from './pipeline-runs.js';

const PORT = parseInt(process.env.PORT || '3102', 10);
const NATS_URL = process.env.NATS_URL || 'nats://life-system-nats:4222';

const safety = new SafetyGate();
setSafetyGate(safety);
const deps: ServerDeps = { nats: null, safety };
const app = createApp(deps);

// Load persisted pipeline runs so dashboard has context for pre-restart wrappers
initPipelineRunsStore();

// Initialize context DB (schema + seed plan)
initializeContextDb().catch((err) => {
  console.log(JSON.stringify({
    level: 'error',
    msg: 'Failed to initialize context DB — context assembly will fail',
    error: String(err),
    ts: new Date().toISOString(),
  }));
});

// Initialize agent job registry schema (idempotent)
initJobRegistry().catch((err) => {
  console.log(JSON.stringify({
    level: 'error',
    msg: 'Failed to initialize job registry schema',
    error: String(err),
    ts: new Date().toISOString(),
  }));
});

// Start HTTP server first so /health is available even if NATS is down
serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(JSON.stringify({
    level: 'info',
    msg: `HTTP server listening on port ${info.port}`,
    ts: new Date().toISOString(),
  }));
});

// Connect to NATS and start consuming
(async () => {
  try {
    deps.nats = await createNatsClient({
      url: NATS_URL,
      name: 'stimulation-server',
      sender: { id: 'jane', displayName: 'Jane', type: 'agent' },
    });
    safety.setNats(deps.nats);
    setNatsClient(deps.nats);
    setAgentNatsConnection(deps.nats.nc);
    startRetryLoop(deps.nats);
    // Recover stale agent jobs now that NATS is available for re-dispatch
    recoverInFlightJobs(deps).catch((err) => {
      console.log(JSON.stringify({
        level: 'error',
        msg: 'Bootstrap job recovery failed',
        error: String(err),
        ts: new Date().toISOString(),
      }));
    });
    // Subscribe to agent job completion events published by the wrapper process
    deps.nats.nc.subscribe('stimulation.agent_jobs.completed', {
      callback: (_err, msg) => {
        if (_err) return;
        try {
          const payload = JSON.parse(new TextDecoder().decode(msg.data)) as {
            jobId: string;
            outputFile: string;
            success: boolean;
          };
          resumeAliveJob({ jobId: payload.jobId, outputFile: payload.outputFile, success: payload.success, deps }).catch((err) => {
            console.log(JSON.stringify({
              level: 'error',
              msg: 'resumeAliveJob failed',
              component: 'bootstrap',
              error: String(err),
              ts: new Date().toISOString(),
            }));
          });
        } catch { /* ignore malformed payloads */ }
      },
    });
    // Start consumer in background (infinite loop)
    startConsumer(deps.nats.js!).catch((err) => {
      console.log(JSON.stringify({
        level: 'error',
        msg: 'Consumer fatal error',
        error: String(err),
        ts: new Date().toISOString(),
      }));
    });
  } catch (err) {
    console.log(JSON.stringify({
      level: 'error',
      msg: 'Failed to connect to NATS',
      error: String(err),
      ts: new Date().toISOString(),
    }));
  }
})();

// Graceful shutdown
let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(JSON.stringify({
    level: 'info',
    msg: `Received ${signal}, shutting down`,
    ts: new Date().toISOString(),
  }));
  try {
    stopRetryLoop();
    if (deps.nats) {
      await deps.nats.close();
    }
  } catch {
    // ignore errors during shutdown
  }
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
