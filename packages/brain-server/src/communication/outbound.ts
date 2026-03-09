/**
 * Outbound Retry Queue -- buffers failed NATS publishes for retry.
 */

import type { NatsConnection } from 'nats';
import { StringCodec } from 'nats';

const sc = StringCodec();

export interface QueuedMessage {
  subject: string;
  data: unknown;
  sessionId: string;
  eventId: string;
  queuedAt: string;
  attempts: number;
}

const MAX_QUEUE_SIZE = 50;
const MAX_ATTEMPTS = 5;
const RETRY_INTERVAL_MS = 15_000;

const queue: QueuedMessage[] = [];
let retryTimer: ReturnType<typeof setInterval> | null = null;
let natsRef: NatsConnection | null = null;

export function enqueueForRetry(
  subject: string,
  data: unknown,
  sessionId: string,
  eventId: string,
): void {
  if (queue.length >= MAX_QUEUE_SIZE) {
    const dropped = queue.shift()!;
    console.log(JSON.stringify({
      level: 'warn',
      msg: 'Outbound queue full, dropping oldest message',
      component: 'comm.outbound',
      droppedEventId: dropped.eventId,
      queueSize: queue.length,
      ts: new Date().toISOString(),
    }));
  }

  queue.push({
    subject,
    data,
    sessionId,
    eventId,
    queuedAt: new Date().toISOString(),
    attempts: 0,
  });
}

export function startRetryLoop(nats: NatsConnection): void {
  natsRef = nats;
  if (retryTimer) return;
  retryTimer = setInterval(processRetries, RETRY_INTERVAL_MS);
}

export function stopRetryLoop(): void {
  if (retryTimer) {
    clearInterval(retryTimer);
    retryTimer = null;
  }
}

async function processRetries(): Promise<void> {
  if (queue.length === 0 || !natsRef) return;

  const batch = [...queue];
  const succeeded: number[] = [];
  const failed: number[] = [];

  for (let i = 0; i < batch.length; i++) {
    const item = batch[i];
    item.attempts++;

    try {
      natsRef.publish(item.subject, sc.encode(JSON.stringify(item.data)));
      succeeded.push(i);
    } catch (err) {
      if (item.attempts >= MAX_ATTEMPTS) {
        failed.push(i);
        console.log(JSON.stringify({
          level: 'error',
          msg: 'Queued message exceeded max retries, dropping',
          component: 'comm.outbound',
          eventId: item.eventId,
          attempts: item.attempts,
          error: String(err),
          ts: new Date().toISOString(),
        }));
      }
    }
  }

  const toRemove = new Set([...succeeded, ...failed]);
  for (let i = queue.length - 1; i >= 0; i--) {
    if (toRemove.has(i)) queue.splice(i, 1);
  }
}

export function getQueueStatus(): { size: number; oldest: string | null; messages: QueuedMessage[] } {
  return {
    size: queue.length,
    oldest: queue.length > 0 ? queue[0].queuedAt : null,
    messages: [...queue],
  };
}

export function clearQueue(): void {
  queue.length = 0;
}
