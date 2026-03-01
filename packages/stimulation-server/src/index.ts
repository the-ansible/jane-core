import { serve } from '@hono/node-server';
import { createApp, type ServerDeps } from './server.js';
import { createNatsClient } from './nats/client.js';
import { startConsumer, setSafetyGate, setNatsClient } from './nats/consumer.js';
import { SafetyGate } from './safety/index.js';
import { startRetryLoop, stopRetryLoop } from './outbound-queue.js';

const PORT = parseInt(process.env.PORT || '3102', 10);
const NATS_URL = process.env.NATS_URL || 'nats://life-system-nats:4222';

const safety = new SafetyGate();
setSafetyGate(safety);
const deps: ServerDeps = { nats: null, safety };
const app = createApp(deps);

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
    deps.nats = await createNatsClient(NATS_URL);
    safety.setNats(deps.nats);
    setNatsClient(deps.nats);
    startRetryLoop(deps.nats);
    // Start consumer in background (infinite loop)
    startConsumer(deps.nats.js).catch((err) => {
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
