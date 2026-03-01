import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock pipeline and agent/composer to prevent Claude CLI spawns during tests
vi.mock('../pipeline.js', () => ({
  processPipeline: vi.fn().mockResolvedValue({
    action: 'reply',
    reason: 'test',
    responded: false,
  }),
}));

vi.mock('../agent/index.js', () => ({
  invokeAgent: vi.fn().mockResolvedValue(null),
}));

vi.mock('../composer/index.js', () => ({
  compose: vi.fn().mockResolvedValue(null),
}));

import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.SESSIONS_DIR = mkdtempSync(join(tmpdir(), 'consumer-test-'));

import { processMessage, clearDedupCache } from '../nats/consumer.js';
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
  beforeEach(() => {
    resetMetrics();
    clearDedupCache();
  });

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
    await processMessage(makeMockMsg({ ...validEvent, id: '019502e4-1234-7000-8000-000000000001' }));
    await processMessage(makeMockMsg({ ...validEvent, id: '019502e4-1234-7000-8000-000000000002' }));
    await processMessage(makeMockMsg({ bad: true }));

    const metrics = getMetrics();
    expect(metrics.received).toBe(3);
    expect(metrics.validated).toBe(2);
    expect(metrics.validationErrors).toBe(1);
  });

  it('deduplicates messages with the same event ID', async () => {
    const msg1 = makeMockMsg(validEvent);
    const msg2 = makeMockMsg(validEvent); // same event ID

    await processMessage(msg1);
    await processMessage(msg2);

    const metrics = getMetrics();
    expect(metrics.validated).toBe(2); // both pass validation
    expect(metrics.deduplicated).toBe(1); // second one is deduped
    expect(metrics.classified).toBe(1); // only first is classified
    expect(msg1.ack).toHaveBeenCalledOnce();
    expect(msg2.ack).toHaveBeenCalledOnce(); // deduped messages are still acked
  });

  it('processes messages with different IDs independently', async () => {
    await processMessage(makeMockMsg({ ...validEvent, id: '019502e4-aaaa-7000-8000-000000000001' }));
    await processMessage(makeMockMsg({ ...validEvent, id: '019502e4-bbbb-7000-8000-000000000002' }));

    const metrics = getMetrics();
    expect(metrics.deduplicated).toBe(0);
    expect(metrics.classified).toBe(2);
  });
});
