/**
 * Pipeline -- routes inbound messages through the communication pipeline.
 * route -> safety -> context -> agent -> composer -> publish
 *
 * No classifier. Routing is sender-driven via CommunicationEvent fields.
 * All LLM calls go through invokeAdapter (same process, no HTTP/NATS hop).
 */

import { StringCodec } from 'nats';
import { uuidv7, COMMUNICATION_EVENT_VERSION } from '@the-ansible/life-system-shared';
import type { CommunicationEvent } from '@the-ansible/life-system-shared';
import type { NatsConnection } from 'nats';
import type { SafetyGate } from './safety/index.js';
import type { RoutingDecision, AgentIntent, PipelineResult } from './types.js';
import { routeEvent } from './router.js';
import { invokeAgent } from './agent.js';
import { compose } from './composer.js';
import { extractAndDispatchTask } from './task-extractor.js';
import { recordPipelineOutcome } from './pipeline-stats.js';
import { enqueueForRetry } from './outbound.js';
import { pushEvent } from './events.js';
import {
  startRun, beginStage, completeStage, failStage, completeRun, setRunOutputs,
} from './pipeline-runs.js';
import {
  getSession,
  appendMessage,
  needsCompaction,
} from './sessions/store.js';
import { assembleContext } from './context/assembler.js';
import { updateAssemblyOutcome } from './context/db.js';
import { compactAndIngest, searchMemory } from './graphiti.js';

const sc = StringCodec();

export interface PipelineDeps {
  nats: NatsConnection | null;
  safety: SafetyGate | null;
}

/**
 * Process an inbound event through the full communication pipeline.
 * Routing is sender-driven (no classifier).
 */
export async function processPipeline(
  event: CommunicationEvent,
  deps: PipelineDeps,
): Promise<PipelineResult> {
  const senderName = event.sender?.displayName || event.sender?.id || 'User';
  const routeStart = Date.now();

  // 1. Route based on event fields (sender-driven)
  const routing = routeEvent(event);

  const run = startRun({
    runId: event.id,
    sessionId: event.sessionId,
    channelType: event.channelType,
    senderName,
    contentPreview: event.content.slice(0, 120),
    routingProvenance: {
      action: routing.action,
      reason: routing.reason,
      targetRole: routing.targetRole,
      targetId: routing.targetId,
      latencyMs: Date.now() - routeStart,
    },
  });

  beginStage(run.runId, 'routing');

  // Active-session override: if routed to log but session has recent Jane activity,
  // override to converse so conversational follow-ups get responses.
  let effectiveRouting = routing;
  if (routing.action === 'log') {
    const session = getSession(event.sessionId);
    const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
    const hasRecentJaneActivity = session.messages.some(
      m => m.role === 'assistant' && new Date(m.timestamp).getTime() > tenMinutesAgo
    );
    if (hasRecentJaneActivity) {
      effectiveRouting = {
        ...routing,
        action: 'converse',
        reason: `active_session_override (was: log) -- ${routing.reason}`,
      };
    }
  }

  console.log(JSON.stringify({
    level: 'info',
    msg: 'Pipeline routing decision',
    component: 'comm.pipeline',
    eventId: event.id,
    action: effectiveRouting.action,
    reason: effectiveRouting.reason,
    ts: new Date().toISOString(),
  }));

  completeStage(run.runId, 'routing', effectiveRouting.action);

  // 2. Record inbound message in session
  appendMessage(event.sessionId, {
    role: 'user',
    content: event.content,
    timestamp: event.timestamp,
    eventId: event.id,
    sender: event.sender,
  });

  // Compact + ingest to Graphiti when session exceeds threshold (fire-and-forget)
  if (needsCompaction(event.sessionId)) {
    compactAndIngest(event.sessionId, deps.nats).catch((err) => {
      console.log(JSON.stringify({
        level: 'warn',
        msg: 'Session compaction failed',
        sessionId: event.sessionId,
        error: String(err),
        component: 'comm.pipeline',
        ts: new Date().toISOString(),
      }));
    });
  }

  // 3. Dispatch based on route decision
  const pipelineStart = Date.now();

  switch (effectiveRouting.action) {
    case 'log': {
      const result: PipelineResult = { action: 'log', reason: effectiveRouting.reason, responded: false };
      recordPipelineOutcome({ action: 'log', responded: false, totalMs: Date.now() - pipelineStart });
      completeRun(run.runId, 'success', { routeAction: 'log' });
      return result;
    }

    case 'converse':
    case 'direct': {
      return handleAgentResponse(event, effectiveRouting, senderName, deps, pipelineStart, run.runId);
    }

    default: {
      const result: PipelineResult = { action: effectiveRouting.action, reason: effectiveRouting.reason, responded: false };
      recordPipelineOutcome({ action: effectiveRouting.action, responded: false, totalMs: Date.now() - pipelineStart });
      completeRun(run.runId, 'success', { routeAction: effectiveRouting.action });
      return result;
    }
  }
}

async function handleAgentResponse(
  event: CommunicationEvent,
  routing: RoutingDecision,
  senderName: string,
  deps: PipelineDeps,
  pipelineStart: number,
  runId: string,
): Promise<PipelineResult> {
  // Safety check before LLM calls
  beginStage(runId, 'safety_check');
  if (deps.safety) {
    const check = deps.safety.canCallLlm(event.channelType);
    if (!check.allowed) {
      const errorMsg = 'Blocked by safety: ' + check.reasons.join(', ');
      failStage(runId, 'safety_check', errorMsg);
      completeRun(runId, 'failure', { routeAction: routing.action, error: errorMsg });
      recordPipelineOutcome({
        action: routing.action, responded: false, totalMs: Date.now() - pipelineStart,
        error: 'Blocked by safety',
      });
      return { action: routing.action, reason: errorMsg, responded: false };
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
      component: 'comm.pipeline',
      factCount: graphitiMemory.length,
      ts: new Date().toISOString(),
    }));
  }

  // 4. Invoke Agent
  beginStage(runId, 'agent');
  deps.safety?.recordLlmCall(event.channelType);

  const agentStart = Date.now();
  const { intent } = await invokeAgent({
    content: event.content,
    senderName,
    routing,
    assembledContext: agentContext,
    graphitiMemory,
  });
  const agentMs = Date.now() - agentStart;

  if (!intent) {
    const agentError = 'Agent returned no intent';
    failStage(runId, 'agent', agentError);
    completeRun(runId, 'failure', { routeAction: routing.action, error: agentError });
    await updateAssemblyOutcome(agentContext.meta.assemblyLogId, false).catch((err) => pipelineLog('warn', 'Failed to update assembly outcome', { error: String(err) }));
    recordPipelineOutcome({
      action: routing.action, responded: false, agentMs, totalMs: Date.now() - pipelineStart,
      error: agentError,
    });
    return {
      action: routing.action, reason: routing.reason, responded: false,
      agentIntent: null, error: agentError,
    };
  }
  completeStage(runId, 'agent', `${intent.type} (${agentMs}ms)`);
  setRunOutputs(runId, { agentOutput: intent.content });

  // 5. Compose in Jane's voice
  beginStage(runId, 'composer');
  deps.safety?.recordLlmCall(event.channelType);
  const composerStart = Date.now();
  const composedMessage = await compose({ intent, senderName });
  const composerMs = Date.now() - composerStart;

  if (!composedMessage) {
    const composerError = 'Composer returned no message';
    failStage(runId, 'composer', composerError);
    completeRun(runId, 'failure', { routeAction: routing.action, error: composerError });
    await updateAssemblyOutcome(agentContext.meta.assemblyLogId, false).catch((err) => pipelineLog('warn', 'Failed to update assembly outcome', { error: String(err) }));
    recordPipelineOutcome({
      action: routing.action, responded: false, agentMs, composerMs, totalMs: Date.now() - pipelineStart,
      error: composerError,
    });
    return {
      action: routing.action, reason: routing.reason, responded: false,
      agentIntent: intent, error: composerError,
    };
  }
  completeStage(runId, 'composer', `${composerMs}ms`);
  setRunOutputs(runId, { composerOutput: composedMessage });

  // 5.5 Dispatch task (fire-and-forget)
  if (deps.nats) {
    if (intent.task?.description) {
      // Fast path: agent already identified the task
      const taskRequest = {
        type: intent.task.type ?? 'task',
        prompt: intent.task.description,
        role: 'executor',
        runtime: { tool: 'claude-code', model: 'sonnet' },
        context: {
          triggeredBy: 'conversation',
          eventId: event.id,
          sessionId: event.sessionId,
          senderName,
        },
      };
      deps.nats.publish('agent.jobs.request', sc.encode(JSON.stringify(taskRequest)));
      console.log(JSON.stringify({
        level: 'info',
        msg: 'Task dispatched (agent intent)',
        component: 'comm.pipeline',
        eventId: event.id,
        taskType: taskRequest.type,
        descriptionPreview: intent.task.description.slice(0, 120),
        ts: new Date().toISOString(),
      }));
    } else {
      // Fallback: use Mercury to analyze composed reply for implicit tasks
      const nats = deps.nats;
      extractAndDispatchTask(
        {
          composedMessage,
          inboundMessage: event.content,
          senderName,
          sessionId: event.sessionId,
          eventId: event.id,
        },
        (jobRequest) => {
          nats.publish('agent.jobs.request', sc.encode(JSON.stringify(jobRequest)));
        }
      ).catch((err) => pipelineLog('warn', 'Failed to dispatch task extraction', { error: String(err) }));
    }
  }

  // 6. Publish outbound response
  beginStage(runId, 'publish');
  if (!deps.nats) {
    const natsError = 'NATS not connected';
    failStage(runId, 'publish', natsError);
    completeRun(runId, 'failure', { routeAction: routing.action, error: natsError });
    recordPipelineOutcome({
      action: routing.action, responded: false, agentMs, composerMs, totalMs: Date.now() - pipelineStart,
      error: natsError,
    });
    return {
      action: routing.action, reason: routing.reason, responded: false,
      agentIntent: intent, error: natsError,
    };
  }

  const responseEvent = {
    v: COMMUNICATION_EVENT_VERSION,
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
      routingAction: routing.action,
    },
    timestamp: new Date().toISOString(),
  };

  const subject = `communication.outbound.${event.channelType}`;

  try {
    const data = sc.encode(JSON.stringify(responseEvent));
    deps.nats.publish(subject, data);
    deps.safety?.recordSend();
    pushEvent(responseEvent as CommunicationEvent, subject);

    appendMessage(event.sessionId, {
      role: 'assistant',
      content: composedMessage,
      timestamp: responseEvent.timestamp,
      eventId: responseEvent.id,
      sender: { id: 'jane', displayName: 'Jane', type: 'agent' },
    });

    console.log(JSON.stringify({
      level: 'info',
      msg: 'Pipeline response sent',
      component: 'comm.pipeline',
      eventId: event.id,
      responseId: responseEvent.id,
      subject,
      intentType: intent.type,
      ts: new Date().toISOString(),
    }));

    await updateAssemblyOutcome(agentContext.meta.assemblyLogId, true).catch((err) => pipelineLog('warn', 'Failed to update assembly outcome', { error: String(err) }));
    completeStage(runId, 'publish', responseEvent.id);
    completeRun(runId, 'success', { routeAction: routing.action });

    recordPipelineOutcome({
      action: routing.action, responded: true, agentMs, composerMs, totalMs: Date.now() - pipelineStart,
    });

    return {
      action: routing.action, reason: routing.reason, responded: true,
      responseEventId: responseEvent.id, agentIntent: intent,
    };
  } catch (err) {
    console.log(JSON.stringify({
      level: 'error',
      msg: 'Failed to publish response, queuing for retry',
      component: 'comm.pipeline',
      eventId: event.id,
      responseId: responseEvent.id,
      error: String(err),
      ts: new Date().toISOString(),
    }));

    enqueueForRetry(subject, responseEvent, event.sessionId, responseEvent.id);

    failStage(runId, 'publish', String(err));
    completeRun(runId, 'failure', { routeAction: routing.action, error: `Publish failed: ${err}` });

    recordPipelineOutcome({
      action: routing.action, responded: false, agentMs, composerMs, totalMs: Date.now() - pipelineStart,
      error: `Publish failed (queued for retry): ${err}`,
    });

    return {
      action: routing.action, reason: routing.reason, responded: false,
      agentIntent: intent, error: `Publish failed (queued for retry): ${err}`,
    };
  }
}
