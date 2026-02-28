import { connect, NatsConnection, JetStreamClient, StringCodec } from 'nats';

const sc = StringCodec();

export interface NatsClient {
  nc: NatsConnection;
  js: JetStreamClient;
  isConnected(): boolean;
  close(): Promise<void>;
  publish(subject: string, data: unknown): Promise<void>;
}

export async function createNatsClient(
  url: string = 'nats://life-system-nats:4222'
): Promise<NatsClient> {
  const nc = await connect({
    servers: url,
    reconnect: true,
    maxReconnectAttempts: -1, // infinite reconnect
    reconnectTimeWait: 2000,
    name: 'stimulation-server',
  });

  console.log(JSON.stringify({
    level: 'info',
    msg: 'Connected to NATS',
    server: url,
    ts: new Date().toISOString(),
  }));

  // Log status events
  (async () => {
    for await (const s of nc.status()) {
      console.log(JSON.stringify({
        level: 'info',
        msg: `NATS status: ${s.type}`,
        data: s.data,
        ts: new Date().toISOString(),
      }));
    }
  })();

  const js = nc.jetstream();

  return {
    nc,
    js,
    isConnected() {
      return !nc.isClosed();
    },
    async publish(subject: string, data: unknown) {
      await js.publish(subject, sc.encode(JSON.stringify(data)));
    },
    async close() {
      await nc.drain();
      console.log(JSON.stringify({
        level: 'info',
        msg: 'NATS connection drained and closed',
        ts: new Date().toISOString(),
      }));
    },
  };
}
