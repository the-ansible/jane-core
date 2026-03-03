import {
  JetStreamClient,
  AckPolicy,
  DeliverPolicy,
  JsMsg,
} from 'nats';
import { communicationEventSchema } from '@the-ansible/life-system-shared';
import { increment } from '../metrics.js';
import { pushEvent } from '../events.js';
import type { SafetyGate } from '../safety/index.js';
import type { NatsClient } from './client.js';
import { classify, type ClassificationResult, type ClassificationContext } from '../classifier/index.js';
import { processPipeline, type PipelineDeps } from '../pipeline.js';
import { completeRun } from '../pipeline-runs.js';
import { getMessageCount } from '../sessions/store.js';

const STREAM = 'COMMUNICATION';
const DURABLE_NAME = 'stimulation-server';
const FILTER_SUBJECT = 'communication.inbound.>';

// Deduplication: track recently processed event IDs to prevent reprocessing on redelivery
const DEDUP_MAX_SIZE = 500;
const DEDUP_TTL_MS = 10 * 60 * 1000; // 10 minutes
const processedEvents = new Map<string, number>(); // eventId → timestamp

function isDuplicate(eventId: string): boolean {
  const now = Date.now();

  // Prune expired entries periodically (every 100 checks)
  if (processedEvents.size > DEDUP_MAX_SIZE) {
    for (const [id, ts] of processedEvents) {
      if (now - ts > DEDUP_TTL_MS) processedEvents.delete(id);
    }
  }

  if (processedEvents.has(eventId)) return true;

  processedEvents.set(eventId, now);
  return false;
}

/** Clear dedup cache (for testing) */
export function clearDedupCache(): void {
  processedEvents.clear();
}

// Per-session lock: only one pipeline runs per session at a time.
// Different sessions process in parallel. This prevents the resubmission loop
// (which was always same-session) without sacrificing cross-session throughput.
const sessionLocks = new Map<string, Promise<void>>();

function withSessionLock(sessionId: string, fn: () => Promise<void>): Promise<void> {
  const prev = sessionLocks.get(sessionId) ?? Promise.resolve();
  const next = prev.then(fn, fn); // run fn after previous completes (even if it failed)
  sessionLocks.set(sessionId, next);
  // Clean up the lock entry once the chain settles to prevent unbounded growth
  next.then(() => {
    if (sessionLocks.get(sessionId) === next) sessionLocks.delete(sessionId);
  });
  return next;
}

let safetyGate: SafetyGate | null = null;
let natsClient: NatsClient | null = null;

export function setSafetyGate(gate: SafetyGate): void {
  safetyGate = gate;
}

export function setNatsClient(client: NatsClient): void {
  natsClient = client;
}

export async function processMessage(msg: JsMsg): Promise<ClassificationResult | null> {
  increment('received');

  let data: unknown;
  try {
    data = JSON.parse(new TextDecoder().decode(msg.data));
  } catch {
    console.log(JSON.stringify({
      level: 'error',
      msg: 'Failed to parse message JSON',
      subject: msg.subject,
      ts: new Date().toISOString(),
    }));
    increment('validationErrors');
    msg.ack();
    return null;
  }

  const result = communicationEventSchema.safeParse(data);

  if (!result.success) {
    console.log(JSON.stringify({
      level: 'warn',
      msg: 'Validation failed',
      subject: msg.subject,
      errors: result.error.issues,
      ts: new Date().toISOString(),
    }));
    increment('validationErrors');
    msg.ack(); // ack even on validation failure — invalid messages won't become valid on retry
    return null;
  }

  increment('validated');

  // Deduplication check — skip redelivered messages
  if (isDuplicate(result.data.id)) {
    console.log(JSON.stringify({
      level: 'info',
      msg: 'Duplicate event skipped',
      eventId: result.data.id,
      subject: msg.subject,
      ts: new Date().toISOString(),
    }));
    increment('deduplicated');
    msg.ack();
    return null;
  }

  safetyGate?.recordProcess();
  safetyGate?.recordSuccess();

  // Build classification context from the full event
  const sessionState: ClassificationContext['sessionState'] =
    getMessageCount(result.data.sessionId) > 0 ? 'active_conversation' : 'cold_start';

  const ctx: ClassificationContext = {
    content: result.data.content,
    channelType: result.data.channelType,
    hints: result.data.hints,
    sender: result.data.sender,
    sessionState,
  };

  // Classify the event
  let classification: ClassificationResult | null = null;
  try {
    classification = await classify(ctx, safetyGate);
    increment('classified');
  } catch (err) {
    console.log(JSON.stringify({
      level: 'error',
      msg: 'Classification failed',
      error: String(err),
      ts: new Date().toISOString(),
    }));
  }

  pushEvent(result.data, msg.subject, classification ? {
    urgency: classification.urgency,
    category: classification.category,
    routing: classification.routing,
    confidence: classification.confidence,
    tier: classification.tier,
  } : undefined);
  console.log(JSON.stringify({
    level: 'info',
    msg: 'Event received',
    event: {
      id: result.data.id,
      channelType: result.data.channelType,
      direction: result.data.direction,
      sessionId: result.data.sessionId,
      contentPreview: result.data.content.slice(0, 100),
    },
    classification: classification ? {
      urgency: classification.urgency,
      category: classification.category,
      routing: classification.routing,
      confidence: classification.confidence,
      tier: classification.tier,
    } : null,
    subject: msg.subject,
    ts: new Date().toISOString(),
  }));

  // Run through the full pipeline if classification succeeded
  if (classification) {
    // Signal NATS we're working on it (prevents redelivery during long pipeline runs)
    msg.working();

    const pipelineDeps: PipelineDeps = {
      nats: natsClient,
      safety: safetyGate,
    };

    try {
      const pipelineResult = await processPipeline(result.data, classification, pipelineDeps, {
        redeliveryCount: msg.info?.deliveryCount ?? 1,
      });
      increment('pipelineProcessed');

      console.log(JSON.stringify({
        level: 'info',
        msg: 'Pipeline completed',
        component: 'consumer',
        eventId: result.data.id,
        action: pipelineResult.action,
        responded: pipelineResult.responded,
        responseEventId: pipelineResult.responseEventId,
        ts: new Date().toISOString(),
      }));
    } catch (err) {
      completeRun(result.data.id, 'failure', { error: `Pipeline crash: ${err}` });
      console.log(JSON.stringify({
        level: 'error',
        msg: 'Pipeline processing failed',
        component: 'consumer',
        eventId: result.data.id,
        error: String(err),
        ts: new Date().toISOString(),
      }));
      increment('errors');
    }
  }

  // ACK only AFTER full pipeline completion — this is the critical fix.
  // Previously we acked before the pipeline ran, so if the server crashed mid-pipeline,
  // the message was lost and we relied on job recovery (which caused resubmission loops).
  msg.ack();

  return classification;
}

export async function startConsumer(js: JetStreamClient): Promise<void> {
  const jsm = await js.jetstreamManager();

  // Ensure the consumer exists with our desired config.
  // If the consumer already exists with different settings, delete and recreate.
  // ack_wait: 120s — pipeline takes 11-13s normally, but agent calls can take longer.
  // msg.working() extends this deadline during active processing.
  // max_deliver: 3 — prevents infinite redelivery loops.
  const consumerConfig = {
    durable_name: DURABLE_NAME,
    filter_subject: FILTER_SUBJECT,
    ack_policy: AckPolicy.Explicit,
    deliver_policy: DeliverPolicy.New,
    ack_wait: 120_000_000_000, // 120 seconds in nanoseconds
    max_deliver: 3,
  };

  try {
    await jsm.consumers.add(STREAM, consumerConfig);
  } catch (err: any) {
    // Consumer exists with different config — delete and recreate
    if (err?.message?.includes('already exists') || err?.code === '10148') {
      console.log(JSON.stringify({
        level: 'info',
        msg: 'Consumer config changed — recreating',
        component: 'consumer',
        ts: new Date().toISOString(),
      }));
      await jsm.consumers.delete(STREAM, DURABLE_NAME);
      await jsm.consumers.add(STREAM, consumerConfig);
    } else {
      throw err;
    }
  }

  console.log(JSON.stringify({
    level: 'info',
    msg: `Consumer "${DURABLE_NAME}" ready on ${STREAM} (${FILTER_SUBJECT})`,
    ts: new Date().toISOString(),
  }));

  // Consume loop with auto-restart on error
  while (true) {
    try {
      const consumer = await js.consumers.get(STREAM, DURABLE_NAME);
      const messages = await consumer.consume();

      for await (const msg of messages) {
        // Parse just enough to extract sessionId for locking
        let sessionId: string | null = null;
        try {
          const parsed = JSON.parse(new TextDecoder().decode(msg.data));
          sessionId = parsed?.sessionId ?? null;
        } catch {
          // If we can't parse, processMessage will handle the error
        }

        if (sessionId) {
          // Per-session lock: parallel across sessions, sequential within a session
          withSessionLock(sessionId, async () => {
            try {
              await processMessage(msg);
            } catch (err) {
              console.log(JSON.stringify({
                level: 'error',
                msg: 'Error processing message',
                error: String(err),
                ts: new Date().toISOString(),
              }));
              increment('errors');
              safetyGate?.recordError();
              msg.ack();
            }
          });
        } else {
          // No sessionId — process immediately (will likely fail validation)
          try {
            await processMessage(msg);
          } catch (err) {
            console.log(JSON.stringify({
              level: 'error',
              msg: 'Error processing message',
              error: String(err),
              ts: new Date().toISOString(),
            }));
            increment('errors');
            safetyGate?.recordError();
            msg.ack();
          }
        }
      }
    } catch (err) {
      console.log(JSON.stringify({
        level: 'error',
        msg: 'Consumer loop error, restarting in 1s',
        error: String(err),
        ts: new Date().toISOString(),
      }));
      increment('errors');
      safetyGate?.recordError();
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}
