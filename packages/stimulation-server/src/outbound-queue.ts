/**
 * Outbound Retry Queue — buffers failed NATS publishes for retry.
 *
 * When a composed response fails to publish (NATS down, timeout, etc.),
 * the message is queued here instead of being lost. A periodic retry loop
 * attempts to re-publish queued messages when NATS reconnects.
 */

import type { NatsClient } from '@jane-core/nats-client';

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
const RETRY_INTERVAL_MS = 15_000; // 15 seconds

const queue: QueuedMessage[] = [];
let retryTimer: ReturnType<typeof setInterval> | null = null;
let natsRef: NatsClient | null = null;

/** Enqueue a failed outbound message for retry */
export function enqueueForRetry(
  subject: string,
  data: unknown,
  sessionId: string,
  eventId: string,
): void {
  if (queue.length >= MAX_QUEUE_SIZE) {
    // Drop oldest to make room
    const dropped = queue.shift()!;
    console.log(JSON.stringify({
      level: 'warn',
      msg: 'Outbound queue full, dropping oldest message',
      component: 'outbound-queue',
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

  console.log(JSON.stringify({
    level: 'info',
    msg: 'Message queued for retry',
    component: 'outbound-queue',
    eventId,
    subject,
    queueSize: queue.length,
    ts: new Date().toISOString(),
  }));
}

/** Start the retry loop */
export function startRetryLoop(nats: NatsClient): void {
  natsRef = nats;
  if (retryTimer) return; // Already running

  retryTimer = setInterval(processRetries, RETRY_INTERVAL_MS);
}

/** Stop the retry loop */
export function stopRetryLoop(): void {
  if (retryTimer) {
    clearInterval(retryTimer);
    retryTimer = null;
  }
}

/** Process queued messages, attempting to re-publish */
async function processRetries(): Promise<void> {
  if (queue.length === 0 || !natsRef?.isConnected()) return;

  // Process a copy to avoid mutation issues during iteration
  const batch = [...queue];
  const succeeded: number[] = [];
  const failed: number[] = [];

  for (let i = 0; i < batch.length; i++) {
    const item = batch[i];
    item.attempts++;

    try {
      await natsRef.publish(item.subject, item.data);
      succeeded.push(i);

      console.log(JSON.stringify({
        level: 'info',
        msg: 'Queued message published successfully',
        component: 'outbound-queue',
        eventId: item.eventId,
        attempts: item.attempts,
        ts: new Date().toISOString(),
      }));
    } catch (err) {
      if (item.attempts >= MAX_ATTEMPTS) {
        failed.push(i);
        console.log(JSON.stringify({
          level: 'error',
          msg: 'Queued message exceeded max retries, dropping',
          component: 'outbound-queue',
          eventId: item.eventId,
          attempts: item.attempts,
          error: String(err),
          ts: new Date().toISOString(),
        }));
      }
      // Otherwise leave it in queue for next cycle
    }
  }

  // Remove succeeded and permanently failed items (iterate in reverse to preserve indices)
  const toRemove = new Set([...succeeded, ...failed]);
  for (let i = queue.length - 1; i >= 0; i--) {
    if (toRemove.has(i)) queue.splice(i, 1);
  }
}

/** Get current queue status (for metrics/debugging) */
export function getQueueStatus(): { size: number; oldest: string | null; messages: QueuedMessage[] } {
  return {
    size: queue.length,
    oldest: queue.length > 0 ? queue[0].queuedAt : null,
    messages: [...queue],
  };
}

/** Clear the queue (for testing) */
export function clearQueue(): void {
  queue.length = 0;
}
