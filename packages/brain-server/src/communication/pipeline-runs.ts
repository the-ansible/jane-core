/**
 * Pipeline Runs -- lifecycle tracker for communication pipeline processing.
 * Tracks each inbound message through routing -> safety -> context -> agent -> composer -> publish.
 * Persisted to JSONL on disk so the dashboard survives server restarts.
 */

import { persistRun, loadPersistedRuns, compactStore } from './pipeline-runs-store.js';

export type PipelineRunStatus = 'running' | 'success' | 'failure';
export type PipelineStage = 'routing' | 'safety_check' | 'context_assembly' | 'agent' | 'composer' | 'publish';

export interface StageRecord {
  stage: PipelineStage;
  status: PipelineRunStatus;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  error?: string;
  detail?: string;
}

export interface RoutingProvenance {
  action: string;
  reason: string;
  targetRole?: string;
  targetId?: string;
  latencyMs: number;
}

export interface PipelineRun {
  runId: string;
  sessionId: string;
  channelType: string;
  senderName: string;
  contentPreview: string;
  status: PipelineRunStatus;
  currentStage: PipelineStage | null;
  stages: StageRecord[];
  startedAt: string;
  completedAt?: string;
  totalMs?: number;
  error?: string;
  routeAction?: string;
  routingProvenance?: RoutingProvenance;
  agentOutput?: string;
  composerOutput?: string;
}

type RunListener = (run: PipelineRun) => void;

const MAX_ACTIVE = 20;
const MAX_RECENT = 50;

const activeRuns = new Map<string, PipelineRun>();
const recentRuns: PipelineRun[] = [];
const listeners = new Set<RunListener>();

function notify(run: PipelineRun): void {
  for (const listener of listeners) {
    try { listener(run); } catch (err) { console.log(JSON.stringify({ level: 'warn', msg: 'Pipeline run listener error', component: 'comm.pipeline-runs', error: String(err), ts: new Date().toISOString() })); }
  }
}

function moveToRecent(run: PipelineRun): void {
  activeRuns.delete(run.runId);
  recentRuns.push(run);
  if (recentRuns.length > MAX_RECENT) {
    recentRuns.shift();
  }
}

export function startRun(opts: {
  runId: string;
  sessionId: string;
  channelType: string;
  senderName: string;
  contentPreview: string;
  routingProvenance?: RoutingProvenance;
  startedAt?: string;
}): PipelineRun {
  const staleIdx = recentRuns.findIndex(r => r.runId === opts.runId);
  if (staleIdx !== -1) {
    recentRuns.splice(staleIdx, 1);
  }

  if (activeRuns.size >= MAX_ACTIVE) {
    const oldest = activeRuns.keys().next().value!;
    const stale = activeRuns.get(oldest)!;
    stale.status = 'failure';
    stale.error = 'Evicted (too many active runs)';
    stale.completedAt = new Date().toISOString();
    stale.totalMs = Date.now() - new Date(stale.startedAt).getTime();
    moveToRecent(stale);
  }

  const run: PipelineRun = {
    runId: opts.runId,
    sessionId: opts.sessionId,
    channelType: opts.channelType,
    senderName: opts.senderName,
    contentPreview: opts.contentPreview,
    status: 'running',
    currentStage: null,
    stages: [],
    startedAt: opts.startedAt || new Date().toISOString(),
    ...(opts.routingProvenance ? { routingProvenance: opts.routingProvenance } : {}),
  };

  activeRuns.set(run.runId, run);
  notify(run);
  persistRun(run);
  return run;
}

export function beginStage(runId: string, stage: PipelineStage, detail?: string): void {
  const run = activeRuns.get(runId);
  if (!run) return;

  const record: StageRecord = {
    stage,
    status: 'running',
    startedAt: new Date().toISOString(),
    ...(detail ? { detail } : {}),
  };

  run.stages.push(record);
  run.currentStage = stage;
  notify(run);
}

export function completeStage(runId: string, stage: PipelineStage, detail?: string): void {
  const run = activeRuns.get(runId);
  if (!run) return;

  const record = run.stages.find(s => s.stage === stage && s.status === 'running');
  if (record) {
    record.status = 'success';
    record.completedAt = new Date().toISOString();
    record.durationMs = new Date(record.completedAt).getTime() - new Date(record.startedAt).getTime();
    if (detail) record.detail = detail;
  }
  notify(run);
}

export function failStage(runId: string, stage: PipelineStage, error: string): void {
  const run = activeRuns.get(runId);
  if (!run) return;

  const record = run.stages.find(s => s.stage === stage && s.status === 'running');
  if (record) {
    record.status = 'failure';
    record.completedAt = new Date().toISOString();
    record.durationMs = new Date(record.completedAt).getTime() - new Date(record.startedAt).getTime();
    record.error = error;
  }
  notify(run);
}

export function completeRun(runId: string, status: 'success' | 'failure', opts?: {
  routeAction?: string;
  error?: string;
}): void {
  const run = activeRuns.get(runId);
  if (!run) return;

  run.status = status;
  run.completedAt = new Date().toISOString();
  run.totalMs = new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime();
  run.currentStage = null;
  if (opts?.routeAction) run.routeAction = opts.routeAction;
  if (opts?.error) run.error = opts.error;

  for (const stage of run.stages) {
    if (stage.status === 'running') {
      stage.status = status;
      stage.completedAt = run.completedAt;
      stage.durationMs = new Date(stage.completedAt).getTime() - new Date(stage.startedAt).getTime();
      if (opts?.error) stage.error = opts.error;
    }
  }

  moveToRecent(run);
  notify(run);
  persistRun(run);
}

export function setRunOutputs(runId: string, opts: { agentOutput?: string; composerOutput?: string }): void {
  const run = activeRuns.get(runId) || recentRuns.find(r => r.runId === runId);
  if (!run) return;
  if (opts.agentOutput !== undefined) run.agentOutput = opts.agentOutput;
  if (opts.composerOutput !== undefined) run.composerOutput = opts.composerOutput;
  notify(run);
}

export function getActiveRuns(): PipelineRun[] {
  return Array.from(activeRuns.values());
}

export function getRecentRuns(limit: number = MAX_RECENT): PipelineRun[] {
  return recentRuns.slice(-limit);
}

export function getRun(runId: string): PipelineRun | undefined {
  return activeRuns.get(runId) || recentRuns.find(r => r.runId === runId);
}

export function onRunUpdate(callback: RunListener): () => void {
  listeners.add(callback);
  return () => { listeners.delete(callback); };
}

export function cleanupOrphanedRuns(maxAgeMs: number = 20 * 60 * 1000): number {
  const now = Date.now();
  let cleaned = 0;
  for (const [id, run] of activeRuns) {
    if (now - new Date(run.startedAt).getTime() > maxAgeMs) {
      completeRun(id, 'failure', { error: `Orphaned (exceeded ${Math.round(maxAgeMs / 60000)}min timeout)` });
      cleaned++;
    }
  }
  return cleaned;
}

export function clearRuns(): void {
  activeRuns.clear();
  recentRuns.length = 0;
  listeners.clear();
}

/**
 * Load persisted pipeline runs from disk into in-memory recent runs.
 * Call once at startup.
 */
export function initPipelineRunsStore(): void {
  const persisted = loadPersistedRuns();
  if (persisted.length === 0) return;

  const toLoad = persisted.slice(-MAX_RECENT);
  recentRuns.push(...toLoad);
  if (recentRuns.length > MAX_RECENT) {
    recentRuns.splice(0, recentRuns.length - MAX_RECENT);
  }

  compactStore(recentRuns.slice());

  console.log(JSON.stringify({
    level: 'info',
    msg: 'Loaded persisted pipeline runs',
    component: 'comm.pipeline-runs',
    count: toLoad.length,
    ts: new Date().toISOString(),
  }));
}
