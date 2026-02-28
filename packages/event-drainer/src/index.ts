import {
  connect,
  AckPolicy,
  DeliverPolicy,
  StringCodec,
} from 'nats';
import { JsonlWriter } from './writer.js';

const NATS_URL = process.env.NATS_URL || 'nats://life-system-nats:4222';
const STREAM = process.env.DRAIN_STREAM || 'COMMUNICATION';
const FILTER = process.env.DRAIN_FILTER || '>';
const DURABLE_NAME = 'event-drainer';
const EVENTS_DIR = process.env.EVENTS_DIR || '/agent/data/events/live';

const sc = StringCodec();
const writer = new JsonlWriter(EVENTS_DIR);

function log(msg: string, data?: Record<string, unknown>) {
  console.log(JSON.stringify({
    level: 'info',
    msg,
    ...data,
    ts: new Date().toISOString(),
  }));
}

async function main() {
  const nc = await connect({
    servers: NATS_URL,
    reconnect: true,
    maxReconnectAttempts: -1,
    reconnectTimeWait: 2000,
    name: 'event-drainer',
  });

  log('Connected to NATS', { server: NATS_URL });

  // Log status events
  (async () => {
    for await (const s of nc.status()) {
      log(`NATS status: ${s.type}`, { data: String(s.data) });
    }
  })();

  const js = nc.jetstream();
  const jsm = await js.jetstreamManager();

  // Create durable consumer
  await jsm.consumers.add(STREAM, {
    durable_name: DURABLE_NAME,
    filter_subject: FILTER,
    ack_policy: AckPolicy.Explicit,
    deliver_policy: DeliverPolicy.All,
  });

  log(`Consumer "${DURABLE_NAME}" ready`, { stream: STREAM, filter: FILTER });

  // Consume loop with auto-restart
  while (true) {
    try {
      const consumer = await js.consumers.get(STREAM, DURABLE_NAME);
      const messages = await consumer.consume();

      for await (const msg of messages) {
        try {
          const raw = sc.decode(msg.data);
          const event = JSON.parse(raw);

          // Enrich with drainer metadata
          const enriched = {
            ...event,
            _drainer: {
              subject: msg.subject,
              stream: STREAM,
              drainedAt: new Date().toISOString(),
            },
          };

          writer.write(enriched);
          msg.ack();
        } catch (err) {
          log('Error processing message', { error: String(err), subject: msg.subject });
          msg.ack(); // ack to avoid stuck messages
        }
      }
    } catch (err) {
      log('Consumer loop error, restarting in 1s', { error: String(err) });
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

// Graceful shutdown
let shuttingDown = false;
function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`Received ${signal}, shutting down`, { stats: writer.getStats() });
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

main().catch((err) => {
  log('Fatal error', { error: String(err) });
  process.exit(1);
});
