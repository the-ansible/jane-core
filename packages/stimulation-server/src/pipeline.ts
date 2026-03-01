/**
 * Pipeline — wires classifier → router → agent → composer → NATS outbound.
 * This is the main processing pipeline for inbound communication events.
 */

import { uuidv7 } from '@the-ansible/life-system-shared';
import type { CommunicationEvent } from '@the-ansible/life-system-shared';
import type { ClassificationResult } from './classifier/types.js';
import type { NatsClient } from './nats/client.js';
import type { SafetyGate } from './safety/index.js';
import { route, type RouteDecision } from './router/index.js';
import { invokeAgent, type AgentIntent } from './agent/index.js';
import { compose } from './composer/index.js';
import { recordPipelineOutcome } from './pipeline-stats.js';
import { enqueueForRetry } from './outbound-queue.js';
import {
  getSession,
  appendMessage,
  getContextMessages,
  needsCompaction,
  compactSession,
  type SessionMessage,
} from './sessions/store.js';

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
  deps: PipelineDeps
): Promise<PipelineResult> {
  // 1. Route based on classification
  const decision = route(classification);

  console.log(JSON.stringify({
    level: 'info',
    msg: 'Pipeline routing decision',
    component: 'pipeline',
    eventId: event.id,
    action: decision.action,
    reason: decision.reason,
    ts: new Date().toISOString(),
  }));

  // 2. Record inbound message in session
  const senderName = event.sender?.displayName || event.sender?.id || 'User';
  appendMessage(event.sessionId, {
    role: 'user',
    content: event.content,
    timestamp: event.timestamp,
    eventId: event.id,
  });

  // 3. Dispatch based on route decision
  const pipelineStart = Date.now();

  switch (decision.action) {
    case 'log': {
      const result = { action: 'log', reason: decision.reason, responded: false };
      recordPipelineOutcome({ action: 'log', responded: false, totalMs: Date.now() - pipelineStart });
      return result;
    }

    case 'reply':
    case 'think':
    case 'escalate': {
      const result = await handleAgentResponse(event, classification, decision, senderName, deps, pipelineStart);
      return result;
    }

    default: {
      const result = { action: decision.action, reason: decision.reason, responded: false };
      recordPipelineOutcome({ action: decision.action, responded: false, totalMs: Date.now() - pipelineStart });
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
  pipelineStart: number
): Promise<PipelineResult> {
  // Safety check before Claude calls
  if (deps.safety) {
    const claudeCheck = deps.safety.canCallClaude(event.channelType);
    if (!claudeCheck.allowed) {
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
        reason: 'Blocked by safety: ' + claudeCheck.reasons.join(', '),
        responded: false,
      };
    }
  }

  // Get session context
  const sessionHistory = getContextMessages(event.sessionId);

  // 4. Invoke Agent
  deps.safety?.recordLlmCall('claude', event.channelType);
  const agentStart = Date.now();
  const intent = await invokeAgent({
    content: event.content,
    senderName,
    classification,
    sessionHistory,
  });
  const agentMs = Date.now() - agentStart;

  if (!intent) {
    recordPipelineOutcome({
      action: decision.action, responded: false, agentMs, totalMs: Date.now() - pipelineStart,
      error: 'Agent returned no intent',
    });
    return {
      action: decision.action,
      reason: decision.reason,
      responded: false,
      agentIntent: null,
      error: 'Agent returned no intent',
    };
  }

  // 5. Compose in Jane's voice
  deps.safety?.recordLlmCall('claude', event.channelType);
  const composerStart = Date.now();
  const composedMessage = await compose({
    intent,
    sessionHistory,
    senderName,
  });
  const composerMs = Date.now() - composerStart;

  if (!composedMessage) {
    recordPipelineOutcome({
      action: decision.action, responded: false, agentMs, composerMs, totalMs: Date.now() - pipelineStart,
      error: 'Composer returned no message',
    });
    return {
      action: decision.action,
      reason: decision.reason,
      responded: false,
      agentIntent: intent,
      error: 'Composer returned no message',
    };
  }

  // 6. Publish outbound response
  if (!deps.nats?.isConnected()) {
    recordPipelineOutcome({
      action: decision.action, responded: false, agentMs, composerMs, totalMs: Date.now() - pipelineStart,
      error: 'NATS not connected',
    });
    return {
      action: decision.action,
      reason: decision.reason,
      responded: false,
      agentIntent: intent,
      error: 'NATS not connected',
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

    // Record outbound in session
    appendMessage(event.sessionId, {
      role: 'assistant',
      content: composedMessage,
      timestamp: responseEvent.timestamp,
      eventId: responseEvent.id,
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

    // Check if session needs compaction (async, don't block)
    if (needsCompaction(event.sessionId)) {
      compactSession(event.sessionId, summarizeMessages).catch((err) => {
        console.log(JSON.stringify({
          level: 'error',
          msg: 'Session compaction failed',
          component: 'pipeline',
          sessionId: event.sessionId,
          error: String(err),
          ts: new Date().toISOString(),
        }));
      });
    }

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
 * Simple summarizer for session compaction.
 * Uses Ollama for free, fast summarization.
 */
async function summarizeMessages(messages: SessionMessage[]): Promise<string> {
  const OLLAMA_URL = process.env.OLLAMA_URL || 'http://host.docker.internal:11434';

  const conversationText = messages
    .map(m => `${m.role}: ${m.content}`)
    .join('\n');

  try {
    const response = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.OLLAMA_SUMMARIZER_MODEL || 'gemma3:4b',
        prompt: `Summarize this conversation concisely, preserving key facts, decisions, and context:\n\n${conversationText}\n\nSummary:`,
        stream: false,
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama returned ${response.status}`);
    }

    const data = await response.json() as { response: string };
    return data.response;
  } catch (err) {
    console.log(JSON.stringify({
      level: 'warn',
      msg: 'Ollama summarization failed, using naive truncation',
      component: 'pipeline',
      error: String(err),
      ts: new Date().toISOString(),
    }));

    // Fallback: just keep the last few messages as a crude summary
    return messages.slice(-5).map(m => `${m.role}: ${m.content}`).join('\n');
  }
}
