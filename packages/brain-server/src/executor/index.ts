/**
 * Agent Executor — unified launcher for all agent invocations.
 *
 * One function that every subsystem calls to spawn an agent, regardless of
 * where the request originates or what LLM runtime is used.
 *
 * Flow:
 * 1. Resolve runtime adapter
 * 2. Build context (if session provided)
 * 3. Apply role template
 * 4. Construct final prompt
 * 5. Create job record
 * 6. Dispatch to adapter
 * 7. Publish result to NATS
 */

import type { NatsConnection } from 'nats';
import { StringCodec } from 'nats';
import type {
  LaunchParams,
  LaunchResult,
  AdapterResult,
  RuntimeAdapter,
  RuntimeTool,
} from './types.js';
import { createJob, markJobRunning, markJobDone, markJobFailed, updateHeartbeat } from '../jobs/registry.js';
import { createWorktree, removeWorktree, createScratchDir, cleanupScratchDir } from '../jobs/worktree.js';
import { getRole, buildRolePrompt } from './roles.js';
import { assembleContext } from './context/index.js';

// Adapters
import claudeCodeAdapter from './adapters/claude-code.js';
import mercuryAdapter from './adapters/mercury.js';
import ollamaAdapter from './adapters/ollama.js';
import syntheticAdapter from './adapters/synthetic.js';

const sc = StringCodec();

// ---------------------------------------------------------------------------
// Adapter registry
// ---------------------------------------------------------------------------

const adapters = new Map<RuntimeTool, RuntimeAdapter>([
  ['claude-code', claudeCodeAdapter],
  ['mercury', mercuryAdapter],
  ['ollama', ollamaAdapter],
  ['synthetic', syntheticAdapter],
]);

/**
 * Register a custom runtime adapter.
 */
export function registerAdapter(adapter: RuntimeAdapter): void {
  adapters.set(adapter.name, adapter);
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let natsConnection: NatsConnection | null = null;

/**
 * Initialize the executor with a NATS connection.
 * Must be called before launchAgent().
 */
export function initExecutor(nats: NatsConnection): void {
  natsConnection = nats;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Launch an agent with the unified executor.
 *
 * Handles context building, role injection, prompt construction,
 * job tracking, adapter dispatch, and result publishing.
 */
export async function launchAgent(params: LaunchParams): Promise<LaunchResult> {
  const nats = natsConnection;
  if (!nats) throw new Error('Executor not initialized. Call initExecutor(nats) first.');

  // 1. Resolve the runtime adapter
  const adapter = adapters.get(params.runtime.tool);
  if (!adapter) {
    throw new Error(`Unknown runtime: ${params.runtime.tool}. Available: ${Array.from(adapters.keys()).join(', ')}`);
  }

  // 2. Resolve the role template
  const role = getRole(params.role);
  const defaultRuntime = role?.defaultRuntime ?? {};
  const runtime = { ...defaultRuntime, ...params.runtime };

  // 3. Build context (if session provided or modules requested)
  let contextText = '';
  if (params.sessionId || params.contextModules) {
    try {
      const contextResult = await assembleContext({
        sessionId: params.sessionId,
        role: params.role,
        prompt: params.prompt,
        modules: params.contextModules ?? role?.defaultModules,
      });
      contextText = contextResult.text;
    } catch (err) {
      log('warn', 'Context assembly failed, proceeding without', { error: String(err) });
    }
  }

  // 4. Construct the final prompt
  const prompt = buildPrompt({
    rolePrompt: buildRolePrompt(params.role),
    contextText,
    additionalContext: params.context,
    taskPrompt: params.prompt,
  });

  // 5. Create job record
  const jobType = params.jobType ?? 'task';
  const jobId = await createJob({
    jobType,
    prompt: params.prompt, // Store original prompt, not the expanded one
    contextJson: {
      sessionId: params.sessionId,
      role: params.role,
      runtime: params.runtime,
      contextModules: params.contextModules,
    },
    natsReplySubject: params.replySubject,
  });

  const resultSubject = `agent.results.${jobId}`;

  log('info', 'Launching agent', {
    jobId,
    role: params.role,
    runtime: params.runtime.tool,
    model: runtime.model,
    sessionId: params.sessionId,
    hasContext: contextText.length > 0,
  });

  // 6. Resolve working directory and isolation
  let workdir = params.workdir ?? '/agent';
  let worktreePath: string | undefined;
  let scratchDir: string | undefined;

  if (params.projectPath) {
    try {
      worktreePath = await createWorktree(jobId, params.projectPath);
      workdir = worktreePath;
    } catch (err) {
      log('warn', 'Worktree creation failed, using scratch dir', { jobId, error: String(err) });
      scratchDir = createScratchDir(jobId);
      workdir = scratchDir;
    }
  } else if (jobType === 'research') {
    scratchDir = createScratchDir(jobId);
  }

  // 7. Mark job running
  await markJobRunning(jobId, process.pid, {
    worktreePath,
    scratchDir,
    outputFile: `/agent/command/results/${jobId}/output.log`,
  });

  // 8. Dispatch to adapter (async, don't block the caller for long-running jobs)
  dispatchAndPublish({
    adapter,
    prompt,
    runtime,
    jobId,
    workdir,
    worktreePath,
    scratchDir,
    projectPath: params.projectPath,
    replySubject: params.replySubject,
    clientId: params.clientId,
    nats,
  }).catch(err => {
    log('error', 'Dispatch failed unexpectedly', { jobId, error: String(err) });
  });

  return { jobId, sessionId: params.sessionId, resultSubject };
}

// ---------------------------------------------------------------------------
// Internal dispatch
// ---------------------------------------------------------------------------

async function dispatchAndPublish(params: {
  adapter: RuntimeAdapter;
  prompt: string;
  runtime: LaunchParams['runtime'];
  jobId: string;
  workdir: string;
  worktreePath?: string;
  scratchDir?: string;
  projectPath?: string;
  replySubject?: string;
  clientId?: string;
  nats: NatsConnection;
}): Promise<void> {
  const { adapter, prompt, runtime, jobId, workdir, nats } = params;

  let result: AdapterResult;

  try {
    result = await adapter.execute({
      prompt,
      runtime,
      jobId,
      workdir,
      env: {
        JOB_ID: jobId,
        NATS_URL: process.env.NATS_URL || 'nats://life-system-nats:4222',
      },
      onActivity: () => {
        updateHeartbeat(jobId).catch(() => {});
      },
      nats,
    });
  } catch (err) {
    result = {
      success: false,
      resultText: null,
      rawOutput: '',
      durationMs: 0,
      error: `Adapter threw: ${String(err)}`,
    };
  }

  // Cleanup isolation artifacts
  if (params.worktreePath && params.projectPath) {
    await removeWorktree(jobId, params.projectPath).catch(() => {});
  }
  if (params.scratchDir) {
    cleanupScratchDir(jobId);
  }

  // Update job status
  if (result.success && result.resultText) {
    await markJobDone(jobId, result.resultText).catch(() => {});
  } else {
    await markJobFailed(jobId, result.error ?? 'Unknown error').catch(() => {});
  }

  // Publish result to NATS
  const jobResult = {
    jobId,
    clientId: params.clientId,
    status: result.success ? 'done' : 'failed',
    result: result.resultText,
    error: result.error,
    durationMs: result.durationMs,
    logPath: `/agent/command/results/${jobId}/output.log`,
  };

  const payload = sc.encode(JSON.stringify(jobResult));

  nats.publish(`agent.results.${jobId}`, payload);
  nats.publish(`communication.agent-results.${jobId}`, payload);

  if (params.replySubject) {
    nats.publish(params.replySubject, payload);
  }

  log(result.success ? 'info' : 'error', `Agent ${result.success ? 'completed' : 'failed'}`, {
    jobId,
    durationMs: result.durationMs,
    resultLength: result.resultText?.length ?? 0,
    error: result.error,
  });
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

function buildPrompt(parts: {
  rolePrompt: string;
  contextText: string;
  additionalContext?: string[];
  taskPrompt: string;
}): string {
  const sections: string[] = [];

  if (parts.rolePrompt) {
    sections.push(parts.rolePrompt);
  }

  if (parts.contextText) {
    sections.push(parts.contextText);
  }

  if (parts.additionalContext && parts.additionalContext.length > 0) {
    sections.push(parts.additionalContext.join('\n\n'));
  }

  sections.push(parts.taskPrompt);

  return sections.join('\n\n---\n\n');
}

// ---------------------------------------------------------------------------
// Re-exports for convenience
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Synchronous invoke — for lightweight, inline adapter calls (no job tracking)
// ---------------------------------------------------------------------------

export interface InvokeParams {
  /** Runtime adapter to use */
  runtime: RuntimeTool;
  /** Model identifier */
  model: string;
  /** The prompt text */
  prompt: string;
  /** Max tokens (default 4096) */
  maxTokens?: number;
  /** Temperature (optional) */
  temperature?: number;
  /** Mercury-specific: reasoning effort */
  reasoningEffort?: 'instant' | 'low' | 'medium' | 'high';
}

/**
 * Invoke an adapter synchronously — returns the result inline.
 * No job tracking, no NATS publishing. For lightweight classification,
 * composition, summarization, etc.
 */
export async function invokeAdapter(params: InvokeParams): Promise<AdapterResult> {
  const adapter = adapters.get(params.runtime);
  if (!adapter) {
    return {
      success: false,
      resultText: null,
      rawOutput: '',
      durationMs: 0,
      error: `Unknown runtime: ${params.runtime}`,
    };
  }

  const result = await adapter.execute({
    prompt: params.prompt,
    runtime: {
      tool: params.runtime,
      model: params.model,
      temperature: params.temperature,
      reasoningEffort: params.reasoningEffort,
    },
    jobId: `invoke-${Date.now()}`,
    workdir: '/agent',
  });

  return result;
}

export { getRole, registerRole, listRoles } from './roles.js';
export { initContextSchema } from './context/index.js';
export { getRunningProcessCount, getRunningProcessIds, killProcess, getLastActivity } from './adapters/claude-code.js';
export type { LaunchParams, LaunchResult, RuntimeConfig, RuntimeTool, AdapterResult } from './types.js';

function log(level: string, msg: string, extra?: Record<string, unknown>): void {
  console.log(JSON.stringify({ level, msg, component: 'executor', ts: new Date().toISOString(), ...extra }));
}
