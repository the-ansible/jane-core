/**
 * Claude Code runtime adapter — spawns Claude CLI subprocess.
 *
 * This is the primary adapter for tasks requiring tool use (file editing, bash, git).
 * Wraps @jane-core/claude-launcher with job lifecycle management.
 */

import { type ChildProcess } from 'node:child_process';
import { mkdirSync, createWriteStream, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WriteStream } from 'node:fs';
import { StringCodec } from 'nats';
import { launchClaude } from '@jane-core/claude-launcher';
import type { RuntimeAdapter, AdapterExecuteParams, AdapterResult } from '../types.js';

const OUTPUT_BASE = '/agent/command/results';
const sc = StringCodec();

interface RunningProcess {
  proc: ChildProcess;
  startedAt: number;
  lastActivityAt: number;
  jobId: string;
}

/** Tracks running Claude Code processes for kill support */
const runningProcesses = new Map<string, RunningProcess>();

export function getRunningProcessCount(): number {
  return runningProcesses.size;
}

export function getRunningProcessIds(): string[] {
  return Array.from(runningProcesses.keys());
}

export function killProcess(jobId: string): boolean {
  const running = runningProcesses.get(jobId);
  if (!running) return false;

  try {
    running.proc.kill('SIGTERM');
    setTimeout(() => {
      if (runningProcesses.has(jobId)) {
        running.proc.kill('SIGKILL');
      }
    }, 5000);
    return true;
  } catch {
    return false;
  }
}

export function getLastActivity(jobId: string): number | null {
  return runningProcesses.get(jobId)?.lastActivityAt ?? null;
}

const claudeCodeAdapter: RuntimeAdapter = {
  name: 'claude-code',

  async execute(params: AdapterExecuteParams): Promise<AdapterResult> {
    const { prompt, runtime, jobId, workdir, env: additionalEnv, onActivity, nats } = params;

    // Set up output logging
    const jobResultDir = join(OUTPUT_BASE, jobId);
    mkdirSync(jobResultDir, { recursive: true });
    const outputFile = join(jobResultDir, 'output.log');
    const metaFile = join(jobResultDir, 'meta.json');
    const logStream: WriteStream = createWriteStream(outputFile, { flags: 'a' });

    const startedAt = Date.now();
    let stdoutLen = 0;
    let stderrBuf = '';

    // Track the running process
    const running: RunningProcess = {
      proc: null as unknown as ChildProcess,
      startedAt,
      lastActivityAt: startedAt,
      jobId,
    };
    runningProcesses.set(jobId, running);

    const envVars: Record<string, string> = {
      JOB_ID: jobId,
      NATS_URL: process.env.NATS_URL || 'nats://life-system-nats:4222',
      ...additionalEnv,
    };

    log('info', 'Spawning Claude Code', { jobId, workdir, model: runtime.model });

    const launchResult = await launchClaude({
      prompt,
      model: runtime.model,
      cwd: workdir,
      timeout: 0, // No timeout (brain server design principle)
      maxTurns: runtime.maxTurns,
      additionalEnv: envVars,
      onStdout: (chunk) => {
        stdoutLen += chunk.length;
        running.lastActivityAt = Date.now();
        logStream.write(chunk);
        onActivity?.(chunk);

        if (nats) {
          nats.publish(`agent.jobs.heartbeat.${jobId}`, sc.encode(JSON.stringify({
            jobId,
            ts: new Date().toISOString(),
            bytesReceived: stdoutLen,
          })));
        }
      },
      onStderr: (chunk) => {
        stderrBuf += chunk;
        running.lastActivityAt = Date.now();
        logStream.write(`[STDERR] ${chunk}`);
      },
    });

    logStream.end();
    runningProcesses.delete(jobId);

    const durationMs = Date.now() - startedAt;

    if (launchResult.exitCode !== 0 || launchResult.signal) {
      const error = launchResult.signal
        ? `Killed by signal ${launchResult.signal}`
        : `Exited with code ${launchResult.exitCode}. stderr: ${stderrBuf.slice(0, 500)}`;

      writeMeta(metaFile, { jobId, startedAt, durationMs, status: 'failed', exitCode: launchResult.exitCode ?? -1 });

      return {
        success: false,
        resultText: null,
        rawOutput: launchResult.stdout,
        durationMs,
        error,
      };
    }

    const resultText = launchResult.resultText ?? launchResult.stdout.trim();
    writeMeta(metaFile, { jobId, startedAt, durationMs, status: 'done', exitCode: 0 });

    return {
      success: true,
      resultText,
      rawOutput: launchResult.stdout,
      durationMs,
    };
  },
};

export default claudeCodeAdapter;

function writeMeta(
  metaFile: string,
  data: { jobId: string; startedAt: number; durationMs: number; status: string; exitCode: number },
): void {
  try {
    writeFileSync(metaFile, JSON.stringify({
      ...data,
      startTime: new Date(data.startedAt).toISOString(),
    }, null, 2));
  } catch (err) {
    log('warn', 'Failed to write meta.json', { metaFile, error: String(err) });
  }
}

function log(level: string, msg: string, extra?: Record<string, unknown>): void {
  console.log(JSON.stringify({ level, msg, component: 'executor.claude-code', ts: new Date().toISOString(), ...extra }));
}
