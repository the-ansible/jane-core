/**
 * Pipeline Run Store -- JSONL persistence for pipeline runs.
 * Allows the dashboard to show runs across server restarts.
 */

import { readFileSync, appendFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { PipelineRun } from './pipeline-runs.js';

const MAX_PERSISTED = 500;

function getDir(): string {
  return process.env.SESSIONS_DIR || '/agent/data/sessions';
}

function getPath(): string {
  return join(getDir(), 'comm-pipeline-runs.jsonl');
}

function ensureDir(): void {
  const dir = getDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Persist a run snapshot to disk (append, last-write-wins per runId).
 */
export function persistRun(run: PipelineRun): void {
  try {
    ensureDir();
    appendFileSync(getPath(), JSON.stringify(run) + '\n', 'utf8');
  } catch (err) {
    console.log(JSON.stringify({
      level: 'warn',
      msg: 'Failed to persist pipeline run',
      runId: run.runId,
      error: String(err),
      ts: new Date().toISOString(),
    }));
  }
}

/**
 * Load persisted pipeline runs from disk.
 * Deduplicates by runId (last entry wins).
 * Runs still in "running" state are marked as "failure" (server restarted).
 */
export function loadPersistedRuns(): PipelineRun[] {
  const path = getPath();
  if (!existsSync(path)) return [];

  try {
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
    const byId = new Map<string, PipelineRun>();

    for (const line of lines) {
      try {
        const run = JSON.parse(line) as PipelineRun;
        byId.set(run.runId, run);
      } catch {
        // Skip malformed lines
      }
    }

    const runs = Array.from(byId.values());

    for (const run of runs) {
      if (run.status === 'running') {
        run.status = 'failure';
        run.error = 'Server restarted -- run was interrupted';
        run.completedAt = run.completedAt || new Date().toISOString();
        if (run.completedAt) {
          run.totalMs = new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime();
        }
        run.currentStage = null;
      }
    }

    runs.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    return runs.slice(-MAX_PERSISTED);
  } catch (err) {
    console.log(JSON.stringify({
      level: 'warn',
      msg: 'Failed to load persisted pipeline runs',
      error: String(err),
      ts: new Date().toISOString(),
    }));
    return [];
  }
}

/**
 * Rewrite the JSONL file with only the latest snapshot per run (compaction).
 */
export function compactStore(runs: PipelineRun[]): void {
  try {
    ensureDir();
    const content = runs.map(r => JSON.stringify(r)).join('\n') + (runs.length > 0 ? '\n' : '');
    writeFileSync(getPath(), content, 'utf8');
  } catch (err) {
    console.log(JSON.stringify({
      level: 'warn',
      msg: 'Failed to compact pipeline runs store',
      error: String(err),
      ts: new Date().toISOString(),
    }));
  }
}
