/**
 * Cognitive Layer — deliberate multi-step reasoning and execution.
 *
 * This layer wraps the existing job spawner (Claude CLI subprocesses) and adds:
 *   - Escalation intake from the reflexive layer
 *   - Result publication to the strategic layer
 *   - Cognitive event logging for strategic review
 *
 * The cognitive layer operates on-demand, triggered by:
 *   1. Direct job submissions (HTTP API or NATS `agent.jobs.request`)
 *   2. Reflexive layer escalations (`layer.reflexive.escalate`)
 *   3. Strategic layer directives (`layer.strategic.directive`)
 *
 * Model: Claude (Sonnet for analysis, Opus for strategic work)
 */

import type { NatsConnection } from 'nats';
import { StringCodec } from 'nats';
import type { LayerStatus } from './types.js';
import { recordLayerEvent } from './registry.js';

const sc = StringCodec();

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let escalationSub: { unsubscribe: () => void } | null = null;
let directiveSub: { unsubscribe: () => void } | null = null;
let lastActivity: Date | null = null;
let completedCount = 0;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function startCognitiveLayer(nats: NatsConnection): void {
  if (escalationSub) return;

  // Listen for reflexive escalations
  escalationSub = subscribeEscalations(nats);

  // Listen for strategic directives aimed at cognitive layer
  directiveSub = subscribeDirectives(nats);

  // Listen for cognitive job completions to record them
  subscribeJobResults(nats);

  log('info', 'Cognitive layer started');
}

export function stopCognitiveLayer(): void {
  escalationSub?.unsubscribe();
  directiveSub?.unsubscribe();
  escalationSub = null;
  directiveSub = null;
  log('info', 'Cognitive layer stopped');
}

export function getCognitiveStatus(): LayerStatus {
  return {
    layer: 'cognitive',
    running: escalationSub !== null,
    lastActivity,
    metadata: {
      completedCount,
    },
  };
}

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

function subscribeEscalations(nats: NatsConnection): { unsubscribe: () => void } {
  // Reflexive layer already spawns cognitive jobs for escalations.
  // Here we just track them for observability.
  const sub = nats.subscribe('layer.reflexive.escalate');

  (async () => {
    for await (const msg of sub) {
      lastActivity = new Date();
      try {
        const payload = JSON.parse(sc.decode(msg.data)) as {
          reason: string;
          context: Record<string, unknown>;
        };

        log('info', 'Cognitive layer received escalation', { reason: payload.reason });

        await recordLayerEvent({
          layer: 'cognitive',
          eventType: 'result',
          severity: 'info',
          payload: { action: 'escalation_received', reason: payload.reason },
        });
      } catch (err) {
        log('warn', 'Error processing escalation', { error: String(err) });
      }
    }
  })();

  return { unsubscribe: () => sub.unsubscribe() };
}

function subscribeDirectives(nats: NatsConnection): { unsubscribe: () => void } {
  const sub = nats.subscribe('layer.strategic.directive');

  (async () => {
    for await (const msg of sub) {
      lastActivity = new Date();
      try {
        const payload = JSON.parse(sc.decode(msg.data)) as {
          targetLayer: string;
          directive: string;
          params: Record<string, unknown>;
        };

        if (payload.targetLayer !== 'cognitive') continue;

        log('info', 'Cognitive layer received strategic directive', { directive: payload.directive });

        await recordLayerEvent({
          layer: 'cognitive',
          eventType: 'result',
          severity: 'info',
          payload: { action: 'directive_received', directive: payload.directive, params: payload.params },
        });

        // Directives for the cognitive layer are currently logged.
        // Future: automatically spawn jobs to execute directives.
      } catch (err) {
        log('warn', 'Error processing directive', { error: String(err) });
      }
    }
  })();

  return { unsubscribe: () => sub.unsubscribe() };
}

function subscribeJobResults(nats: NatsConnection): void {
  const sub = nats.subscribe('agent.results.*');

  (async () => {
    for await (const msg of sub) {
      lastActivity = new Date();
      completedCount++;

      try {
        const payload = JSON.parse(sc.decode(msg.data)) as {
          jobId?: string;
          status?: string;
          source?: string;
        };

        // Publish to strategic layer for meta-review if it was a goal-engine job
        if (payload.source === 'goal-engine' && payload.status === 'done') {
          nats.publish('layer.cognitive.result', sc.encode(JSON.stringify({
            jobId: payload.jobId,
            status: payload.status,
            source: payload.source,
            ts: new Date().toISOString(),
          })));
        }
      } catch { /* non-critical */ }
    }
  })();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(level: string, msg: string, extra?: Record<string, unknown>): void {
  console.log(JSON.stringify({ level, msg, component: 'cognitive-layer', ts: new Date().toISOString(), ...extra }));
}
