/**
 * Agent Spawner — launches claude CLI subprocesses and tracks their lifecycle.
 *
 * Design principles:
 * - No timeouts — Claude Code can legitimately run for hours
 * - Heartbeat via stdout/stderr activity, not external pings
 * - Sub-agents are handled natively by Claude Code; we don't manage them
 * - Results published to NATS on completion
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { NatsConnection } from 'nats';
import { StringCodec } from 'nats';
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

  const env: Record<string, string | undefined> = {
    ...stripClaudeCodeEnv(),
    SCRATCH_DIR: scratchDir,
    JOB_ID: jobId,
    NATS_URL: process.env.NATS_URL || 'nats://life-system-nats:4222',
  };
  if (scratchDir) env.SCRATCH_DIR = scratchDir;

  const proc = spawn('claude', [
    '--print',
    '--dangerously-skip-permissions',
    '--output-format', 'json',
    '--model', 'sonnet',
    '-p', '-',
  ], {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: workdir,
    env,
    // No timeout — heartbeat monitor handles unresponsive detection
  });

  const pid = proc.pid!;
  const startedAt = Date.now();

  await markJobRunning(jobId, pid, {
    worktreePath,
    scratchDir,
    outputFile,
  });

  const running: RunningJob = {
    proc,
    startedAt,
    lastActivityAt: startedAt,
    jobId,
  };
  runningJobs.set(jobId, running);

  log('info', 'Spawned agent', { jobId, pid, workdir, type: request.type });

  let stdout = '';
  let stderr = '';

  proc.stdin!.write(request.prompt);
  proc.stdin!.end();

  proc.stdout!.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
    running.lastActivityAt = Date.now();
    updateHeartbeat(jobId).catch(() => {});

    // Publish heartbeat to NATS
    nats.publish(`agent.jobs.heartbeat.${jobId}`, sc.encode(JSON.stringify({
      jobId,
      ts: new Date().toISOString(),
      bytesReceived: stdout.length,
    })));
  });

  proc.stderr!.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
    running.lastActivityAt = Date.now();
    // stderr counts as activity (tool use, progress, etc.)
  });

  proc.on('close', async (code, signal) => {
    runningJobs.delete(jobId);
    const durationMs = Date.now() - startedAt;

    // Cleanup isolation artifacts
    if (worktreePath && request.projectPath) {
      await removeWorktree(jobId, request.projectPath).catch(() => {});
    }
    if (scratchDir) {
      cleanupScratchDir(jobId);
    }

    if (code !== 0 || signal) {
      const error = signal
        ? `Killed by signal ${signal}`
        : `Exited with code ${code}. stderr: ${stderr.slice(0, 500)}`;

      await markJobFailed(jobId, error).catch(() => {});

      const result: JobResult = { jobId, clientId: request.clientId, status: 'failed', error, durationMs };
      publishResult(nats, request.replySubject, jobId, result);

      log('error', 'Agent exited with error', { jobId, code, signal, durationMs });
      return;
    }

    // Extract result text from Claude CLI JSON output
    const resultText = extractResult(stdout) ?? stdout.trim();

    await markJobDone(jobId, resultText).catch(() => {});

    const result: JobResult = { jobId, clientId: request.clientId, status: 'done', result: resultText, durationMs };
    publishResult(nats, request.replySubject, jobId, result);

    log('info', 'Agent completed', { jobId, durationMs, resultLength: resultText.length });
  });

  proc.on('error', async (err) => {
    runningJobs.delete(jobId);
    const durationMs = Date.now() - startedAt;

    await markJobFailed(jobId, String(err)).catch(() => {});

    const result: JobResult = { jobId, clientId: request.clientId, status: 'failed', error: String(err), durationMs };
    publishResult(nats, request.replySubject, jobId, result);

    log('error', 'Agent spawn error', { jobId, error: String(err) });
  });
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

/** Extract the result text from Claude CLI JSON output */
function extractResult(stdout: string): string | null {
  try {
    const parsed = JSON.parse(stdout);

    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      if (parsed.type === 'result' && parsed.result) return String(parsed.result);
    }

    if (Array.isArray(parsed)) {
      for (const msg of parsed) {
        if (msg.type === 'result' && msg.result) return String(msg.result);
      }
      // Fall back to assistant text blocks
      for (const msg of parsed) {
        if (msg.type === 'assistant' && msg.message?.content) {
          const text = Array.isArray(msg.message.content)
            ? msg.message.content
                .filter((b: { type: string }) => b.type === 'text')
                .map((b: { text: string }) => b.text)
                .join('\n')
            : typeof msg.message.content === 'string'
              ? msg.message.content
              : null;
          if (text) return text;
        }
      }
    }
  } catch {
    // Not JSON — return null to use raw stdout
  }
  return null;
}

function stripClaudeCodeEnv(): Record<string, string | undefined> {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  return env;
}

function log(level: string, msg: string, extra?: Record<string, unknown>): void {
  console.log(JSON.stringify({ level, msg, component: 'brain-spawner', ts: new Date().toISOString(), ...extra }));
}
