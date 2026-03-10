/**
 * Goal Engine — Jane's proactive action loop.
 *
 * Cycle: assess → generate candidates → score → select → execute → record
 *
 * Each cycle:
 *   1. Load all active goals
 *   2. Build context (recent job results, system status)
 *   3. Generate candidate actions via LLM
 *   4. Score candidates against the full goal set via LLM
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
import { listActiveGoals, listExecutingGoalIds, touchGoalEvaluated, createGoalAction, updateGoalAction, updateGoal, getGoal, getGoalAction, createCycle, completeCycle, failCycle, listCycles, recoverStaleGoalActions, failExecutingGoalActionByJobId, listRecentDoneActionsPerGoal, listCompletedActionsForGoal, countReviewedUnachievedActions, listGoalActions, listRecentCompletedActionsGlobal } from './registry.js';
import { generateCandidates, scoreCandidates } from './candidates.js';
import { buildReviewPrompt, parseReviewVerdict } from './reviewer.js';
import { getRunningJobs, markJobFailed } from '../jobs/registry.js';
import { launchAgent, registerSession } from '../executor/index.js';
import type { CandidateAction } from './types.js';
import type { JobResult } from '../jobs/types.js';
import { recordGoalCycleMemory } from '../memory/recorder.js';
import { getGoalContextMemories } from '../memory/retriever.js';
import { getSchedulerState, setSchedulerState } from '../layers/registry.js';
import { writeGoalActionSnapshot } from '../executor/goal-snapshots.js';

/** Max reviewed attempts before a goal is abandoned. */
const MAX_REVIEWED_ATTEMPTS = 3;

// 1 hour default
const DEFAULT_CYCLE_INTERVAL_MS = 1 * 60 * 60 * 1000;
const SCHEDULER_KEY = 'goal-engine';

const sc = StringCodec();

let cycleTimer: ReturnType<typeof setInterval> | null = null;
let isCycleRunning = false;
let cycleIntervalMs = DEFAULT_CYCLE_INTERVAL_MS;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function startGoalEngine(nats: NatsConnection): void {
  cycleIntervalMs = parseInt(process.env.GOAL_CYCLE_INTERVAL_MS ?? '', 10)
    || DEFAULT_CYCLE_INTERVAL_MS;

  // Recover goal actions stuck in transitional states from a previous server run
  recoverStaleGoalActions()
    .then((recovery) => {
      const total = recovery.needsReview.length + recovery.needsRestart.length + recovery.needsReviewerRespawn.length;
      if (total === 0) {
        log('info', 'No stale goal actions to recover');
        return;
      }
      log('warn', 'Recovering stale goal actions at startup', {
        needsReview: recovery.needsReview.length,
        needsRestart: recovery.needsRestart.length,
        needsReviewerRespawn: recovery.needsReviewerRespawn.length,
      });

      // Spawn reviewers for actions whose execution jobs finished
      for (const { actionId, goalId } of recovery.needsReview) {
        spawnReviewer(nats, actionId, goalId).catch((err) =>
          log('error', 'Failed to spawn reviewer during recovery', { actionId, error: String(err) }));
      }

      // Restart orphaned executing jobs with augmented prompt
      for (const { actionId, goalId, jobId } of recovery.needsRestart) {
        restartOrphanedJob(nats, actionId, goalId, jobId).catch((err) =>
          log('error', 'Failed to restart orphaned job during recovery', { actionId, error: String(err) }));
      }

      // Re-spawn reviewers for actions stuck in reviewing
      for (const { actionId, goalId } of recovery.needsReviewerRespawn) {
        spawnReviewer(nats, actionId, goalId).catch((err) =>
          log('error', 'Failed to re-spawn reviewer during recovery', { actionId, error: String(err) }));
      }
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
  })().catch((err) => log('error', 'Manual trigger subscription loop exited', { error: String(err) }));

  // Set up regular interval immediately, then async-check persisted state for catch-up
  cycleTimer = setInterval(() => {
    runGoalCycle(nats).catch((err) => log('error', 'Scheduled cycle error', { error: String(err) }));
  }, cycleIntervalMs);

  // Check if we're overdue or can fire sooner than the full interval
  recoverSchedule(nats, cycleIntervalMs);

  log('info', 'Goal engine started', { intervalMs: cycleIntervalMs });
}

/**
 * Checks persisted schedule state and catches up if needed.
 * - Overdue: fires an immediate catch-up run (interval already set for future runs)
 * - Not yet due but sooner than intervalMs: reschedules the interval to fire at the right time
 */
function recoverSchedule(nats: NatsConnection, intervalMs: number): void {
  getSchedulerState(SCHEDULER_KEY)
    .then((state) => {
      if (!state?.nextRunAt) return; // No prior state — interval is already correct

      const remaining = new Date(state.nextRunAt as string).getTime() - Date.now();

      if (remaining <= 0) {
        // Overdue — run immediately; the interval will handle subsequent runs
        log('info', 'Goal engine overdue — running catch-up cycle', { overdueMs: -remaining });
        runGoalCycle(nats).catch((err) => log('error', 'Catch-up cycle error', { error: String(err) }));
      } else if (remaining < intervalMs) {
        // Due sooner than the interval — reschedule to fire at the right time
        clearInterval(cycleTimer!);
        log('info', 'Goal engine rescheduling to match persisted schedule', { remainingMs: remaining });
        cycleTimer = setTimeout(() => {
          runGoalCycle(nats).catch((err) => log('error', 'Scheduled cycle error', { error: String(err) }));
          cycleTimer = setInterval(() => {
            runGoalCycle(nats).catch((err) => log('error', 'Scheduled cycle error', { error: String(err) }));
          }, intervalMs);
        }, remaining) as unknown as ReturnType<typeof setInterval>;
      }
      // remaining >= intervalMs: interval already fires at the right time — nothing to do
    })
    .catch(() => {}); // Non-critical — if DB unavailable, proceed with normal schedule
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

  // Persist schedule state so we can catch up after a restart
  const runAt = Date.now();
  setSchedulerState(SCHEDULER_KEY, {
    lastRunAt: new Date(runAt).toISOString(),
    nextRunAt: new Date(runAt + cycleIntervalMs).toISOString(),
  }).catch(() => {});

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
    const context = await buildContext(goals.map((g) => g.id));

    // 3. Generate candidates via LLM
    const candidates = await generateCandidates(goals, context);
    log('info', 'Candidates generated', { cycleId, count: candidates.length });

    if (candidates.length === 0) {
      // Still mark goals as evaluated even when LLM is unavailable
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

    // 7. Launch executor agent for the action
    const executionPrompt = buildExecutionPrompt(best, goals.find((g) => g.id === best.goalId)?.description ?? '');

    // Establish goal session hierarchy: goal has a persistent session; each action
    // gets a child session. The goal-history context module uses this to provide
    // the action agent with prior attempt history.
    const goalSessionId = best.goalId; // Use goal UUID as its stable session ID
    const actionSessionId = crypto.randomUUID();
    await registerSession(goalSessionId, undefined, { type: 'goal', goalId: goalSessionId }).catch(() => {});
    await registerSession(actionSessionId, goalSessionId, { type: 'goal-action', goalId: goalSessionId, cycleId }).catch(() => {});

    const launchResult = await launchAgent({
      role: 'executor',
      prompt: executionPrompt,
      runtime: { tool: 'claude-code', model: 'sonnet' },
      jobType: 'task',
      context: [context],
      sessionId: actionSessionId,
      // Session workspace for actions that need code isolation
      ...(best.needsWorkspace ? {
        workspace: true,
        worktrees: best.projectPaths,
      } : {}),
    });

    const jobId = launchResult.jobId;
    await updateGoalAction(actionId, { status: 'executing', jobId });

    // Subscribe to result (launchAgent dispatches async, so subscribe is still before completion)
    subscribeJobResult(nats, jobId, actionId, best.goalId).catch((err) => {
      log('error', 'Error in job result subscription', { jobId, actionId, error: String(err) });
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

async function buildContext(goalIds: string[] = []): Promise<string> {
  try {
    const now = Date.now();
    const [recent, memoryContext, recentDonePerGoal, globalRecentActions] = await Promise.all([
      listCycles(3),
      getGoalContextMemories().catch(() => '(memory unavailable)'),
      listRecentDoneActionsPerGoal(goalIds, 5).catch(() => ({})),
      listRecentCompletedActionsGlobal(18).catch(() => []),
    ]);

    const cycleContext = recent
      .filter((c) => c.status === 'done' && c.cycle_notes)
      .map((c) => `- ${new Date(c.started_at).toISOString().slice(0, 10)}: ${c.cycle_notes}`)
      .join('\n') || 'No recent cycle history';

    // Format per-goal history so each goal's recent attempts are visible
    const hasAnyHistory = Object.values(recentDonePerGoal).some((actions) => actions.length > 0);
    const recentDoneContext = hasAnyHistory
      ? Object.entries(recentDonePerGoal)
          .filter(([, actions]) => actions.length > 0)
          .map(([goalId, actions]) => {
            const lines = actions.map((a) => {
              const review = a.review_text ? ` | Review: ${a.review_text.slice(0, 150)}` : '';
              return `  - [${a.status}] ${a.description.slice(0, 120)}${review}`;
            }).join('\n');
            return `Goal ${goalId}:\n${lines}`;
          })
          .join('\n')
      : 'None';

    // Format global recent actions with hours-ago timestamps for the 24h dedup rule
    const globalRecentContext = globalRecentActions.length > 0
      ? globalRecentActions.map((a) => {
          const ageMs = now - new Date(a.completedAt).getTime();
          const ageHours = (ageMs / (1000 * 60 * 60)).toFixed(1);
          const outcome = a.outcomeText ? ` | Outcome: ${a.outcomeText.slice(0, 120)}` : '';
          return `  - [${ageHours}h ago] Goal "${a.goalTitle}": ${a.description.slice(0, 140)}${outcome}`;
        }).join('\n')
      : '  (none yet)';

    return [
      `Current time: ${new Date().toISOString()}`,
      `System: Jane's brain server (Node.js/TypeScript, PM2-managed)`,
      `Recent cycle activity:\n${cycleContext}`,
      `RECENT COMPLETED WORK — DO NOT RE-PROPOSE actions completed within the last 24 hours:\n${globalRecentContext}`,
      `Recently completed/failed actions per goal (do not repeat these — assign score 1 if duplicate):\n${recentDoneContext}`,
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
  const workspaceInstructions = action.needsWorkspace
    ? `\n## Workspace
You are running in a session workspace. Your working directory is an isolated workspace with:
- Symlinked project config (.claude, CLAUDE.md, INNER_VOICE.md, etc.)
${action.projectPaths?.length ? `- Git worktrees for: ${action.projectPaths.map(p => p.split('/').pop()).join(', ')}` : '- No git worktrees (request one if needed)'}

Work within your workspace. Commit changes to the worktree branch when done.
Do NOT modify files directly under /agent/projects/ or /agent/apps/.`
    : `\n## Workspace
You are running in /agent (shared workspace). If this action requires code changes or file isolation, you can provision a workspace mid-task:

  curl -s -X POST http://localhost:3103/api/workspaces/provision \\
    -H 'Content-Type: application/json' \\
    -d '{"sessionId":"'$SESSION_ID'","worktrees":["/agent/projects/jane-core"]}'

This creates /agent/sessions/$SESSION_ID/ with git worktrees. Then cd into it and work there.
Your SESSION_ID and JOB_ID are available as environment variables.`;

  return `You are Jane, an AI assistant working autonomously to advance your goals.

## Goal
${action.goalTitle}: ${goalDescription}

## Action to Take
${action.description}

## Rationale
${action.rationale}
${workspaceInstructions}

## Instructions
Execute this action now. Use the tools available to you:
- Read and write files
- Run bash commands for system tasks
- Update documentation and status files
- Make concrete progress, don't just plan, do

When complete, summarize what you accomplished and what changed.`;
}


/**
 * Subscribe to the result of a specific execution job.
 * On completion, transitions the action to 'reviewing' and spawns a reviewer agent.
 * The brain handles all state transitions — the executor never sets its own state.
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
      const outcomeText = result.status === 'done'
        ? (result.result ?? '').slice(0, 2000)
        : (result.error ?? 'unknown error').slice(0, 2000);

      // Store the executor's output and transition to reviewing
      await updateGoalAction(actionId, {
        outcomeText,
      });

      const progressNote = `[${new Date().toISOString().slice(0, 16)}] Job ${result.status}. ${outcomeText.slice(0, 300)}`;
      await updateGoal(goalId, { progressNotes: progressNote });

      log('info', 'Execution complete, spawning reviewer', { jobId, actionId, goalId, execStatus: result.status });

      // Spawn the reviewer regardless of done/failed — the reviewer evaluates the outcome
      await spawnReviewer(nats, actionId, goalId);
    } catch (err) {
      log('error', 'Error processing job result from NATS', { jobId, actionId, goalId, error: String(err) });
    }
  }
}

/**
 * Spawn a reviewer agent to evaluate whether the completed action achieved its goal.
 * The reviewer publishes its verdict via NATS; subscribeReviewResult handles the response.
 */
async function spawnReviewer(
  nats: NatsConnection,
  actionId: string,
  goalId: string,
): Promise<void> {
  const goal = await getGoal(goalId);
  if (!goal) {
    log('error', 'Cannot spawn reviewer — goal not found', { actionId, goalId });
    await updateGoalAction(actionId, { status: 'failed', reviewText: 'Review skipped: goal not found' });
    return;
  }

  const currentAction = await getGoalAction(actionId);
  if (!currentAction) {
    log('error', 'Cannot spawn reviewer — action not found', { actionId, goalId });
    return;
  }

  // Prior completed actions (exclude the current one)
  const allActions = await listCompletedActionsForGoal(goalId);
  const priorActions = allActions.filter((a) => a.id !== actionId);

  const reviewPrompt = buildReviewPrompt(goal, currentAction, priorActions);

  const reviewResult = await launchAgent({
    role: 'reviewer',
    prompt: reviewPrompt,
    runtime: { tool: 'claude-code', model: 'sonnet' },
    jobType: 'review',
  });

  const reviewJobId = reviewResult.jobId;
  await updateGoalAction(actionId, { status: 'reviewing', reviewJobId });

  // Subscribe to the reviewer's result (launchAgent dispatches async)
  subscribeReviewResult(nats, reviewJobId, actionId, goalId).catch((err) => {
    log('error', 'Error in review result subscription', { reviewJobId, actionId, error: String(err) });
  });

  log('info', 'Reviewer spawned', { reviewJobId, actionId, goalId });
}

/**
 * Subscribe to the reviewer's result and drive the final state transition.
 * The reviewer reports its assessment; the brain decides the action's fate.
 */
async function subscribeReviewResult(
  nats: NatsConnection,
  reviewJobId: string,
  actionId: string,
  goalId: string,
): Promise<void> {
  const sub = nats.subscribe(`agent.results.${reviewJobId}`, { max: 1 });

  for await (const msg of sub) {
    try {
      const result: JobResult = JSON.parse(sc.decode(msg.data));

      if (result.status !== 'done' || !result.result) {
        // Reviewer process failed — re-spawn it, don't give up
        log('warn', 'Reviewer job failed, re-spawning', { reviewJobId, actionId, goalId, error: result.error?.slice(0, 200) });
        await spawnReviewer(nats, actionId, goalId);
        return;
      }

      const verdict = parseReviewVerdict(result.result);
      const reviewText = `${verdict.assessment}${verdict.recommendation ? `\nRecommendation: ${verdict.recommendation}` : ''}`;

      const [goal, currentAction] = await Promise.all([getGoal(goalId), getGoalAction(actionId)]);
      const isAsymptotic = goal?.level === 'asymptotic';

      if (verdict.achieved && !isAsymptotic) {
        // Goal achieved — mark action done and goal achieved
        await updateGoalAction(actionId, { status: 'done', reviewText: reviewText.slice(0, 2000) });
        await updateGoal(goalId, { status: 'achieved' });
        log('info', 'Goal achieved via review', { actionId, goalId, goalTitle: goal?.title });

        // Notify Chris
        notifyChris(nats, `Goal achieved: ${goal?.title ?? goalId}\n\n${verdict.assessment.slice(0, 500)}`);
      } else {
        // Not achieved — mark action done with review context
        await updateGoalAction(actionId, { status: 'done', reviewText: reviewText.slice(0, 2000) });

        // Check abandonment threshold
        const reviewedCount = await countReviewedUnachievedActions(goalId);
        if (!isAsymptotic && reviewedCount >= MAX_REVIEWED_ATTEMPTS) {
          await updateGoal(goalId, { status: 'abandoned' });
          log('warn', 'Goal abandoned after max review attempts', { goalId, goalTitle: goal?.title, reviewedCount });
          notifyChris(nats, `Goal abandoned after ${reviewedCount} attempts: ${goal?.title ?? goalId}\n\nLast review: ${verdict.assessment.slice(0, 500)}`);
        } else {
          log('info', 'Action reviewed — goal not yet achieved', { actionId, goalId, reviewedCount });
        }
      }

      // Write a context.summaries snapshot for the goal session.
      // This allows the parent-session module to surface this action's outcome
      // to any sub-agents spawned as children of the goal's session.
      if (currentAction) {
        writeGoalActionSnapshot({
          goalSessionId: goalId,  // goal UUID is the goal session ID
          description: currentAction.description,
          outcomeText: currentAction.outcome_text,
          reviewText: reviewText.slice(0, 800),
          startedAt: currentAction.created_at,
          completedAt: new Date(),
          status: 'done',
        }).catch((err) => log('warn', 'Failed to write goal action snapshot', { actionId, goalId, error: String(err) }));
      }
    } catch (err) {
      log('error', 'Error processing review result', { reviewJobId, actionId, goalId, error: String(err) });
    }
  }
}

/**
 * Send a notification to Chris via NATS outbound subject.
 * Publishes a CommunicationEvent to `communication.outbound.jane` — picked up by
 * the stimulation server's composer for voice-consistent delivery to Slack.
 */
function notifyChris(nats: NatsConnection, message: string): void {
  try {
    const event = {
      v: 2,
      id: crypto.randomUUID(),
      sessionId: 'brain-server',
      channelType: 'realtime',
      direction: 'outbound',
      contentType: 'markdown',
      content: message,
      sender: { id: 'jane-brain', displayName: 'Jane (Brain)', type: 'agent' },
      metadata: {},
      timestamp: new Date().toISOString(),
    };
    nats.publish('communication.outbound.jane', sc.encode(JSON.stringify(event)));
  } catch (err) {
    log('warn', 'Failed to notify Chris via NATS', { error: String(err) });
  }
}

/**
 * Restart an orphaned executing job with an augmented prompt that tells the agent
 * to evaluate the current state of the work and continue if needed.
 */
async function restartOrphanedJob(
  nats: NatsConnection,
  actionId: string,
  goalId: string,
  oldJobId: string,
): Promise<void> {
  const goal = await getGoal(goalId);
  if (!goal) {
    log('error', 'Cannot restart orphaned job — goal not found', { actionId, goalId });
    return;
  }

  const action = await getGoalAction(actionId);
  if (!action) {
    log('error', 'Cannot restart orphaned job — action not found', { actionId, goalId });
    return;
  }

  // Mark the old job as failed
  await markJobFailed(oldJobId, 'Orphaned job — process died, restarting with context').catch(() => {});

  const restartPrompt = `You are Jane, an AI assistant working autonomously to advance your goals.

## IMPORTANT: This is a RESTARTED task
This task was previously started but the process died before completing. Evaluate the current state of the work described below. If it's already complete, summarize what was accomplished. If it's partially done, continue from where it left off. If it hasn't started, begin from scratch.

## Goal
${goal.title}: ${goal.description}

## Action to Take
${action.description}

## Rationale
${action.rationale ?? 'none provided'}

## Instructions
Evaluate the current state, then execute or continue as needed. Use the tools available to you:
- Read and write files in /agent/
- Run bash commands for system tasks
- Update documentation and status files
- Make concrete progress — don't just plan, do

When complete, summarize what you accomplished and what changed.`;

  // Register a new child session for the restart, inheriting from the goal's session
  const restartSessionId = crypto.randomUUID();
  await registerSession(goalId, undefined, { type: 'goal', goalId }).catch(() => {});
  await registerSession(restartSessionId, goalId, { type: 'goal-action-restart', goalId }).catch(() => {});

  const restartResult = await launchAgent({
    role: 'executor',
    prompt: restartPrompt,
    runtime: { tool: 'claude-code', model: 'sonnet' },
    jobType: 'task',
    sessionId: restartSessionId,
  });

  const newJobId = restartResult.jobId;
  await updateGoalAction(actionId, { jobId: newJobId });

  // Subscribe to result (launchAgent dispatches async)
  subscribeJobResult(nats, newJobId, actionId, goalId).catch((err) => {
    log('error', 'Error in restarted job result subscription', { newJobId, actionId, error: String(err) });
  });

  log('info', 'Orphaned job restarted with augmented prompt', { oldJobId, newJobId, actionId, goalId });
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
