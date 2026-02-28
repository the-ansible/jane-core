import { describe, it, expect, vi, beforeEach } from 'vitest';
import { processMessage } from '../nats/consumer.js';
import { resetMetrics, getMetrics } from '../metrics.js';

function makeMockMsg(data: unknown): any {
  const encoded = new TextEncoder().encode(JSON.stringify(data));
  return {
    data: encoded,
    subject: 'communication.inbound.message',
    ack: vi.fn(),
  };
}

const validEvent = {
  id: '019502e4-1234-7000-8000-000000000001',
  sessionId: 'session-abc',
  channelType: 'message',
  direction: 'inbound',
  contentType: 'markdown',
  content: 'Hello!',  // Use a greeting so rules classifier handles it instantly (no Ollama needed)
  metadata: {},
  timestamp: '2026-02-28T12:00:00.000Z',
};

describe('processMessage', () => {
  beforeEach(() => resetMetrics());

  it('processes a valid message and increments counters', async () => {
    const msg = makeMockMsg(validEvent);
    await processMessage(msg);

    const metrics = getMetrics();
    expect(metrics.received).toBe(1);
    expect(metrics.validated).toBe(1);
    expect(metrics.validationErrors).toBe(0);
    expect(msg.ack).toHaveBeenCalledOnce();
  });

  it('handles validation failure and still acks', async () => {
    const msg = makeMockMsg({ id: 'bad' });
    await processMessage(msg);

    const metrics = getMetrics();
    expect(metrics.received).toBe(1);
    expect(metrics.validated).toBe(0);
    expect(metrics.validationErrors).toBe(1);
    expect(msg.ack).toHaveBeenCalledOnce();
  });

  it('handles invalid JSON and still acks', async () => {
    const msg = {
      data: new TextEncoder().encode('not json{{{'),
      subject: 'communication.inbound.message',
      ack: vi.fn(),
    };
    await processMessage(msg as any);

    const metrics = getMetrics();
    expect(metrics.received).toBe(1);
    expect(metrics.validationErrors).toBe(1);
    expect(msg.ack).toHaveBeenCalledOnce();
  });

  it('processes multiple messages and accumulates counts', async () => {
    await processMessage(makeMockMsg(validEvent));
    await processMessage(makeMockMsg(validEvent));
    await processMessage(makeMockMsg({ bad: true }));

    const metrics = getMetrics();
    expect(metrics.received).toBe(3);
    expect(metrics.validated).toBe(2);
    expect(metrics.validationErrors).toBe(1);
  });
});
