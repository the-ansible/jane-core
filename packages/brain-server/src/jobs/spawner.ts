/**
 * Agent Spawner — launches claude CLI subprocesses and tracks their lifecycle.
 *
 * Design principles:
 * - No timeouts — Claude Code can legitimately run for hours
 * - Heartbeat via stdout/stderr activity, not external pings
 * - Sub-agents are handled natively by Claude Code; we don't manage them
 * - Results published to NATS on completion
 */

import { type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { NatsConnection } from 'nats';
import { StringCodec } from 'nats';
import { launchClaude } from '@jane-core/claude-launcher';
import {
  markJobRunning,
  markJobDone,
  markJobFailed,
  updateHeartbeat,
} from './registry.js';
import { createScratchDir, createWorktree, removeWorktree, cleanupScratchDir } from './worktree.js';
import type { JobRequest, JobResult } from './types.js';

const OUTPUT_BASE = '/tmp/brain-output';
const DEFAULT_WORKDIR = '/agent';

const sc = StringCodec();

interface RunningJob {
  proc: ChildProcess;
  startedAt: number;
  lastActivityAt: number;
  jobId: string;
}

/** Map of jobId → running process info */
const runningJobs = new Map<string, RunningJob>();

export function getRunningJobCount(): number {
  return runningJobs.size;
}

export function getRunningJobIds(): string[] {
  return Array.from(runningJobs.keys());
}

/**
 * Spawn a claude CLI agent for the given job.
 * Returns immediately — completion is async via NATS.
 */
export async function spawnAgent(params: {
  jobId: string;
  request: JobRequest;
  nats: NatsConnection;
}): Promise<void> {
  const { jobId, request, nats } = params;

  mkdirSync(OUTPUT_BASE, { recursive: true });
  const outputFile = join(OUTPUT_BASE, `${jobId}.txt`);

  // Resolve working directory
  let workdir = request.workdir ?? DEFAULT_WORKDIR;
  let worktreePath: string | undefined;
  let scratchDir: string | undefined;

  if (request.projectPath) {
    // Same-project work — use git worktree for isolation
    try {
      worktreePath = await createWorktree(jobId, request.projectPath);
      workdir = worktreePath;
    } catch (err) {
      log('warn', 'Worktree creation failed, falling back to scratch dir', { jobId, error: String(err) });
      scratchDir = createScratchDir(jobId);
      workdir = scratchDir;
    }
  } else if (request.type === 'research') {
    // Research jobs get scratch dir for writes but workdir stays at project location
    scratchDir = createScratchDir(jobId);
  }

  const additionalEnv: Record<string, string> = {
    JOB_ID: jobId,
    NATS_URL: process.env.NATS_URL || 'nats://life-system-nats:4222',
  };
  if (scratchDir) additionalEnv.SCRATCH_DIR = scratchDir;

  const startedAt = Date.now();
  let stdoutLen = 0;
  let stderr = '';

  // We need a fake proc-like object for the running jobs map
  // The launcher doesn't expose the child process, so we track activity via callbacks
  const running: RunningJob = {
    proc: null as unknown as ChildProcess, // filled below if needed for kill
    startedAt,
    lastActivityAt: startedAt,
    jobId,
  };
  runningJobs.set(jobId, running);

  await markJobRunning(jobId, process.pid, {
    worktreePath,
    scratchDir,
    outputFile,
  });

  log('info', 'Spawned agent', { jobId, workdir, type: request.type });

  // Use the shared launcher — no timeout (brain server design principle)
  const launchResult = await launchClaude({
    prompt: request.prompt,
    cwd: workdir,
    timeout: 0,
    additionalEnv,
    onStdout: (chunk) => {
      stdoutLen += chunk.length;
      running.lastActivityAt = Date.now();
      updateHeartbeat(jobId).catch(() => {});

      nats.publish(`agent.jobs.heartbeat.${jobId}`, sc.encode(JSON.stringify({
        jobId,
        ts: new Date().toISOString(),
        bytesReceived: stdoutLen,
      })));
    },
    onStderr: (chunk) => {
      stderr += chunk;
      running.lastActivityAt = Date.now();
    },
  });

  runningJobs.delete(jobId);
  const durationMs = Date.now() - startedAt;

  // Cleanup isolation artifacts
  if (worktreePath && request.projectPath) {
    await removeWorktree(jobId, request.projectPath).catch(() => {});
  }
  if (scratchDir) {
    cleanupScratchDir(jobId);
  }

  if (launchResult.exitCode !== 0 || launchResult.signal) {
    const error = launchResult.signal
      ? `Killed by signal ${launchResult.signal}`
      : `Exited with code ${launchResult.exitCode}. stderr: ${stderr.slice(0, 500)}`;

    await markJobFailed(jobId, error).catch(() => {});

    const result: JobResult = { jobId, clientId: request.clientId, status: 'failed', error, durationMs };
    publishResult(nats, request.replySubject, jobId, result);

    log('error', 'Agent exited with error', { jobId, exitCode: launchResult.exitCode, signal: launchResult.signal, durationMs });
    return;
  }

  // Extract result text from Claude CLI JSON output (launcher already parsed it)
  const resultText = launchResult.resultText ?? launchResult.stdout.trim();

  await markJobDone(jobId, resultText).catch(() => {});

  const result: JobResult = { jobId, clientId: request.clientId, status: 'done', result: resultText, durationMs };
  publishResult(nats, request.replySubject, jobId, result);

  log('info', 'Agent completed', { jobId, durationMs, resultLength: resultText.length });
}

/** Kill a running job by PID */
export function killJobProcess(jobId: string): boolean {
  const running = runningJobs.get(jobId);
  if (!running) return false;

  try {
    running.proc.kill('SIGTERM');
    // Give it 5s to exit gracefully, then SIGKILL
    setTimeout(() => {
      if (runningJobs.has(jobId)) {
        running.proc.kill('SIGKILL');
      }
    }, 5000);
    return true;
  } catch {
    return false;
  }
}

/** Get last activity time for a running job (for heartbeat monitor) */
export function getLastActivity(jobId: string): number | null {
  return runningJobs.get(jobId)?.lastActivityAt ?? null;
}

function publishResult(nats: NatsConnection, replySubject: string | undefined, jobId: string, result: JobResult): void {
  const payload = sc.encode(JSON.stringify(result));

  // Always publish to the canonical results subject
  nats.publish(`agent.results.${jobId}`, payload);

  // Also publish to pipeline feedback subject for stimulation server integration
  nats.publish(`communication.agent-results.${jobId}`, payload);

  // If a specific reply subject was requested, publish there too
  if (replySubject) {
    nats.publish(replySubject, payload);
  }
}


function log(level: string, msg: string, extra?: Record<string, unknown>): void {
  console.log(JSON.stringify({ level, msg, component: 'brain-spawner', ts: new Date().toISOString(), ...extra }));
}
