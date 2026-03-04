/**
 * Pipeline — wires classifier → router → agent → composer → NATS outbound.
 * This is the main processing pipeline for inbound communication events.
 */

import { readFileSync } from 'node:fs';
import { uuidv7 } from '@the-ansible/life-system-shared';
import type { CommunicationEvent } from '@the-ansible/life-system-shared';
import type { ClassificationResult } from './classifier/types.js';
import type { NatsClient } from './nats/client.js';
import type { SafetyGate } from './safety/index.js';
import { route, type RouteDecision } from './router/index.js';
import { invokeAgent, parseAgentResponse, type AgentIntent } from './agent/index.js';
import { markJobCompleted, markJobFailed, getJobById, type AgentJob } from './agent/job-registry.js';
import { compose } from './composer/index.js';
import { recordPipelineOutcome } from './pipeline-stats.js';
import { enqueueForRetry } from './outbound-queue.js';
import { pushEvent } from './events.js';
import {
  startRun, beginStage, completeStage, failStage, completeRun, setRunOutputs, getRunByJobId,
} from './pipeline-runs.js';
import {
  getSession,
  appendMessage,
  needsCompaction,
  type SessionMessage,
} from './sessions/store.js';
import { assembleContext } from './context/assembler.js';
import { updateAssemblyOutcome } from './context/db.js';
import { compactAndIngest } from './graphiti/compactor.js';
import { searchMemory } from './graphiti/client.js';

export interface PipelineDeps {
  nats: NatsClient | null;
  safety: SafetyGate | null;
}

export interface PipelineResult {
  action: string;
  reason: string;
  responded: boolean;
  responseEventId?: string;
  agentIntent?: AgentIntent | null;
  error?: string;
}

/**
 * Process a classified event through the full pipeline.
 * Returns what happened for logging/metrics.
 */
export async function processPipeline(
  event: CommunicationEvent,
  classification: ClassificationResult,
  deps: PipelineDeps,
  opts?: { recoveredJobId?: string; redeliveryCount?: number }
): Promise<PipelineResult> {
  // Start pipeline run tracking
  const senderName = event.sender?.displayName || event.sender?.id || 'User';
  const run = startRun({
    runId: event.id,
    sessionId: event.sessionId,
    channelType: event.channelType,
    senderName,
    contentPreview: event.content.slice(0, 120),
    classification: classification.routing,
    classificationProvenance: {
      routing: classification.routing,
      tier: classification.tier,
      confidence: classification.confidence,
      urgency: classification.urgency,
      category: classification.category,
      ...(classification.agreement ? { agreement: classification.agreement } : {}),
      latencyMs: classification.latencyMs,
      ...(classification.model ? { model: classification.model } : {}),
    },
    recoveredJobId: opts?.recoveredJobId,
  });

  // 1. Route based on classification
  beginStage(run.runId, 'routing');
  const decision = route(classification);

  // Active-session override: if routed to log_only but session has recent Jane activity,
  // override to reply so conversational messages ("Good job!", "Thanks", etc.) get responses.
  if (decision.action === 'log') {
    const session = getSession(event.sessionId);
    const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
    const hasRecentJaneActivity = session.messages.some(
      m => m.role === 'assistant' && new Date(m.timestamp).getTime() > tenMinutesAgo
    );
    if (hasRecentJaneActivity) {
      decision.action = 'reply';
      decision.reason = `active_session_override (was: ${classification.routing}) — ${decision.reason}`;
    }
  }

  console.log(JSON.stringify({
    level: 'info',
    msg: 'Pipeline routing decision',
    component: 'pipeline',
    eventId: event.id,
    action: decision.action,
    reason: decision.reason,
    ts: new Date().toISOString(),
  }));

  completeStage(run.runId, 'routing', decision.action);

  // 2. Record inbound message in session
  appendMessage(event.sessionId, {
    role: 'user',
    content: event.content,
    timestamp: event.timestamp,
    eventId: event.id,
    source: event.source ?? event.sender?.id,
    source_type: event.source_type ?? event.sender?.type,
  });

  // Compact + ingest to Graphiti when session exceeds threshold (fire-and-forget)
  if (needsCompaction(event.sessionId)) {
    compactAndIngest(event.sessionId, deps.nats).catch((err) => {
      console.log(JSON.stringify({
        level: 'warn',
        msg: 'Session compaction failed',
        sessionId: event.sessionId,
        error: String(err),
        component: 'pipeline',
        ts: new Date().toISOString(),
      }));
    });
  }

  // 3. Dispatch based on route decision
  const pipelineStart = Date.now();

  switch (decision.action) {
    case 'log': {
      const result = { action: 'log', reason: decision.reason, responded: false };
      recordPipelineOutcome({ action: 'log', responded: false, totalMs: Date.now() - pipelineStart });
      completeRun(run.runId, 'success', { routeAction: 'log' });
      return result;
    }

    case 'reply':
    case 'think':
    case 'escalate': {
      const result = await handleAgentResponse(event, classification, decision, senderName, deps, pipelineStart, run.runId, opts);
      return result;
    }

    default: {
      const result = { action: decision.action, reason: decision.reason, responded: false };
      recordPipelineOutcome({ action: decision.action, responded: false, totalMs: Date.now() - pipelineStart });
      completeRun(run.runId, 'success', { routeAction: decision.action });
      return result;
    }
  }
}

async function handleAgentResponse(
  event: CommunicationEvent,
  classification: ClassificationResult,
  decision: RouteDecision,
  senderName: string,
  deps: PipelineDeps,
  pipelineStart: number,
  runId: string,
  opts?: { recoveredJobId?: string; redeliveryCount?: number }
): Promise<PipelineResult> {
  // Safety check before Claude calls
  beginStage(runId, 'safety_check');
  if (deps.safety) {
    const claudeCheck = deps.safety.canCallClaude(event.channelType);
    if (!claudeCheck.allowed) {
      const errorMsg = 'Blocked by safety: ' + claudeCheck.reasons.join(', ');
      failStage(runId, 'safety_check', errorMsg);
      completeRun(runId, 'failure', { routeAction: decision.action, error: errorMsg });
      console.log(JSON.stringify({
        level: 'warn',
        msg: 'Pipeline blocked by safety gate',
        component: 'pipeline',
        reasons: claudeCheck.reasons,
        ts: new Date().toISOString(),
      }));
      recordPipelineOutcome({
        action: decision.action, responded: false, totalMs: Date.now() - pipelineStart,
        error: 'Blocked by safety',
      });
      return {
        action: decision.action,
        reason: errorMsg,
        responded: false,
      };
    }
  }
  completeStage(runId, 'safety_check');

  // Get assembled context and long-term memory in parallel
  beginStage(runId, 'context_assembly');
  const [agentContext, graphitiMemory] = await Promise.all([
    assembleContext(event.sessionId, 'agent', event.id),
    searchMemory(event.content, 5).catch(() => []),
  ]);
  completeStage(runId, 'context_assembly');

  if (graphitiMemory.length > 0) {
    console.log(JSON.stringify({
      level: 'info',
      msg: 'Graphiti memory retrieved',
      component: 'pipeline',
      factCount: graphitiMemory.length,
      ts: new Date().toISOString(),
    }));
  }

  // 4. Invoke Agent
  beginStage(runId, 'agent');
  deps.safety?.recordLlmCall('claude', event.channelType);

  // Build recovery info if this is a recovered/retried job
  let recoveryInfo: { recoveryCount: number; originalStartedAt: string } | undefined;
  if (opts?.recoveredJobId) {
    const recoveredJob = await getJobById(opts.recoveredJobId).catch(() => null);
    if (recoveredJob) {
      recoveryInfo = {
        recoveryCount: recoveredJob.retry_count + 1,
        originalStartedAt: new Date(recoveredJob.created_at).toISOString(),
      };
    }
  } else if (opts?.redeliveryCount && opts.redeliveryCount > 1) {
    // NATS redelivered this message — server likely restarted mid-pipeline
    recoveryInfo = {
      recoveryCount: opts.redeliveryCount - 1,
      originalStartedAt: event.timestamp,
    };
  }

  const agentStart = Date.now();
  const { intent, jobId } = await invokeAgent({
    content: event.content,
    senderName,
    classification,
    assembledContext: agentContext,
    graphitiMemory,
    recoveryContext: { event, classification },
    recoveryInfo,
  });
  const agentMs = Date.now() - agentStart;

  if (!intent) {
    const agentError = 'Agent returned no intent';
    failStage(runId, 'agent', agentError);
    completeRun(runId, 'failure', { routeAction: decision.action, error: agentError });
    await updateAssemblyOutcome(agentContext.meta.assemblyLogId, false).catch(() => {});
    recordPipelineOutcome({
      action: decision.action, responded: false, agentMs, totalMs: Date.now() - pipelineStart,
      error: agentError,
    });
    return {
      action: decision.action,
      reason: decision.reason,
      responded: false,
      agentIntent: null,
      error: agentError,
    };
  }
  completeStage(runId, 'agent', `${intent.type} (${agentMs}ms)`);
  setRunOutputs(runId, { agentOutput: intent.content });

  // 5. Compose in Jane's voice
  beginStage(runId, 'composer');
  deps.safety?.recordLlmCall('claude', event.channelType);
  const composerStart = Date.now();
  const composedMessage = await compose({
    intent,
    senderName,
  });
  const composerMs = Date.now() - composerStart;

  if (!composedMessage) {
    const composerError = 'Composer returned no message';
    failStage(runId, 'composer', composerError);
    completeRun(runId, 'failure', { routeAction: decision.action, error: composerError });
    await updateAssemblyOutcome(agentContext.meta.assemblyLogId, false).catch(() => {});
    recordPipelineOutcome({
      action: decision.action, responded: false, agentMs, composerMs, totalMs: Date.now() - pipelineStart,
      error: composerError,
    });
    return {
      action: decision.action,
      reason: decision.reason,
      responded: false,
      agentIntent: intent,
      error: composerError,
    };
  }
  completeStage(runId, 'composer', `${composerMs}ms`);
  setRunOutputs(runId, { composerOutput: composedMessage });

  // 6. Publish outbound response
  beginStage(runId, 'publish');
  if (!deps.nats?.isConnected()) {
    const natsError = 'NATS not connected';
    failStage(runId, 'publish', natsError);
    completeRun(runId, 'failure', { routeAction: decision.action, error: natsError });
    recordPipelineOutcome({
      action: decision.action, responded: false, agentMs, composerMs, totalMs: Date.now() - pipelineStart,
      error: natsError,
    });
    return {
      action: decision.action,
      reason: decision.reason,
      responded: false,
      agentIntent: intent,
      error: natsError,
    };
  }

  const responseEvent = {
    id: uuidv7(),
    parentId: event.id,
    sessionId: event.sessionId,
    channelType: event.channelType,
    direction: 'outbound' as const,
    contentType: 'markdown' as const,
    content: composedMessage,
    sender: {
      id: 'jane',
      displayName: 'Jane',
      type: 'agent' as const,
    },
    recipients: event.sender ? [{
      id: event.sender.id,
      displayName: event.sender.displayName,
      type: event.sender.type,
    }] : [],
    metadata: {
      intentType: intent.type,
      tone: intent.tone,
      classificationTier: classification.tier,
    },
    timestamp: new Date().toISOString(),
  };

  const subject = `communication.outbound.${event.channelType}`;

  try {
    await deps.nats.publish(subject, responseEvent);
    deps.safety?.recordSend();
    pushEvent(responseEvent as CommunicationEvent, subject);

    // Record outbound in session
    appendMessage(event.sessionId, {
      role: 'assistant',
      content: composedMessage,
      timestamp: responseEvent.timestamp,
      eventId: responseEvent.id,
      source: 'jane',
      source_type: 'agent',
    });

    console.log(JSON.stringify({
      level: 'info',
      msg: 'Pipeline response sent',
      component: 'pipeline',
      eventId: event.id,
      responseId: responseEvent.id,
      subject,
      intentType: intent.type,
      ts: new Date().toISOString(),
    }));

    // Mark job completed now that outbound publish is confirmed
    if (jobId) markJobCompleted(jobId).catch(() => {});

    // Record assembly outcome (async, don't block)
    updateAssemblyOutcome(agentContext.meta.assemblyLogId, true).catch(() => {});

    completeStage(runId, 'publish', responseEvent.id);
    completeRun(runId, 'success', { routeAction: decision.action });

    recordPipelineOutcome({
      action: decision.action, responded: true, agentMs, composerMs, totalMs: Date.now() - pipelineStart,
    });

    return {
      action: decision.action,
      reason: decision.reason,
      responded: true,
      responseEventId: responseEvent.id,
      agentIntent: intent,
    };
  } catch (err) {
    console.log(JSON.stringify({
      level: 'error',
      msg: 'Failed to publish response, queuing for retry',
      component: 'pipeline',
      eventId: event.id,
      responseId: responseEvent.id,
      error: String(err),
      ts: new Date().toISOString(),
    }));

    // Queue for retry instead of losing the composed message
    enqueueForRetry(subject, responseEvent, event.sessionId, responseEvent.id);

    // Mark job failed — the outbound retry queue handles the message
    if (jobId) markJobFailed(jobId, `publish failed: ${err}`).catch(() => {});

    failStage(runId, 'publish', String(err));
    completeRun(runId, 'failure', { routeAction: decision.action, error: `Publish failed: ${err}` });

    recordPipelineOutcome({
      action: decision.action, responded: false, agentMs, composerMs, totalMs: Date.now() - pipelineStart,
      error: `Publish failed (queued for retry): ${err}`,
    });

    return {
      action: decision.action,
      reason: decision.reason,
      responded: false,
      agentIntent: intent,
      error: `Publish failed (queued for retry): ${err}`,
    };
  }
}

/**
 * Resume a pipeline run that was attached to an alive job wrapper after restart.
 * Called when we receive the `stimulation.agent_jobs.completed` NATS event.
 */
export async function resumeAliveJob(opts: {
  jobId: string;
  outputFile: string;
  success: boolean;
  deps: PipelineDeps;
}): Promise<void> {
  const run = getRunByJobId(opts.jobId);
  if (!run) {
    // Job completed before or after we tracked it — nothing to do
    return;
  }

  const job = await getJobById(opts.jobId);
  if (!job) {
    failStage(run.runId, 'agent', 'Job not found in DB');
    completeRun(run.runId, 'failure', { error: 'Job not found in DB' });
    return;
  }

  const ctx = job.context_json as { event?: any; classification?: any };
  const event = ctx?.event;
  const pipelineStart = new Date(run.startedAt).getTime();

  if (!opts.success) {
    failStage(run.runId, 'agent', 'Wrapper exited with failure');
    completeRun(run.runId, 'failure', { error: 'Agent wrapper failed' });
    await markJobFailed(opts.jobId, 'wrapper exited with failure').catch(() => {});
    return;
  }

  // Read Claude's output from the file the wrapper wrote
  let rawOutput: string;
  try {
    rawOutput = readFileSync(opts.outputFile, 'utf-8');
  } catch (err) {
    failStage(run.runId, 'agent', `Cannot read output file: ${err}`);
    completeRun(run.runId, 'failure', { error: 'Output file missing' });
    await markJobFailed(opts.jobId, `output file missing: ${err}`).catch(() => {});
    return;
  }

  const intent = parseAgentResponse(rawOutput);
  const agentMs = Date.now() - pipelineStart;

  if (!intent) {
    failStage(run.runId, 'agent', 'No intent parsed from output');
    completeRun(run.runId, 'failure', { error: 'No agent intent' });
    await markJobFailed(opts.jobId, 'no intent parsed').catch(() => {});
    return;
  }

  completeStage(run.runId, 'agent', `${intent.type} (resumed, ${agentMs}ms)`);
  setRunOutputs(run.runId, { agentOutput: intent.content });

  if (!event || !ctx?.classification) {
    completeRun(run.runId, 'failure', { error: 'Missing event/classification context' });
    await markJobFailed(opts.jobId, 'missing context').catch(() => {});
    return;
  }

  // Compose in Jane's voice
  beginStage(run.runId, 'composer');
  const composerStart = Date.now();
  const composedMessage = await compose({
    intent,
    senderName: event.sender?.displayName || 'User',
  }).catch(() => null);
  const composerMs = Date.now() - composerStart;

  if (!composedMessage) {
    failStage(run.runId, 'composer', 'Composer returned nothing');
    completeRun(run.runId, 'failure', { error: 'Composer returned nothing' });
    await markJobFailed(opts.jobId, 'composer returned nothing').catch(() => {});
    return;
  }

  completeStage(run.runId, 'composer', `${composerMs}ms`);
  setRunOutputs(run.runId, { composerOutput: composedMessage });

  // Publish outbound
  beginStage(run.runId, 'publish');
  const subject = `communication.outbound.${event.channelType}`;

  if (!opts.deps.nats?.isConnected()) {
    failStage(run.runId, 'publish', 'NATS not connected');
    completeRun(run.runId, 'failure', { error: 'NATS not connected' });
    const queueId = uuidv7();
    enqueueForRetry(subject, {
      id: queueId,
      parentId: event.id,
      sessionId: event.sessionId,
      channelType: event.channelType,
      direction: 'outbound',
      contentType: 'markdown',
      content: composedMessage,
      sender: { id: 'jane', displayName: 'Jane', type: 'agent' },
      metadata: { resumedFromAttached: true },
      timestamp: new Date().toISOString(),
    } as any, event.sessionId, queueId);
    await markJobFailed(opts.jobId, 'NATS not connected (queued for retry)').catch(() => {});
    return;
  }

  const responseEvent = {
    id: uuidv7(),
    parentId: event.id,
    sessionId: event.sessionId,
    channelType: event.channelType,
    direction: 'outbound' as const,
    contentType: 'markdown' as const,
    content: composedMessage,
    sender: { id: 'jane', displayName: 'Jane', type: 'agent' as const },
    recipients: event.sender
      ? [{ id: event.sender.id, displayName: event.sender.displayName, type: event.sender.type }]
      : [],
    metadata: { intentType: intent.type, tone: intent.tone, resumedFromAttached: true },
    timestamp: new Date().toISOString(),
  };

  try {
    await opts.deps.nats.publish(subject, responseEvent);
    opts.deps.safety?.recordSend();
    pushEvent(responseEvent as CommunicationEvent, subject);
    appendMessage(event.sessionId, {
      role: 'assistant',
      content: composedMessage,
      timestamp: responseEvent.timestamp,
      eventId: responseEvent.id,
      source: 'jane',
      source_type: 'agent',
    });

    await markJobCompleted(opts.jobId).catch(() => {});
    completeStage(run.runId, 'publish', responseEvent.id);
    completeRun(run.runId, 'success', { routeAction: 'reply' });
    recordPipelineOutcome({
      action: 'reply',
      responded: true,
      agentMs,
      composerMs,
      totalMs: Date.now() - pipelineStart,
    });

    console.log(JSON.stringify({
      level: 'info',
      msg: 'Resumed alive job — response sent',
      component: 'pipeline',
      jobId: opts.jobId,
      responseId: responseEvent.id,
      ts: new Date().toISOString(),
    }));
  } catch (err) {
    failStage(run.runId, 'publish', String(err));
    completeRun(run.runId, 'failure', { error: `Publish failed: ${err}` });
    enqueueForRetry(subject, responseEvent as any, event.sessionId, responseEvent.id);
    await markJobFailed(opts.jobId, `publish failed: ${err}`).catch(() => {});
  }
}
