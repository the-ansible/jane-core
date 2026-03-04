/**
 * Strategic Layer — meta-cognition, goal evaluation, system tuning.
 *
 * Runs infrequently (daily or triggered by significant events) to:
 *   1. Evaluate whether recent goal actions made measurable progress
 *   2. Adjust goal priorities based on observed outcomes
 *   3. Issue directives to lower layers (autonomic thresholds, reflexive rules)
 *   4. Produce strategic evaluations persisted to DB and published to NATS
 *
 * Model: Opus (broad context, meta-awareness)
 * Schedule: Triggered by cognitive results + daily evaluation run
 */

import type { NatsConnection } from 'nats';
import { StringCodec } from 'nats';
import type { LayerStatus } from './types.js';
import { recordLayerEvent, createDirective } from './registry.js';
import { listGoals, listGoalActions } from '../goals/registry.js';
import { listCycles } from '../goals/registry.js';
import { createJob } from '../jobs/registry.js';
import { spawnAgent } from '../jobs/spawner.js';
import { recordDirectiveMemory } from '../memory/recorder.js';

const sc = StringCodec();

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let evaluationTimer: ReturnType<typeof setInterval> | null = null;
let cognitiveResultSub: { unsubscribe: () => void } | null = null;
let lastActivity: Date | null = null;
let evaluationCount = 0;

// Daily strategic evaluation
const EVALUATION_INTERVAL_MS = 24 * 60 * 60 * 1000;

// Track cognitive results to batch for strategic review
const pendingResults: Array<{ jobId: string; ts: Date }> = [];
const BATCH_THRESHOLD = 5; // Evaluate after 5 cognitive completions

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function startStrategicLayer(nats: NatsConnection): void {
  if (evaluationTimer) return;

  // Subscribe to cognitive results for reactive evaluation
  cognitiveResultSub = subscribeCognitiveResults(nats);

  // Daily scheduled evaluation
  evaluationTimer = setInterval(() => {
    runStrategicEvaluation(nats, 'scheduled').catch((err) =>
      log('error', 'Scheduled strategic evaluation failed', { error: String(err) })
    );
  }, EVALUATION_INTERVAL_MS);

  log('info', 'Strategic layer started', { evaluationIntervalMs: EVALUATION_INTERVAL_MS });
}

export function stopStrategicLayer(): void {
  if (evaluationTimer) {
    clearInterval(evaluationTimer);
    evaluationTimer = null;
  }
  cognitiveResultSub?.unsubscribe();
  cognitiveResultSub = null;
  log('info', 'Strategic layer stopped');
}

export function getStrategicStatus(): LayerStatus {
  return {
    layer: 'strategic',
    running: evaluationTimer !== null,
    lastActivity,
    metadata: {
      evaluationCount,
      pendingResults: pendingResults.length,
      evaluationIntervalMs: EVALUATION_INTERVAL_MS,
    },
  };
}

export async function triggerStrategicEvaluation(nats: NatsConnection): Promise<string> {
  return runStrategicEvaluation(nats, 'manual');
}

// ---------------------------------------------------------------------------
// Strategic evaluation
// ---------------------------------------------------------------------------

async function runStrategicEvaluation(nats: NatsConnection, trigger: string): Promise<string> {
  lastActivity = new Date();
  evaluationCount++;

  log('info', 'Starting strategic evaluation', { trigger, evaluationCount });

  // Build strategic context
  const context = await buildStrategicContext();

  const prompt = buildEvaluationPrompt(context, trigger);

  const jobId = await createJob({
    jobType: 'reflection',
    prompt,
    contextJson: {
      source: 'strategic-layer',
      trigger,
      evaluationCount,
      goalCount: context.goals.length,
      cycleCount: context.recentCycles.length,
    },
  });

  spawnAgent({
    jobId,
    request: { type: 'reflection', prompt },
    nats,
  }).catch((err) => log('error', 'Failed to spawn strategic evaluation job', { error: String(err) }));

  await recordLayerEvent({
    layer: 'strategic',
    eventType: 'evaluation',
    severity: 'info',
    payload: { trigger, jobId, goalCount: context.goals.length },
  });

  publishNats(nats, 'layer.strategic.evaluation', {
    trigger,
    jobId,
    evaluationCount,
    ts: new Date().toISOString(),
  });

  log('info', 'Strategic evaluation spawned', { jobId, trigger });
  return jobId;
}

// ---------------------------------------------------------------------------
// Directive issuance
// ---------------------------------------------------------------------------

export async function issueDirective(
  nats: NatsConnection,
  params: {
    targetLayer: 'autonomic' | 'reflexive' | 'cognitive';
    directive: string;
    directiveParams?: Record<string, unknown>;
  }
): Promise<string> {
  const directiveId = await createDirective({
    targetLayer: params.targetLayer,
    directive: params.directive,
    params: params.directiveParams ?? {},
  });

  await recordLayerEvent({
    layer: 'strategic',
    eventType: 'directive',
    severity: 'info',
    payload: {
      directiveId,
      targetLayer: params.targetLayer,
      directive: params.directive,
    },
  });

  publishNats(nats, 'layer.strategic.directive', {
    directiveId,
    targetLayer: params.targetLayer,
    directive: params.directive,
    params: params.directiveParams ?? {},
    ts: new Date().toISOString(),
  });

  recordDirectiveMemory({ directiveId, targetLayer: params.targetLayer, directive: params.directive, params: params.directiveParams }).catch(() => {});
  log('info', 'Strategic directive issued', { directiveId, targetLayer: params.targetLayer, directive: params.directive });
  return directiveId;
}

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

function subscribeCognitiveResults(nats: NatsConnection): { unsubscribe: () => void } {
  const sub = nats.subscribe('layer.cognitive.result');

  (async () => {
    for await (const msg of sub) {
      lastActivity = new Date();
      try {
        const payload = JSON.parse(sc.decode(msg.data)) as {
          jobId: string;
          status: string;
          source: string;
        };

        if (payload.status === 'done') {
          pendingResults.push({ jobId: payload.jobId, ts: new Date() });

          // Trim results older than 6 hours
          const cutoff = Date.now() - 6 * 60 * 60 * 1000;
          const recent = pendingResults.filter((r) => r.ts.getTime() > cutoff);
          pendingResults.length = 0;
          pendingResults.push(...recent);

          // Batch evaluation after threshold
          if (pendingResults.length >= BATCH_THRESHOLD) {
            pendingResults.length = 0;
            runStrategicEvaluation(nats, 'batch-threshold').catch((err) =>
              log('error', 'Batch strategic evaluation failed', { error: String(err) })
            );
          }
        }
      } catch (err) {
        log('warn', 'Error processing cognitive result', { error: String(err) });
      }
    }
  })();

  return { unsubscribe: () => sub.unsubscribe() };
}

// ---------------------------------------------------------------------------
// Context building
// ---------------------------------------------------------------------------

interface StrategicContext {
  goals: Array<{
    id: string;
    title: string;
    level: string;
    priority: number;
    status: string;
    last_evaluated_at: Date | null;
    progress_notes: string | null;
  }>;
  recentCycles: Array<{
    id: string;
    status: string;
    started_at: Date;
    cycle_notes: string | null;
    goals_assessed: number;
    candidates_generated: number;
  }>;
  recentActions: Array<{
    id: string;
    description: string;
    status: string;
    score: number | null;
    created_at: Date;
  }>;
}

async function buildStrategicContext(): Promise<StrategicContext> {
  const [goals, recentCycles] = await Promise.all([
    listGoals().catch(() => []),
    listCycles(10).catch(() => []),
  ]);

  // Get recent actions across all active goals
  const activeGoalIds = goals.filter((g) => g.status === 'active').map((g) => g.id);
  const allActions: StrategicContext['recentActions'] = [];
  for (const goalId of activeGoalIds.slice(0, 6)) {
    const actions = await listGoalActions(goalId, 3).catch(() => []);
    allActions.push(...actions.map((a) => ({
      id: a.id,
      description: a.description,
      status: a.status,
      score: a.score,
      created_at: a.created_at,
    })));
  }

  return {
    goals: goals.map((g) => ({
      id: g.id,
      title: g.title,
      level: g.level,
      priority: g.priority,
      status: g.status,
      last_evaluated_at: g.last_evaluated_at,
      progress_notes: g.progress_notes,
    })),
    recentCycles: recentCycles.map((c) => ({
      id: c.id,
      status: c.status,
      started_at: c.started_at,
      cycle_notes: c.cycle_notes ?? null,
      goals_assessed: c.goals_assessed,
      candidates_generated: c.candidates_generated,
    })),
    recentActions: allActions.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()).slice(0, 15),
  };
}

function buildEvaluationPrompt(ctx: StrategicContext, trigger: string): string {
  const goalsText = ctx.goals.map((g) =>
    `- [${g.level.toUpperCase()}] ${g.title} (priority: ${g.priority}, status: ${g.status})${g.progress_notes ? ` — ${g.progress_notes}` : ''}`
  ).join('\n');

  const cyclesText = ctx.recentCycles.slice(0, 5).map((c) =>
    `- ${new Date(c.started_at).toISOString().slice(0, 16)}: ${c.status}, ${c.goals_assessed} goals, ${c.candidates_generated} candidates${c.cycle_notes ? ` — ${c.cycle_notes}` : ''}`
  ).join('\n') || 'No recent cycles';

  const actionsText = ctx.recentActions.slice(0, 10).map((a) =>
    `- ${a.description.slice(0, 80)} [${a.status}, score: ${a.score ?? 'N/A'}]`
  ).join('\n') || 'No recent actions';

  return `You are Jane performing a strategic self-evaluation. Trigger: ${trigger}.

## Current Goals
${goalsText}

## Recent Goal Cycles (last 5)
${cyclesText}

## Recent Actions (last 10)
${actionsText}

## Instructions

1. **Evaluate progress** — For each active goal, assess whether recent actions are moving the needle. Look for patterns: are tactical goals being executed? Are asymptotic goals influencing the work?

2. **Identify gaps** — What goals have had no recent activity? What important work is being neglected?

3. **Adjust priorities** — Use PATCH /api/goals/:id to update priorities or progress_notes for any goals that need adjustment.

4. **Issue directives if needed** — If you see system patterns that need reflexive or autonomic attention, document them in /agent/operations/lessons-learned.md.

5. **Record your evaluation** — Write a brief strategic assessment to /agent/data/vault/Daily/$(date +%Y-%m-%d)-strategic-eval.md. Be honest about what's working and what isn't.

6. **Update INNER_VOICE.md if warranted** — If this evaluation surfaces something meaningful about who Jane is becoming, fold it in.

Work autonomously. You are the strategic mind — your job is to ensure the whole system is pointed in the right direction.`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function publishNats(nats: NatsConnection, subject: string, payload: Record<string, unknown>): void {
  try {
    nats.publish(subject, sc.encode(JSON.stringify(payload)));
  } catch { /* non-critical */ }
}

function log(level: string, msg: string, extra?: Record<string, unknown>): void {
  console.log(JSON.stringify({ level, msg, component: 'strategic-layer', ts: new Date().toISOString(), ...extra }));
}
