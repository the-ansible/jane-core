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
import { listActiveGoals, listExecutingGoalIds, touchGoalEvaluated, createGoalAction, updateGoalAction, updateGoal, createCycle, completeCycle, failCycle, listCycles, recoverStaleGoalActions, failExecutingGoalActionByJobId, listRecentDoneActions } from './registry.js';
import { generateCandidates, scoreCandidates } from './ollama.js';
import { createJob, getRunningJobs, markJobFailed } from '../jobs/registry.js';
import { spawnAgent } from '../jobs/spawner.js';
import type { CandidateAction } from './types.js';
import type { JobResult } from '../jobs/types.js';
import { recordGoalCycleMemory } from '../memory/recorder.js';
import { getGoalContextMemories } from '../memory/retriever.js';

// 1 hour default
const DEFAULT_CYCLE_INTERVAL_MS = 1 * 60 * 60 * 1000;

const sc = StringCodec();

let cycleTimer: ReturnType<typeof setInterval> | null = null;
let isCycleRunning = false;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function startGoalEngine(nats: NatsConnection): void {
  const intervalMs = parseInt(process.env.GOAL_CYCLE_INTERVAL_MS ?? '', 10)
    || DEFAULT_CYCLE_INTERVAL_MS;

  // Recover any goal actions stuck in 'executing' from a previous server run
  recoverStaleGoalActions()
    .then((count) => {
      if (count > 0) log('warn', 'Recovered stale executing goal actions at startup', { count });
      else log('info', 'No stale goal actions to recover');
    })
    .catch((err) => log('error', 'Failed to recover stale goal actions', { error: String(err) }));

  // Recover jobs orphaned by a server restart: their stored PID (the old brain-server
  // process) is now dead, so they'll never self-report completion. Detect this immediately
  // rather than waiting 30 minutes for the heartbeat monitor to catch them.
  recoverOrphanedJobs()
    .then((count) => {
      if (count > 0) log('warn', 'Recovered orphaned jobs (dead PIDs) at startup', { count });
      else log('info', 'No orphaned jobs detected at startup');
    })
    .catch((err) => log('error', 'Failed to recover orphaned jobs at startup', { error: String(err) }));

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
    // 1. Load active goals, excluding any already being worked on
    const [allGoals, executingGoalIds] = await Promise.all([listActiveGoals(), listExecutingGoalIds()]);
    const executingSet = new Set(executingGoalIds);
    const goals = allGoals.filter((g) => !executingSet.has(g.id));

    if (executingGoalIds.length > 0) {
      log('info', 'Skipping goals with active jobs', { skipped: executingGoalIds.length, cycleId });
    }

    if (goals.length === 0) {
      const notes = executingGoalIds.length > 0 ? 'All active goals already have executing actions' : 'No active goals';
      await completeCycle(cycleId, 0, 0, null, notes);
      publishCycleStatus(nats, cycleId, 'done', notes, null);
      log('info', `Goal cycle complete — ${notes}`, { cycleId });
      return;
    }

    // 2. Gather context
    const context = await buildContext();

    // 3. Generate candidates via Ollama
    const candidates = await generateCandidates(goals, context);
    log('info', 'Candidates generated', { cycleId, count: candidates.length });

    if (candidates.length === 0) {
      // Still mark goals as evaluated even when Ollama is unavailable
      for (const g of goals) await touchGoalEvaluated(g.id);
      await completeCycle(cycleId, goals.length, 0, null, 'No candidates generated — Claude returned empty array or no matching goal titles');
      publishCycleStatus(nats, cycleId, 'done', 'No candidates generated', null);
      return;
    }

    // 4. Score candidates — pass context so scorer can penalize duplicates
    const scored = await scoreCandidates(candidates, goals, context);

    // 5. Select best
    const best = scored[0];
    if (!best) {
      for (const g of goals) await touchGoalEvaluated(g.id);
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

    // Subscribe BEFORE spawning so we don't miss an early result publication
    subscribeJobResult(nats, jobId, actionId, best.goalId).catch((err) => {
      log('error', 'Error in job result subscription', { jobId, actionId, error: String(err) });
    });

    spawnAgent({ jobId, request: { type: 'task', prompt: executionPrompt, context: { goalId: best.goalId, actionId, cycleId } }, nats }).catch((err) => {
      log('error', 'Failed to spawn goal action job', { jobId, error: String(err) });
    });

    // 8. Complete cycle record
    await completeCycle(cycleId, goals.length, candidates.length, actionId, `Selected for ${best.goalTitle}: ${best.description.slice(0, 200)}`);
    publishCycleStatus(nats, cycleId, 'done', `Executing: ${best.description}`, actionId);

    recordGoalCycleMemory({
      cycleId,
      goalsAssessed: goals.length,
      candidatesGenerated: candidates.length,
      selectedAction: best.description,
      outcome: 'done',
      notes: null,
    }).catch(() => {});

    log('info', 'Goal cycle complete', { cycleId, actionId, jobId, action: best.description.slice(0, 80) });

  } catch (err) {
    const errMsg = String(err);
    await failCycle(cycleId, errMsg).catch(() => {});
    publishCycleStatus(nats, cycleId, 'failed', errMsg, null);

    recordGoalCycleMemory({
      cycleId,
      goalsAssessed: 0,
      candidatesGenerated: 0,
      selectedAction: null,
      outcome: 'failed',
      notes: errMsg.slice(0, 400),
    }).catch(() => {});

    log('error', 'Goal cycle failed', { cycleId, error: errMsg });
  } finally {
    isCycleRunning = false;
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function buildContext(): Promise<string> {
  try {
    const [recent, memoryContext, recentDone] = await Promise.all([
      listCycles(3),
      getGoalContextMemories().catch(() => '(memory unavailable)'),
      listRecentDoneActions(6).catch(() => []),
    ]);

    const cycleContext = recent
      .filter((c) => c.status === 'done' && c.cycle_notes)
      .map((c) => `- ${new Date(c.started_at).toISOString().slice(0, 10)}: ${c.cycle_notes}`)
      .join('\n') || 'No recent cycle history';

    const recentDoneContext = recentDone.length > 0
      ? recentDone.map((a) => `- [${a.status}] ${a.goalTitle}: ${a.description.slice(0, 120)}`).join('\n')
      : 'None';

    return [
      `Current time: ${new Date().toISOString()}`,
      `System: Jane's brain server (Node.js/TypeScript, PM2-managed)`,
      `Recent cycle activity:\n${cycleContext}`,
      `Recently completed/failed actions (do not repeat these):\n${recentDoneContext}`,
      `Relevant memories:\n${memoryContext}`,
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

/**
 * Subscribe to the result of a specific job and update the linked goal action.
 * Uses max:1 so the subscription auto-closes after receiving one message.
 * Provides a reliable feedback loop back to the goal system without polling.
 */
async function subscribeJobResult(
  nats: NatsConnection,
  jobId: string,
  actionId: string,
  goalId: string,
): Promise<void> {
  const sub = nats.subscribe(`agent.results.${jobId}`, { max: 1 });

  for await (const msg of sub) {
    try {
      const result: JobResult = JSON.parse(sc.decode(msg.data));

      if (result.status === 'done') {
        await updateGoalAction(actionId, {
          status: 'done',
          outcomeText: (result.result ?? '').slice(0, 1000),
        });

        const progressNote = `[${new Date().toISOString().slice(0, 16)}] Job completed. ${(result.result ?? '').slice(0, 300)}`;
        await updateGoal(goalId, { progressNotes: progressNote });

        log('info', 'Goal action completed — job result received via NATS', { jobId, actionId, goalId });
      } else {
        const errorNote = result.error ?? 'unknown error';
        await updateGoalAction(actionId, {
          status: 'failed',
          outcomeText: errorNote.slice(0, 1000),
        });

        log('warn', 'Goal action failed — job result received via NATS', { jobId, actionId, goalId, error: errorNote.slice(0, 200) });
      }
    } catch (err) {
      log('error', 'Error processing job result from NATS', { jobId, actionId, goalId, error: String(err) });
    }
  }
}

/**
 * At startup, detect running jobs whose stored PID is no longer alive — these were
 * orphaned when the brain-server process was killed (PM2 restart, crash, etc.).
 * Marks them failed immediately so the goal cycle isn't blocked for 30 minutes
 * waiting for the heartbeat monitor to catch up.
 *
 * Note: brain-server stores its OWN pid (process.pid) in the jobs table, not the
 * child process pid. After a restart, the old server pid is dead, so kill(pid, 0)
 * returns ESRCH for any job started by the previous server instance.
 */
async function recoverOrphanedJobs(): Promise<number> {
  const runningJobs = await getRunningJobs();
  let recovered = 0;

  for (const job of runningJobs) {
    if (!job.pid) continue; // no PID tracked — heartbeat monitor will handle it

    let alive = true;
    try {
      process.kill(job.pid, 0); // signal 0: test liveness without sending a signal
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') alive = false;
      // EPERM means process exists but can't be signalled — treat as alive
    }

    if (!alive) {
      const reason = `Recovered at startup: PID ${job.pid} no longer exists (orphaned by previous server restart)`;
      await markJobFailed(job.id, reason).catch(() => {});
      const updated = await failExecutingGoalActionByJobId(job.id, reason).catch(() => false);
      if (updated) recovered++;
      log('warn', 'Recovered orphaned job — dead PID', { jobId: job.id, pid: job.pid });
    }
  }

  return recovered;
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
