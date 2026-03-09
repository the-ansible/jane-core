/**
 * Communication Module -- lifecycle management.
 *
 * Initializes the communication pipeline within the brain server:
 * - Context DB schema (brain.comm_* tables)
 * - Safety gate
 * - Pipeline run persistence
 * - Outbound retry loop
 * - JetStream consumer
 *
 * Call startCommunication() after NATS is connected.
 * Call stopCommunication() on graceful shutdown.
 */

import type { NatsConnection, JetStreamClient } from 'nats';
import { SafetyGate } from './safety/index.js';
import { initCommContextSchema } from './context/db.js';
import { initPipelineRunsStore } from './pipeline-runs.js';
import { startRetryLoop, stopRetryLoop } from './outbound.js';
import { startConsumer, setConsumerSafetyGate, setConsumerNats } from './consumer.js';

let safety: SafetyGate | null = null;

export function getCommSafetyGate(): SafetyGate | null {
  return safety;
}

/**
 * Initialize communication module (pre-NATS).
 * Safe to call at server startup even before NATS connects.
 */
export async function initCommunication(): Promise<void> {
  // Load persisted pipeline runs so dashboard has context across restarts
  initPipelineRunsStore();

  // Initialize context DB schema (brain.comm_* tables)
  try {
    await initCommContextSchema();
  } catch (err) {
    console.log(JSON.stringify({
      level: 'error',
      msg: 'Failed to initialize communication context DB',
      component: 'comm',
      error: String(err),
      ts: new Date().toISOString(),
    }));
  }
}

/**
 * Start the communication pipeline (requires NATS + JetStream).
 */
export async function startCommunication(
  nats: NatsConnection,
  js: JetStreamClient
): Promise<SafetyGate> {
  safety = new SafetyGate();
  safety.setNats(nats);

  setConsumerSafetyGate(safety);
  setConsumerNats(nats);

  // Start outbound retry loop
  startRetryLoop(nats);

  // Start JetStream consumer (infinite loop, runs in background)
  startConsumer(js).catch((err) => {
    console.log(JSON.stringify({
      level: 'error',
      msg: 'Communication consumer fatal error',
      component: 'comm',
      error: String(err),
      ts: new Date().toISOString(),
    }));
  });

  console.log(JSON.stringify({
    level: 'info',
    msg: 'Communication module started',
    component: 'comm',
    ts: new Date().toISOString(),
  }));

  return safety;
}

/**
 * Stop the communication module (graceful shutdown).
 */
export function stopCommunication(): void {
  stopRetryLoop();
  console.log(JSON.stringify({
    level: 'info',
    msg: 'Communication module stopped',
    component: 'comm',
    ts: new Date().toISOString(),
  }));
}
