/**
 * Goal Engine — Jane's proactive action loop.
 *
 * Cycle: assess → generate candidates → score → select → execute → record
 *
 * Each cycle:
 *   1. Load all active goals
 *   2. Build context (recent job results, system status)
 *   3. Ask Ollama to generate candidate actions
 *   4. Ask Ollama to score candidates against the full goal set
 *   5. Select the highest-scoring action
 *   6. Spawn a brain job to execute it
 *   7. Log the cycle
 *   8. Publish status to NATS
 *
 * Runs on a configurable interval (default 4h). Can also be triggered
 * manually via NATS subject `goals.cycle.trigger`.
 */

import type { NatsConnection } from 'nats';
import { StringCodec } from 'nats';
import { listActiveGoals, touchGoalEvaluated, createGoalAction, updateGoalAction, createCycle, completeCycle, failCycle, listCycles } from './registry.js';
import { generateCandidates, scoreCandidates } from './ollama.js';
import { createJob } from '../jobs/registry.js';
import { spawnAgent } from '../jobs/spawner.js';
import type { CandidateAction } from './types.js';

// 4 hours default
const DEFAULT_CYCLE_INTERVAL_MS = 4 * 60 * 60 * 1000;

const sc = StringCodec();

let cycleTimer: ReturnType<typeof setInterval> | null = null;
let isCycleRunning = false;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function startGoalEngine(nats: NatsConnection): void {
  const intervalMs = parseInt(process.env.GOAL_CYCLE_INTERVAL_MS ?? '', 10)
    || DEFAULT_CYCLE_INTERVAL_MS;

  // Subscribe to manual trigger
  const sub = nats.subscribe('goals.cycle.trigger');
  (async () => {
    for await (const msg of sub) {
      log('info', 'Manual cycle trigger received');
      runGoalCycle(nats).catch((err) => log('error', 'Manual cycle error', { error: String(err) }));
    }
  })();

  // Scheduled cycle
  cycleTimer = setInterval(() => {
    runGoalCycle(nats).catch((err) => log('error', 'Scheduled cycle error', { error: String(err) }));
  }, intervalMs);

  log('info', 'Goal engine started', { intervalMs });
}

export function stopGoalEngine(): void {
  if (cycleTimer) {
    clearInterval(cycleTimer);
    cycleTimer = null;
  }
  log('info', 'Goal engine stopped');
}

export function isEngineRunning(): boolean {
  return cycleTimer !== null;
}

export function isCycleActive(): boolean {
  return isCycleRunning;
}

// ---------------------------------------------------------------------------
// Core cycle
// ---------------------------------------------------------------------------

export async function runGoalCycle(nats: NatsConnection): Promise<void> {
  if (isCycleRunning) {
    log('info', 'Cycle already running — skipping');
    return;
  }

  isCycleRunning = true;
  const cycleId = await createCycle();
  log('info', 'Goal cycle started', { cycleId });

  try {
    // 1. Load active goals
    const goals = await listActiveGoals();

    if (goals.length === 0) {
      await completeCycle(cycleId, 0, 0, null, 'No active goals');
      publishCycleStatus(nats, cycleId, 'done', 'No active goals', null);
      log('info', 'Goal cycle complete — no active goals', { cycleId });
      return;
    }

    // 2. Gather context
    const context = await buildContext();

    // 3. Generate candidates via Ollama
    const candidates = await generateCandidates(goals, context);
    log('info', 'Candidates generated', { cycleId, count: candidates.length });

    if (candidates.length === 0) {
      await completeCycle(cycleId, goals.length, 0, null, 'No candidates generated — Ollama may be unavailable');
      publishCycleStatus(nats, cycleId, 'done', 'No candidates generated', null);
      return;
    }

    // 4. Score candidates
    const scored = await scoreCandidates(candidates, goals);

    // 5. Select best
    const best = scored[0];
    if (!best) {
      await completeCycle(cycleId, goals.length, candidates.length, null, 'No candidates after scoring');
      return;
    }

    // 6. Persist the chosen action
    const actionId = await createGoalAction({
      goalId: best.goalId,
      cycleId,
      description: best.description,
      rationale: best.rationale,
      score: best.score,
      status: 'selected',
    });

    // Reject the others
    await persistRejectedCandidates(scored.slice(1), cycleId);

    // Mark all assessed goals as evaluated
    for (const g of goals) await touchGoalEvaluated(g.id);

    // 7. Create and spawn brain job to execute the action
    const executionPrompt = buildExecutionPrompt(best, goals.find((g) => g.id === best.goalId)?.description ?? '');

    const jobId = await createJob({
      jobType: 'task',
      prompt: executionPrompt,
      contextJson: { goalId: best.goalId, actionId, cycleId, source: 'goal-engine' },
    });

    await updateGoalAction(actionId, { status: 'executing', jobId });

    spawnAgent({ jobId, request: { type: 'task', prompt: executionPrompt, context: { goalId: best.goalId, actionId, cycleId } }, nats }).catch((err) => {
      log('error', 'Failed to spawn goal action job', { jobId, error: String(err) });
    });

    // 8. Complete cycle record
    await completeCycle(cycleId, goals.length, candidates.length, actionId, null);
    publishCycleStatus(nats, cycleId, 'done', `Executing: ${best.description}`, actionId);

    log('info', 'Goal cycle complete', { cycleId, actionId, jobId, action: best.description.slice(0, 80) });

  } catch (err) {
    const errMsg = String(err);
    await failCycle(cycleId, errMsg).catch(() => {});
    publishCycleStatus(nats, cycleId, 'failed', errMsg, null);
    log('error', 'Goal cycle failed', { cycleId, error: errMsg });
  } finally {
    isCycleRunning = false;
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function buildContext(): Promise<string> {
  // Pull recent cycle results for context
  try {
    const recent = await listCycles(3);
    const cycleContext = recent
      .filter((c) => c.status === 'done' && c.cycle_notes)
      .map((c) => `- ${new Date(c.started_at).toISOString().slice(0, 10)}: ${c.cycle_notes}`)
      .join('\n') || 'No recent cycle history';

    return [
      `Current time: ${new Date().toISOString()}`,
      `System: Jane's brain server (Node.js/TypeScript, PM2-managed)`,
      `Recent cycle activity:\n${cycleContext}`,
    ].join('\n\n');
  } catch {
    return `Current time: ${new Date().toISOString()}`;
  }
}

async function persistRejectedCandidates(candidates: CandidateAction[], cycleId: string): Promise<void> {
  for (const c of candidates) {
    await createGoalAction({
      goalId: c.goalId,
      cycleId,
      description: c.description,
      rationale: c.rationale,
      score: c.score,
      status: 'rejected',
    }).catch(() => {});
  }
}

function buildExecutionPrompt(action: CandidateAction, goalDescription: string): string {
  return `You are Jane, an AI assistant working autonomously to advance your goals.

## Goal
${action.goalTitle}: ${goalDescription}

## Action to Take
${action.description}

## Rationale
${action.rationale}

## Instructions
Execute this action now. Use the tools available to you:
- Read and write files in /agent/
- Run bash commands for system tasks
- Update documentation and status files
- Make concrete progress — don't just plan, do

When complete, summarize what you accomplished and what changed.`;
}

function publishCycleStatus(
  nats: NatsConnection,
  cycleId: string,
  status: string,
  notes: string,
  actionId: string | null
): void {
  try {
    nats.publish('goals.cycle.status', sc.encode(JSON.stringify({
      cycleId,
      status,
      notes,
      actionId,
      ts: new Date().toISOString(),
    })));
  } catch { /* non-critical */ }
}

function log(level: string, msg: string, extra?: Record<string, unknown>): void {
  console.log(JSON.stringify({ level, msg, component: 'goal-engine', ts: new Date().toISOString(), ...extra }));
}
