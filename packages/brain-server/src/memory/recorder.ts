/**
 * Memory Recorder — creates memories from system events.
 *
 * Called by the goal engine, job spawner, and hierarchical layers
 * to stamp significant events into long-term memory automatically.
 */

import { recordMemory } from './registry.js';
import type { MemorySource } from './types.js';

// ---------------------------------------------------------------------------
// Goal cycle outcome
// ---------------------------------------------------------------------------

export async function recordGoalCycleMemory(params: {
  cycleId: string;
  goalsAssessed: number;
  candidatesGenerated: number;
  selectedAction: string | null;
  outcome: 'done' | 'failed';
  notes: string | null;
}): Promise<void> {
  const { cycleId, goalsAssessed, candidatesGenerated, selectedAction, outcome, notes } = params;

  const title = outcome === 'done'
    ? `Goal cycle ${cycleId.slice(0, 8)} — ${selectedAction ? 'action selected' : 'no action taken'}`
    : `Goal cycle ${cycleId.slice(0, 8)} — failed`;

  const content = [
    `Goals assessed: ${goalsAssessed}`,
    `Candidates generated: ${candidatesGenerated}`,
    selectedAction ? `Selected action: ${selectedAction}` : 'No action selected',
    notes ? `Notes: ${notes}` : null,
  ].filter(Boolean).join('\n');

  await recordMemory({
    type: 'episodic',
    source: 'goal_cycle',
    title,
    content,
    tags: ['goal-cycle', outcome, selectedAction ? 'action-taken' : 'no-action'],
    importance: outcome === 'failed' ? 0.6 : selectedAction ? 0.7 : 0.4,
    metadata: { cycleId, goalsAssessed, candidatesGenerated, outcome },
  }).catch(logError('recordGoalCycleMemory'));
}

// ---------------------------------------------------------------------------
// Job completion
// ---------------------------------------------------------------------------

export async function recordJobCompletionMemory(params: {
  jobId: string;
  jobType: string;
  prompt: string;
  outcome: 'completed' | 'failed' | 'killed';
  outputSummary?: string;
}): Promise<void> {
  const { jobId, jobType, prompt, outcome, outputSummary } = params;

  // Only record failures and notable completions by default
  const importance = outcome === 'failed' ? 0.65 : outcome === 'killed' ? 0.55 : 0.45;

  const title = `Job ${jobId.slice(0, 8)} (${jobType}) — ${outcome}`;
  const content = [
    `Type: ${jobType}`,
    `Outcome: ${outcome}`,
    `Prompt: ${prompt.slice(0, 300)}${prompt.length > 300 ? '…' : ''}`,
    outputSummary ? `Output: ${outputSummary.slice(0, 400)}` : null,
  ].filter(Boolean).join('\n');

  await recordMemory({
    type: 'episodic',
    source: 'job_completion',
    title,
    content,
    tags: ['job', jobType, outcome],
    importance,
    metadata: { jobId, jobType, outcome },
  }).catch(logError('recordJobCompletionMemory'));
}

// ---------------------------------------------------------------------------
// Layer events (autonomic alerts, strategic directives, etc.)
// ---------------------------------------------------------------------------

export async function recordLayerEventMemory(params: {
  layer: string;
  eventType: string;
  severity: string;
  description: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const { layer, eventType, severity, description, metadata } = params;

  // Only persist critical/high severity events — info noise would swamp memory
  if (severity === 'info' || severity === 'debug') return;

  const importance = severity === 'critical' ? 0.9 : severity === 'high' ? 0.75 : 0.55;

  await recordMemory({
    type: 'episodic',
    source: 'layer_event',
    title: `[${layer}/${severity}] ${eventType}`,
    content: description,
    tags: ['layer-event', layer, eventType, severity],
    importance,
    metadata: { layer, eventType, severity, ...metadata },
  }).catch(logError('recordLayerEventMemory'));
}

// ---------------------------------------------------------------------------
// Strategic directive (procedural memory)
// ---------------------------------------------------------------------------

export async function recordDirectiveMemory(params: {
  directiveId: string;
  targetLayer: string;
  directive: string;
  params?: Record<string, unknown>;
}): Promise<void> {
  const { directiveId, targetLayer, directive, params: dParams } = params;

  await recordMemory({
    type: 'procedural',
    source: 'layer_event',
    title: `Directive → ${targetLayer}: ${directive}`,
    content: [
      `Target: ${targetLayer}`,
      `Directive: ${directive}`,
      dParams ? `Params: ${JSON.stringify(dParams)}` : null,
    ].filter(Boolean).join('\n'),
    tags: ['directive', targetLayer, 'strategic'],
    importance: 0.7,
    metadata: { directiveId, targetLayer, directive, params: dParams },
  }).catch(logError('recordDirectiveMemory'));
}

// ---------------------------------------------------------------------------
// Manual / reflection
// ---------------------------------------------------------------------------

export async function recordManualMemory(params: {
  title: string;
  content: string;
  type?: 'episodic' | 'semantic' | 'procedural' | 'working';
  tags?: string[];
  importance?: number;
  expiresInMs?: number;
  metadata?: Record<string, unknown>;
  source?: MemorySource;
}): Promise<string> {
  return recordMemory({
    type: params.type ?? 'semantic',
    source: params.source ?? 'manual',
    title: params.title,
    content: params.content,
    tags: params.tags ?? [],
    importance: params.importance ?? 0.6,
    metadata: params.metadata ?? {},
    expiresInMs: params.expiresInMs,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function logError(fn: string): (err: unknown) => void {
  return (err) => {
    console.log(JSON.stringify({
      level: 'error',
      msg: `${fn} failed — memory not recorded`,
      error: String(err),
      component: 'memory-recorder',
      ts: new Date().toISOString(),
    }));
  };
}
