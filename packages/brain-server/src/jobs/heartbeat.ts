/**
 * Heartbeat monitor — watches running jobs for signs of life.
 *
 * Policy: never auto-kill. If a job goes quiet, flag it as 'unresponsive'
 * and publish an alert. Human review required to kill.
 *
 * Activity is tracked via stdout/stderr from the spawned process.
 * Claude Code often goes quiet while thinking — the window is generous.
 */

import type { NatsConnection } from 'nats';
import { StringCodec } from 'nats';
import { getRunningJobs, markJobUnresponsive } from './registry.js';
import { getLastActivity } from '../executor/index.js';
import { failExecutingGoalActionByJobId } from '../goals/registry.js';
import { getSchedulerState, setSchedulerState } from '../layers/registry.js';
import type { JobAlert } from './types.js';

const POLL_INTERVAL_MS = 30_000;           // check every 30s
const UNRESPONSIVE_THRESHOLD_MS = 30 * 60 * 1000; // 30 min without activity → flag
const SCHEDULER_KEY = 'job-heartbeat';

const sc = StringCodec();
let intervalHandle: NodeJS.Timeout | null = null;

export function startHeartbeatMonitor(nats: NatsConnection): void {
  if (intervalHandle) return;

  intervalHandle = setInterval(async () => {
    await checkRunningJobs(nats);
  }, POLL_INTERVAL_MS);

  // Async: check persisted state and catch up if overdue
  recoverSchedule(nats, POLL_INTERVAL_MS);

  log('info', 'Heartbeat monitor started', { pollIntervalMs: POLL_INTERVAL_MS, thresholdMs: UNRESPONSIVE_THRESHOLD_MS });
}

function recoverSchedule(nats: NatsConnection, intervalMs: number): void {
  getSchedulerState(SCHEDULER_KEY)
    .then((state) => {
      if (!state?.nextRunAt) return;

      const remaining = new Date(state.nextRunAt as string).getTime() - Date.now();

      if (remaining <= 0) {
        // Overdue — run an immediate catch-up check; interval handles subsequent runs
        log('info', 'Heartbeat monitor overdue — running catch-up check', { overdueMs: -remaining });
        checkRunningJobs(nats).catch(() => {});
      } else if (remaining < intervalMs) {
        // Due sooner than full interval — reschedule
        clearInterval(intervalHandle!);
        log('info', 'Heartbeat monitor rescheduling to match persisted schedule', { remainingMs: remaining });
        intervalHandle = setTimeout(() => {
          checkRunningJobs(nats).catch(() => {});
          intervalHandle = setInterval(async () => {
            await checkRunningJobs(nats);
          }, intervalMs);
        }, remaining) as unknown as NodeJS.Timeout;
      }
    })
    .catch(() => {}); // Non-critical
}

export function stopHeartbeatMonitor(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    log('info', 'Heartbeat monitor stopped');
  }
}

async function checkRunningJobs(nats: NatsConnection): Promise<void> {
  setSchedulerState(SCHEDULER_KEY, {
    lastRunAt: new Date().toISOString(),
    nextRunAt: new Date(Date.now() + POLL_INTERVAL_MS).toISOString(),
  }).catch(() => {});

  let jobs: Awaited<ReturnType<typeof getRunningJobs>>;
  try {
    jobs = await getRunningJobs();
  } catch (err) {
    log('warn', 'Failed to query running jobs', { error: String(err) });
    return;
  }

  if (jobs.length === 0) return;

  const now = Date.now();

  for (const job of jobs) {
    // Check in-process activity first (most accurate)
    const inProcessLastActivity = getLastActivity(job.id);
    const lastActivity = inProcessLastActivity
      ? new Date(inProcessLastActivity)
      : (job.last_activity_at ?? job.started_at ?? job.created_at);

    const silentMs = now - new Date(lastActivity).getTime();

    if (silentMs > UNRESPONSIVE_THRESHOLD_MS) {
      log('warn', 'Job appears unresponsive', {
        jobId: job.id,
        silentMs,
        pid: job.pid,
        lastActivityAt: lastActivity,
      });

      // Mark in DB
      await markJobUnresponsive(job.id).catch(() => {});

      // Fail any linked goal_action so the goal cycle can proceed
      failExecutingGoalActionByJobId(
        job.id,
        `Job marked unresponsive after ${Math.round(silentMs / 60000)} minutes without activity. PID ${job.pid ?? 'unknown'}.`
      ).then((updated) => {
        if (updated) log('info', 'Cleared stale executing goal_action for unresponsive job', { jobId: job.id });
      }).catch(() => {});

      // Publish alert
      const alert: JobAlert = {
        jobId: job.id,
        alertType: 'unresponsive',
        message: `No activity for ${Math.round(silentMs / 60000)} minutes. PID ${job.pid ?? 'unknown'}. Manual review required.`,
        lastActivityAt: lastActivity ? new Date(lastActivity).toISOString() : null,
        pid: job.pid,
      };

      nats.publish(`agent.jobs.alert.${job.id}`, sc.encode(JSON.stringify(alert)));
      log('info', 'Published unresponsive alert', { jobId: job.id });
    }
  }
}

function log(level: string, msg: string, extra?: Record<string, unknown>): void {
  console.log(JSON.stringify({ level, msg, component: 'brain-heartbeat', ts: new Date().toISOString(), ...extra }));
}
