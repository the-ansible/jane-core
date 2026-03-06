import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock is hoisted — factory must not reference outer variables
vi.mock('nats', () => {
  const mockPublish = vi.fn();
  const mockJsPublish = vi.fn().mockResolvedValue({ seq: 1, stream: 'test' });
  const mockDrain = vi.fn().mockResolvedValue(undefined);

  return {
    connect: vi.fn().mockResolvedValue({
      publish: mockPublish,
      jetstream: () => ({ publish: mockJsPublish }),
      drain: mockDrain,
      isClosed: vi.fn().mockReturnValue(false),
      status: vi.fn().mockReturnValue({
        [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
      }),
      __mocks: { publish: mockPublish, jsPublish: mockJsPublish, drain: mockDrain },
    }),
    StringCodec: () => ({
      encode: (s: string) => new TextEncoder().encode(s),
      decode: (b: Uint8Array) => new TextDecoder().decode(b),
    }),
  };
});

import { connect } from 'nats';
import { createNatsClient } from '../client.js';
import type { SenderIdentity } from '../types.js';

const testSender: SenderIdentity = {
  id: 'test-service',
  displayName: 'Test Service',
  type: 'agent',
};

// Helper to grab mock fns from the mock connection
function getMocks(nc: any) {
  return nc.__mocks as { publish: ReturnType<typeof vi.fn>; jsPublish: ReturnType<typeof vi.fn>; drain: ReturnType<typeof vi.fn> };
}

describe('JaneNatsClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a client with sender identity', async () => {
    const client = await createNatsClient({ name: 'test', sender: testSender });

    expect(client.sender).toEqual(testSender);
    expect(client.isConnected()).toBe(true);
    expect(client.nc).toBeDefined();
    expect(client.js).toBeDefined();
  });

  it('publishEvent injects sender and validates', async () => {
    const client = await createNatsClient({ name: 'test', sender: testSender });
    const mocks = getMocks(client.nc);

    const event = {
      id: '019577a0-0000-7000-8000-000000000001',
      sessionId: 'sess-1',
      channelType: 'realtime',
      direction: 'outbound' as const,
      contentType: 'markdown' as const,
      content: 'Hello world',
      metadata: {},
      timestamp: new Date().toISOString(),
    };

    await client.publishEvent('communication.outbound.realtime', event);

    expect(mocks.jsPublish).toHaveBeenCalledTimes(1);
    const [subject, payload] = mocks.jsPublish.mock.calls[0];
    expect(subject).toBe('communication.outbound.realtime');

    const published = JSON.parse(new TextDecoder().decode(payload));
    expect(published.sender).toEqual(testSender);
    expect(published.content).toBe('Hello world');
  });

  it('publishEvent rejects invalid events', async () => {
    const client = await createNatsClient({ name: 'test', sender: testSender });
    const mocks = getMocks(client.nc);

    await expect(
      client.publishEvent('communication.outbound.realtime', { content: 'hello' })
    ).rejects.toThrow('CommunicationEvent validation failed');

    expect(mocks.jsPublish).not.toHaveBeenCalled();
  });

  it('publish sends raw data without validation', async () => {
    const client = await createNatsClient({ name: 'test', sender: testSender });
    const mocks = getMocks(client.nc);

    const heartbeat = { jobId: 'j1', ts: new Date().toISOString() };
    await client.publish('agent.jobs.heartbeat.j1', heartbeat);

    expect(mocks.jsPublish).toHaveBeenCalledTimes(1);
    const [subject, payload] = mocks.jsPublish.mock.calls[0];
    expect(subject).toBe('agent.jobs.heartbeat.j1');
    const decoded = JSON.parse(new TextDecoder().decode(payload));
    expect(decoded.jobId).toBe('j1');
  });

  it('close drains the connection', async () => {
    const client = await createNatsClient({ name: 'test', sender: testSender });
    const mocks = getMocks(client.nc);

    await client.close();
    expect(mocks.drain).toHaveBeenCalledTimes(1);
  });

  it('works without JetStream', async () => {
    const client = await createNatsClient({
      name: 'test',
      sender: testSender,
      useJetStream: false,
    });
    const mocks = getMocks(client.nc);

    expect(client.js).toBeNull();

    await client.publish('some.subject', { foo: 'bar' });

    expect(mocks.publish).toHaveBeenCalledTimes(1);
    expect(mocks.jsPublish).not.toHaveBeenCalled();
  });
});
