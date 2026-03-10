/**
 * Reflexive Layer — fast, event-driven responses to common stimuli.
 *
 * Subscribes to NATS events and applies rule-based triage before any LLM
 * involvement. If a pattern is recognized and handled, publishes
 * `layer.reflexive.handled`. If escalation is needed, publishes
 * `layer.reflexive.escalate` for the cognitive layer to pick up.
 *
 * Patterns handled:
 *   - autonomic alerts → severity triage (info/warning/critical routing)
 *   - goal cycle status → detect stuck cycles
 *   - job failure patterns → classify failure type
 *   - inbound communication events → urgency-based routing
 */

import type { NatsConnection } from 'nats';
import { StringCodec } from 'nats';
import type { LayerStatus } from './types.js';
import { recordLayerEvent } from './registry.js';
import { launchAgent } from '../executor/index.js';

const sc = StringCodec();

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let subscriptions: Array<{ unsubscribe: () => void }> = [];
let lastActivity: Date | null = null;
let handledCount = 0;
let escalatedCount = 0;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function startReflexiveLayer(nats: NatsConnection): void {
  if (subscriptions.length > 0) return;

  subscriptions = [
    subscribeAutonomicAlerts(nats),
    subscribeGoalCycleStatus(nats),
    subscribeJobFailures(nats),
  ];

  log('info', 'Reflexive layer started', { subscriptions: subscriptions.length });
}

export function stopReflexiveLayer(): void {
  for (const sub of subscriptions) sub.unsubscribe();
  subscriptions = [];
  log('info', 'Reflexive layer stopped');
}

export function getReflexiveStatus(): LayerStatus {
  return {
    layer: 'reflexive',
    running: subscriptions.length > 0,
    lastActivity,
    metadata: {
      subscriptions: subscriptions.length,
      handledCount,
      escalatedCount,
    },
  };
}

// ---------------------------------------------------------------------------
// Pattern handlers
// ---------------------------------------------------------------------------

function subscribeAutonomicAlerts(nats: NatsConnection): { unsubscribe: () => void } {
  const sub = nats.subscribe('layer.autonomic.alert');

  (async () => {
    for await (const msg of sub) {
      lastActivity = new Date();
      try {
        const payload = JSON.parse(sc.decode(msg.data)) as {
          monitor: string;
          severity: string;
          message: string;
          data?: Record<string, unknown>;
        };

        if (payload.severity === 'critical') {
          // Critical alerts need cognitive layer to investigate and potentially take action
          const escalationReason = `Autonomic critical alert: ${payload.monitor} — ${payload.message}`;
          await escalateToCognitive(nats, {
            trigger: 'autonomic.critical',
            monitor: payload.monitor,
            message: payload.message,
            data: payload.data ?? {},
          }, escalationReason);

          escalatedCount++;
        } else {
          // Warnings are logged and handled — no escalation
          await recordLayerEvent({
            layer: 'reflexive',
            eventType: 'handled',
            severity: 'info',
            payload: { trigger: 'autonomic.warning', monitor: payload.monitor, message: payload.message },
          });

          publishNats(nats, 'layer.reflexive.handled', {
            trigger: 'autonomic.warning',
            monitor: payload.monitor,
            message: payload.message,
            ts: new Date().toISOString(),
          });

          handledCount++;
        }
      } catch (err) {
        log('warn', 'Failed to process autonomic alert', { error: String(err) });
      }
    }
  })().catch((err) => log('error', 'Autonomic alert subscription loop exited', { error: String(err) }));

  return { unsubscribe: () => sub.unsubscribe() };
}

function subscribeGoalCycleStatus(nats: NatsConnection): { unsubscribe: () => void } {
  const sub = nats.subscribe('goals.cycle.status');
  const recentFailures: Date[] = [];

  (async () => {
    for await (const msg of sub) {
      lastActivity = new Date();
      try {
        const payload = JSON.parse(sc.decode(msg.data)) as {
          cycleId: string;
          status: string;
          notes?: string;
        };

        if (payload.status === 'failed') {
          recentFailures.push(new Date());
          // Keep only last 10 minutes
          const cutoff = Date.now() - 10 * 60 * 1000;
          const recent = recentFailures.filter((d) => d.getTime() > cutoff);
          recentFailures.length = 0;
          recentFailures.push(...recent);

          if (recent.length >= 3) {
            // 3+ failures in 10 min — escalate
            await escalateToCognitive(nats, {
              trigger: 'goal.cycle.repeated_failures',
              cycleId: payload.cycleId,
              failureCount: recent.length,
              notes: payload.notes,
            }, `Goal engine failing repeatedly: ${recent.length} failures in 10 minutes`);
            escalatedCount++;
          } else {
            // Single failure — log and handle
            await recordLayerEvent({
              layer: 'reflexive',
              eventType: 'handled',
              severity: 'warning',
              payload: { trigger: 'goal.cycle.failed', cycleId: payload.cycleId, notes: payload.notes },
            });
            handledCount++;
          }
        }
      } catch (err) {
        log('warn', 'Failed to process goal cycle status', { error: String(err) });
      }
    }
  })().catch((err) => log('error', 'Goal cycle status subscription loop exited', { error: String(err) }));

  return { unsubscribe: () => sub.unsubscribe() };
}

function subscribeJobFailures(nats: NatsConnection): { unsubscribe: () => void } {
  // Subscribe to agent results to detect systematic failures
  const sub = nats.subscribe('agent.results.*');
  const recentFailures: { jobId: string; ts: Date }[] = [];

  (async () => {
    for await (const msg of sub) {
      lastActivity = new Date();
      try {
        const payload = JSON.parse(sc.decode(msg.data)) as {
          jobId?: string;
          status?: string;
          error?: string;
        };

        if (payload.status === 'failed') {
          recentFailures.push({ jobId: payload.jobId ?? 'unknown', ts: new Date() });
          // Keep only last 30 minutes
          const cutoff = Date.now() - 30 * 60 * 1000;
          const recent = recentFailures.filter((f) => f.ts.getTime() > cutoff);
          recentFailures.length = 0;
          recentFailures.push(...recent);

          if (recent.length >= 5) {
            await escalateToCognitive(nats, {
              trigger: 'job.systematic_failures',
              recentFailures: recent.map((f) => f.jobId),
              failureCount: recent.length,
            }, `Systematic job failures: ${recent.length} failed in 30 minutes`);
            escalatedCount++;
            // Clear to avoid repeated escalation on same batch
            recentFailures.length = 0;
          } else {
            await recordLayerEvent({
              layer: 'reflexive',
              eventType: 'handled',
              severity: 'warning',
              payload: { trigger: 'job.failed', jobId: payload.jobId, error: payload.error },
            });
            handledCount++;
          }
        }
      } catch (err) {
        log('warn', 'Failed to process job result', { error: String(err) });
      }
    }
  })().catch((err) => log('error', 'Job failures subscription loop exited', { error: String(err) }));

  return { unsubscribe: () => sub.unsubscribe() };
}

// ---------------------------------------------------------------------------
// Escalation
// ---------------------------------------------------------------------------

async function escalateToCognitive(
  nats: NatsConnection,
  context: Record<string, unknown>,
  reason: string
): Promise<void> {
  await recordLayerEvent({
    layer: 'reflexive',
    eventType: 'escalate',
    severity: 'warning',
    payload: { reason, context },
  });

  publishNats(nats, 'layer.reflexive.escalate', {
    reason,
    context,
    ts: new Date().toISOString(),
  });

  // Launch an investigator agent to handle the escalation
  try {
    const prompt = buildEscalationPrompt(reason, context);

    const result = await launchAgent({
      role: 'investigator',
      prompt,
      runtime: { tool: 'claude-code', model: 'sonnet' },
      jobType: 'task',
      context: [JSON.stringify({ source: 'reflexive-escalation', ...context })],
    });

    log('info', 'Escalated to cognitive layer', { reason, jobId: result.jobId });
  } catch (err) {
    log('error', 'Failed to launch escalation agent', { error: String(err) });
  }
}

function buildEscalationPrompt(reason: string, context: Record<string, unknown>): string {
  return `You are Jane. A system alert has been escalated to you that requires investigation and action.

## Alert
${reason}

## Context
${JSON.stringify(context, null, 2)}

## Instructions
1. Investigate the root cause of this alert
2. Check relevant logs, service status, and system state
3. Take corrective action if possible (restart services, fix configuration, etc.)
4. If you cannot resolve it, document what you found and why it cannot be auto-resolved
5. Send a brief status update via the compose-and-send endpoint when done

Work autonomously. Check \`/agent/operations/lessons-learned.md\` for relevant prior experience.`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function publishNats(nats: NatsConnection, subject: string, payload: Record<string, unknown>): void {
  try {
    nats.publish(subject, sc.encode(JSON.stringify(payload)));
  } catch (err) { log('warn', 'Failed to publish NATS event', { subject, error: String(err) }); }
}

function log(level: string, msg: string, extra?: Record<string, unknown>): void {
  console.log(JSON.stringify({ level, msg, component: 'reflexive-layer', ts: new Date().toISOString(), ...extra }));
}
