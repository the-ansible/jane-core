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
import { classify, type ClassificationResult } from '../classifier/index.js';

const STREAM = 'COMMUNICATION';
const DURABLE_NAME = 'stimulation-server';
const FILTER_SUBJECT = 'communication.inbound.>';

let safetyGate: SafetyGate | null = null;

export function setSafetyGate(gate: SafetyGate): void {
  safetyGate = gate;
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
  safetyGate?.recordProcess();
  safetyGate?.recordSuccess();

  // Classify the event
  let classification: ClassificationResult | null = null;
  try {
    classification = await classify(result.data.content, result.data.channelType, safetyGate);
    increment('classified');
  } catch (err) {
    console.log(JSON.stringify({
      level: 'error',
      msg: 'Classification failed',
      error: String(err),
      ts: new Date().toISOString(),
    }));
  }

  pushEvent(result.data, msg.subject);
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

  msg.ack();
  return classification;
}

export async function startConsumer(js: JetStreamClient): Promise<void> {
  const jsm = await js.jetstreamManager();

  // Ensure the consumer exists (idempotent upsert)
  await jsm.consumers.add(STREAM, {
    durable_name: DURABLE_NAME,
    filter_subject: FILTER_SUBJECT,
    ack_policy: AckPolicy.Explicit,
    deliver_policy: DeliverPolicy.All,
  });

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
        try {
          processMessage(msg);
        } catch (err) {
          console.log(JSON.stringify({
            level: 'error',
            msg: 'Error processing message',
            error: String(err),
            ts: new Date().toISOString(),
          }));
          increment('errors');
          safetyGate?.recordError();
          msg.ack(); // ack to avoid redelivery loops
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
