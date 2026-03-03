/**
 * Agent Job Recovery — Bootstrap logic for recovering in-flight jobs after restart.
 * Runs at server startup before accepting new messages.
 */

import { statSync, readFileSync } from 'node:fs';
import {
  getStaleJobs,
  markJobDeadLetter,
  requeueJob,
  type AgentJob,
} from './job-registry.js';
import type { PipelineDeps } from '../pipeline.js';
import { processPipeline } from '../pipeline.js';
import { startRun, beginStage } from '../pipeline-runs.js';

const MAX_RETRIES = 3;
const HEARTBEAT_STALE_MS = 5 * 60 * 1000; // 5 minutes

// --- Recovery report pub/sub ---

export interface RecoveryJobEntry {
  jobId: string;
  sessionId: string;
  decision: JobDecision;
  pid?: number | null;
}

export interface RecoveryReport {
  checkedAt: string;
  totalStale: number;
  alive: RecoveryJobEntry[];
  requeued: RecoveryJobEntry[];
  deadLettered: RecoveryJobEntry[];
}

let lastRecovery: RecoveryReport | null = null;
const recoveryListeners = new Set<(report: RecoveryReport) => void>();

export function getLastRecovery(): RecoveryReport | null {
  return lastRecovery;
}

export function onRecovery(callback: (report: RecoveryReport) => void): () => void {
  recoveryListeners.add(callback);
  return () => { recoveryListeners.delete(callback); };
}

function emitRecovery(report: RecoveryReport): void {
  lastRecovery = report;
  for (const listener of recoveryListeners) {
    try { listener(report); } catch { /* ignore */ }
  }
}

// --- Recovery logic ---

function isPidAlive(pid: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    // process.kill(pid, 0) succeeds for zombie (defunct) processes too — they're
    // still in the process table but won't do any work. Check /proc/<pid>/status
    // for state 'Z' to treat zombies as dead.
    const status = readFileSync(`/proc/${pid}/status`, 'utf8');
    const stateMatch = status.match(/^State:\s+(\w)/m);
    if (stateMatch?.[1] === 'Z') return false;
    return true;
  } catch {
    return false;
  }
}

function hasOutputFile(job: AgentJob): boolean {
  if (!job.output_file) return false;
  try {
    const stat = statSync(job.output_file);
    return stat.size > 0;
  } catch {
    return false;
  }
}

function isHeartbeatStale(job: AgentJob): boolean {
  if (!job.last_heartbeat_at) return true;
  return Date.now() - new Date(job.last_heartbeat_at).getTime() > HEARTBEAT_STALE_MS;
}

type JobDecision = 'alive' | 'agent_done' | 'requeue' | 'dead_letter';

function assessJob(job: AgentJob): JobDecision {
  // Wrapper PID still alive — it'll finish and publish the NATS event
  if (isPidAlive(job.pid)) return 'alive';

  // Heartbeat has gone stale and no output file — crashed without completing
  if (isHeartbeatStale(job) && !hasOutputFile(job)) {
    return job.retry_count >= MAX_RETRIES ? 'dead_letter' : 'requeue';
  }

  // Agent finished (wrapper marked agent_done, or output file exists) but
  // compose/publish didn't happen — recover by re-running the full pipeline
  if (job.status === 'agent_done' || hasOutputFile(job)) return 'agent_done';

  return job.retry_count >= MAX_RETRIES ? 'dead_letter' : 'requeue';
}

export async function recoverInFlightJobs(deps: PipelineDeps): Promise<void> {
  let stale: AgentJob[];
  try {
    stale = await getStaleJobs();
  } catch (err) {
    console.log(JSON.stringify({
      level: 'error',
      msg: 'Bootstrap: failed to query stale jobs',
      component: 'recovery',
      error: String(err),
      ts: new Date().toISOString(),
    }));
    return;
  }

  const checkedAt = new Date().toISOString();

  if (stale.length === 0) {
    emitRecovery({ checkedAt, totalStale: 0, alive: [], requeued: [], deadLettered: [] });
    return;
  }

  console.log(JSON.stringify({
    level: 'info',
    msg: `Bootstrap: found ${stale.length} stale job(s) to assess`,
    component: 'recovery',
    ts: checkedAt,
  }));

  const report: RecoveryReport = {
    checkedAt,
    totalStale: stale.length,
    alive: [],
    requeued: [],
    deadLettered: [],
  };

  for (const job of stale) {
    const decision = assessJob(job);
    const entry: RecoveryJobEntry = { jobId: job.id, sessionId: job.session_id, decision, pid: job.pid };

    console.log(JSON.stringify({
      level: 'info',
      msg: 'Bootstrap job assessment',
      component: 'recovery',
      jobId: job.id,
      sessionId: job.session_id,
      status: job.status,
      retryCount: job.retry_count,
      decision,
      ts: new Date().toISOString(),
    }));

    switch (decision) {
      case 'alive': {
        // Wrapper still running — it'll publish NATS event when done.
        // Create a pipeline run now so the dashboard shows it as active.
        // Use the original event ID as runId (matching the persisted run) so the
        // active attached run replaces the interrupted failure in the dashboard.
        console.log(JSON.stringify({
          level: 'info',
          msg: 'Job wrapper still alive — attaching pipeline run for dashboard visibility',
          component: 'recovery',
          jobId: job.id,
          pid: job.pid,
          ts: new Date().toISOString(),
        }));
        const ctx = job.context_json as { event?: any; classification?: any };
        const evt = ctx?.event;
        const runId = evt?.id || job.id;
        startRun({
          runId,
          sessionId: job.session_id,
          channelType: evt?.channelType || 'realtime',
          senderName: evt?.sender?.displayName || evt?.sender?.id || 'User',
          contentPreview: (evt?.content || job.command || '').slice(0, 120),
          classification: ctx?.classification?.routing,
          attachedJobId: job.id,
          startedAt: new Date(job.created_at).toISOString(),
        });
        beginStage(runId, 'agent', 'attached — wrapper still running');
        report.alive.push(entry);
        break;
      }

      case 'agent_done':
        // Agent completed but server died before compose/publish.
        // Mark as failed rather than re-dispatching — re-dispatching the same event
        // through processPipeline creates duplicate jobs and resubmission loops.
        // With the ack-after-pipeline fix, NATS will redeliver unacked messages
        // naturally on restart, so manual recovery dispatch is no longer needed.
        await markJobDeadLetter(job.id, 'agent_done but compose/publish incomplete — not re-dispatching to prevent loops');
        report.deadLettered.push(entry);
        console.log(JSON.stringify({
          level: 'warn',
          msg: 'Recovery: agent_done job dead-lettered (no re-dispatch)',
          component: 'recovery',
          jobId: job.id,
          sessionId: job.session_id,
          ts: new Date().toISOString(),
        }));
        break;

      case 'requeue':
        // Same rationale — don't re-dispatch. With ack-after-pipeline, the original
        // NATS message will be redelivered if it was never fully processed.
        await markJobDeadLetter(job.id, 'stale job — not re-dispatching to prevent loops');
        report.deadLettered.push(entry);
        console.log(JSON.stringify({
          level: 'warn',
          msg: 'Recovery: stale job dead-lettered (no re-dispatch)',
          component: 'recovery',
          jobId: job.id,
          sessionId: job.session_id,
          ts: new Date().toISOString(),
        }));
        break;

      case 'dead_letter':
        await markJobDeadLetter(job.id, 'exceeded retry limit on startup');
        report.deadLettered.push(entry);
        break;
    }
  }

  emitRecovery(report);
}

function dispatchRecovery(job: AgentJob, deps: PipelineDeps): void {
  const ctx = job.context_json as { event?: any; classification?: any };

  if (!ctx?.event || !ctx?.classification) {
    console.log(JSON.stringify({
      level: 'warn',
      msg: 'Recovery: missing context_json — cannot requeue',
      component: 'recovery',
      jobId: job.id,
      ts: new Date().toISOString(),
    }));
    return;
  }

  setImmediate(() => {
    processPipeline(ctx.event, ctx.classification, deps, { recoveredJobId: job.id }).catch((err) => {
      console.log(JSON.stringify({
        level: 'error',
        msg: 'Recovery pipeline dispatch failed',
        component: 'recovery',
        jobId: job.id,
        error: String(err),
        ts: new Date().toISOString(),
      }));
    });
  });
}
