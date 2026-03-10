/**
 * Consumer -- JetStream consumer for inbound communication events.
 * No classifier. Routing is sender-driven via CommunicationEvent fields.
 * Validates, deduplicates, routes, and feeds the pipeline.
 */

import {
  JetStreamClient,
  AckPolicy,
  DeliverPolicy,
  JsMsg,
} from 'nats';
import { communicationEventSchema } from '@the-ansible/life-system-shared';
import type { CommunicationEvent } from '@the-ansible/life-system-shared';
import type { NatsConnection } from 'nats';
import { increment } from './metrics.js';
import { pushEvent } from './events.js';
import { recordTimelineEvent, recordTimelineDedup, recordTimelineError } from './event-timeline.js';
import type { SafetyGate } from './safety/index.js';
import { routeEvent } from './router.js';
import { processPipeline, type PipelineDeps } from './pipeline.js';
import { completeRun } from './pipeline-runs.js';
import { getMessageCount } from './sessions/store.js';

const STREAM = 'COMMUNICATION';
const DURABLE_NAME = 'brain-communication';
const FILTER_SUBJECT = 'communication.inbound.>';

// Deduplication
const DEDUP_MAX_SIZE = 500;
const DEDUP_TTL_MS = 10 * 60 * 1000;
const processedEvents = new Map<string, number>();

function isDuplicate(eventId: string): boolean {
  const now = Date.now();

  if (processedEvents.size > DEDUP_MAX_SIZE) {
    for (const [id, ts] of processedEvents) {
      if (now - ts > DEDUP_TTL_MS) processedEvents.delete(id);
    }
  }

  if (processedEvents.has(eventId)) return true;
  processedEvents.set(eventId, now);
  return false;
}

export function clearDedupCache(): void {
  processedEvents.clear();
}

// Per-session lock: only one pipeline per session at a time
const sessionLocks = new Map<string, Promise<void>>();

function withSessionLock(sessionId: string, fn: () => Promise<void>): Promise<void> {
  const prev = sessionLocks.get(sessionId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  sessionLocks.set(sessionId, next);
  next.then(() => {
    if (sessionLocks.get(sessionId) === next) sessionLocks.delete(sessionId);
  });
  return next;
}

let safetyGate: SafetyGate | null = null;
let natsConn: NatsConnection | null = null;

export function setConsumerSafetyGate(gate: SafetyGate): void {
  safetyGate = gate;
}

export function setConsumerNats(nc: NatsConnection): void {
  natsConn = nc;
}

interface PreProcessResult {
  event: CommunicationEvent;
}

/**
 * Pre-process: parse, validate, dedup, push to dashboard.
 * Runs OUTSIDE the session lock so dashboard shows new messages immediately.
 */
async function preProcess(msg: JsMsg): Promise<PreProcessResult | null> {
  increment('received');

  let data: unknown;
  try {
    data = JSON.parse(new TextDecoder().decode(msg.data));
  } catch {
    console.log(JSON.stringify({
      level: 'error',
      msg: 'Failed to parse message JSON',
      component: 'comm.consumer',
      subject: msg.subject,
      ts: new Date().toISOString(),
    }));
    increment('validationErrors');
    msg.ack();
    return null;
  }

  const result = communicationEventSchema.safeParse(data);

  if (!result.success) {
    const rawChannelType = (data as any)?.channelType;
    if (rawChannelType === 'interactive') {
      msg.ack();
      return null;
    }
    console.log(JSON.stringify({
      level: 'warn',
      msg: 'Validation failed',
      component: 'comm.consumer',
      subject: msg.subject,
      errors: result.error.issues,
      ts: new Date().toISOString(),
    }));
    increment('validationErrors');
    msg.ack();
    return null;
  }

  increment('validated');

  // Block interactive events from entering the pipeline
  if (result.data.channelType === 'interactive') {
    msg.ack();
    return null;
  }

  // Deduplication
  if (isDuplicate(result.data.id)) {
    console.log(JSON.stringify({
      level: 'info',
      msg: 'Duplicate event skipped',
      component: 'comm.consumer',
      eventId: result.data.id,
      ts: new Date().toISOString(),
    }));
    increment('deduplicated');
    recordTimelineDedup();
    msg.ack();
    return null;
  }

  safetyGate?.recordProcess();
  safetyGate?.recordSuccess();

  // Route (sender-driven, no classifier)
  const routing = routeEvent(result.data);

  // Push to dashboard with routing info
  pushEvent(result.data, msg.subject, {
    action: routing.action,
    reason: routing.reason,
    targetRole: routing.targetRole,
    targetId: routing.targetId,
  });

  // Record in timeline
  recordTimelineEvent({
    channelType: result.data.channelType,
    direction: result.data.direction,
    routingAction: routing.action,
  });

  console.log(JSON.stringify({
    level: 'info',
    msg: 'Event received',
    component: 'comm.consumer',
    event: {
      id: result.data.id,
      channelType: result.data.channelType,
      direction: result.data.direction,
      sessionId: result.data.sessionId,
      contentPreview: result.data.content.slice(0, 100),
    },
    routing: {
      action: routing.action,
      reason: routing.reason,
    },
    subject: msg.subject,
    ts: new Date().toISOString(),
  }));

  return { event: result.data };
}

/**
 * Execute the pipeline for a routed event. Runs INSIDE the session lock.
 */
async function executePipeline(
  event: CommunicationEvent,
  msg: JsMsg,
  deps: PipelineDeps,
): Promise<void> {
  msg.working();

  try {
    const pipelineResult = await processPipeline(event, deps);
    increment('pipelineProcessed');

    console.log(JSON.stringify({
      level: 'info',
      msg: 'Pipeline completed',
      component: 'comm.consumer',
      eventId: event.id,
      action: pipelineResult.action,
      responded: pipelineResult.responded,
      responseEventId: pipelineResult.responseEventId,
      ts: new Date().toISOString(),
    }));
  } catch (err) {
    completeRun(event.id, 'failure', { error: `Pipeline crash: ${err}` });
    console.log(JSON.stringify({
      level: 'error',
      msg: 'Pipeline processing failed',
      component: 'comm.consumer',
      eventId: event.id,
      error: String(err),
      ts: new Date().toISOString(),
    }));
    increment('errors');
    recordTimelineError();
  }

  msg.ack();
}

/**
 * Start the JetStream consumer.
 */
export async function startConsumer(js: JetStreamClient): Promise<void> {
  const jsm = await js.jetstreamManager();

  const consumerConfig = {
    durable_name: DURABLE_NAME,
    filter_subject: FILTER_SUBJECT,
    ack_policy: AckPolicy.Explicit,
    deliver_policy: DeliverPolicy.New,
    ack_wait: 120_000_000_000, // 120s in nanoseconds
    max_deliver: 3,
  };

  try {
    await jsm.consumers.add(STREAM, consumerConfig);
  } catch (err: any) {
    if (err?.message?.includes('already exists') || err?.code === '10148') {
      console.log(JSON.stringify({
        level: 'info',
        msg: 'Consumer config changed -- recreating',
        component: 'comm.consumer',
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
    component: 'comm.consumer',
    ts: new Date().toISOString(),
  }));

  const pipelineDeps: PipelineDeps = {
    nats: natsConn,
    safety: safetyGate,
  };

  // Consume loop with auto-restart on error
  while (true) {
    try {
      const consumer = await js.consumers.get(STREAM, DURABLE_NAME);
      const messages = await consumer.consume();

      for await (const msg of messages) {
        (async () => {
          try {
            const preResult = await preProcess(msg);
            if (!preResult) return;

            const { event } = preResult;

            withSessionLock(event.sessionId, () =>
              executePipeline(event, msg, pipelineDeps)
            );
          } catch (err) {
            console.log(JSON.stringify({
              level: 'error',
              msg: 'Error processing message',
              component: 'comm.consumer',
              error: String(err),
              ts: new Date().toISOString(),
            }));
            increment('errors');
            safetyGate?.recordError();
            msg.ack();
          }
        })().catch((err) => {
          console.log(JSON.stringify({
            level: 'error',
            msg: 'Unhandled error in message processor',
            component: 'comm.consumer',
            error: String(err),
            ts: new Date().toISOString(),
          }));
        });
      }
    } catch (err) {
      console.log(JSON.stringify({
        level: 'error',
        msg: 'Consumer loop error, restarting in 1s',
        component: 'comm.consumer',
        error: String(err),
        ts: new Date().toISOString(),
      }));
      increment('errors');
      safetyGate?.recordError();
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}
