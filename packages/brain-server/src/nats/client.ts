import { connect, type NatsConnection } from 'nats';

export async function createNatsClient(url: string): Promise<NatsConnection> {
  const nc = await connect({ servers: url });
  console.log(JSON.stringify({
    level: 'info',
    msg: 'Connected to NATS',
    component: 'brain-nats',
    url,
    ts: new Date().toISOString(),
  }));
  return nc;
}
