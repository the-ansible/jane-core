import { connect, StringCodec, type NatsConnection, type JetStreamClient } from 'nats';
import { communicationEventSchema, uuidv7 } from '@the-ansible/life-system-shared';
import type { NatsClientOptions, NatsClient, SenderIdentity } from './types.js';

const sc = StringCodec();

const DEFAULT_URL = 'nats://life-system-nats:4222';

/**
 * Create a shared NATS client with mandatory sender identity.
 *
 * - `publishEvent()` validates against the CommunicationEvent schema and auto-injects `sender`.
 * - `publish()` is the escape hatch for non-communication subjects (heartbeats, job results).
 * - Reconnect is infinite with 2s backoff. Status events are logged as structured JSON.
 */
export async function createNatsClient(options: NatsClientOptions): Promise<NatsClient> {
  const url = options.url ?? DEFAULT_URL;
  const useJetStream = options.useJetStream ?? true;

  const nc = await connect({
    servers: url,
    reconnect: true,
    maxReconnectAttempts: -1,
    reconnectTimeWait: 2000,
    name: options.name,
  });

  log('info', 'Connected to NATS', options.name, { server: url });

  // Log status events (reconnect, disconnect, etc.)
  (async () => {
    for await (const s of nc.status()) {
      log('info', `NATS status: ${s.type}`, options.name, { data: s.data });
    }
  })();

  const js = useJetStream ? nc.jetstream() : null;

  return {
    nc,
    js,
    sender: options.sender,

    isConnected(): boolean {
      return !nc.isClosed();
    },

    async publishEvent(subject: string, event: Record<string, unknown>): Promise<void> {
      // Inject sender and ensure sessionId exists
      const fullEvent = {
        ...event,
        sender: options.sender,
        sessionId: event.sessionId || uuidv7(),
      };

      // Validate against the CommunicationEvent schema (sender is now required)
      const result = communicationEventSchema.safeParse(fullEvent);
      if (!result.success) {
        const issues = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
        throw new Error(`CommunicationEvent validation failed: ${issues}`);
      }

      if (js) {
        await js.publish(subject, sc.encode(JSON.stringify(result.data)));
      } else {
        nc.publish(subject, sc.encode(JSON.stringify(result.data)));
      }
    },

    async publish(subject: string, data: unknown): Promise<void> {
      const payload = sc.encode(JSON.stringify(data));
      if (js) {
        await js.publish(subject, payload);
      } else {
        nc.publish(subject, payload);
      }
    },

    async close(): Promise<void> {
      await nc.drain();
      log('info', 'NATS connection drained and closed', options.name);
    },
  };
}

function log(level: string, msg: string, component: string, extra?: Record<string, unknown>): void {
  console.log(JSON.stringify({ level, msg, component, ts: new Date().toISOString(), ...extra }));
}
