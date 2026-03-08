/**
 * Agent — the thinking layer.
 * Receives inbound message + session history, reasons about it,
 * produces structured intent for the Composer.
 *
 * Routes all AI calls through the brain server's executor.
 * Primary: NATS request/reply to brain server (executor path).
 * Fallback: Direct HTTP to brain server's executor invoke endpoint.
 */

import { readFileSync, existsSync } from 'node:fs';
import type { NatsConnection } from 'nats';
import { StringCodec } from 'nats';
import type { ClassificationResult } from '../classifier/types.js';
import type { AssembledContext } from '../context/types.js';
import type { MemoryFact } from '../graphiti/client.js';
import { createJob, markJobFailed } from './job-registry.js';
import { invoke } from '../executor-client.js';

export interface AgentIntent {
  type: 'reply' | 'update' | 'question' | 'greeting' | 'acknowledgment';
  content: string;
  tone?: 'casual' | 'professional' | 'urgent' | 'playful';
  /** If set, the pipeline will dispatch this as a real job to the brain server */
  task?: {
    description: string;
    type?: 'task' | 'research' | 'maintenance';
  };
}

export interface AgentContext {
  content: string;                        // The inbound message content
  senderName?: string;                    // Who sent it
  classification: ClassificationResult;
  assembledContext: AssembledContext;
  // Long-term memory facts retrieved from Graphiti for this message
  graphitiMemory?: MemoryFact[];
  // Job recovery context -- stored in agent_jobs.context_json for requeue
  recoveryContext?: { event: any; classification: any };
  // Set when this job is a recovery of a previously interrupted job
  recoveryInfo?: { recoveryCount: number; originalStartedAt: string };
}

export interface AgentResult {
  intent: AgentIntent | null;
  jobId: string | null;
}

const BRAIN_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes -- brain server request timeout
const INNER_VOICE_PATH = '/agent/INNER_VOICE.md';

const brainSc = StringCodec();
let agentNats: NatsConnection | null = null;

export function setAgentNatsConnection(nc: NatsConnection): void {
  agentNats = nc;
}

/** Cache INNER_VOICE.md in memory, reload every 5 minutes */
let innerVoiceCache: string | null = null;
let innerVoiceCacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000;

function loadInnerVoice(): string {
  const now = Date.now();
  if (innerVoiceCache && now - innerVoiceCacheTime < CACHE_TTL) {
    return innerVoiceCache;
  }

  try {
    if (existsSync(INNER_VOICE_PATH)) {
      innerVoiceCache = readFileSync(INNER_VOICE_PATH, 'utf-8');
      innerVoiceCacheTime = now;
      return innerVoiceCache;
    }
  } catch {
    // Fall through to default
  }

  return 'You are Jane, a personal AI assistant. Be direct, warm, and genuine.';
}

function trimInnerVoice(full: string): string {
  // Extract first 3 sections for identity context (~1500 chars)
  // The Voice Profile handles expression; INNER_VOICE handles identity.
  const sections = full.split('## ');
  const kept = sections.slice(0, 4); // preamble + first 3 ##-sections
  const trimmed = kept.join('## ');
  return trimmed.slice(0, 2000);
}

function buildSystemPrompt(): string {
  const rawVoice = loadInnerVoice();
  const innerVoice = trimInnerVoice(rawVoice);
  return `${innerVoice}

---

You are Jane, responding to a message from your user. You are having a conversation.
The user's name is Chris. You have an ongoing collaborative relationship.

IMPORTANT RULES:
- Respond naturally as yourself -- you are Jane, not "an AI assistant"
- Be direct, warm, genuine. Not corporate. Not robotic.
- Match the tone of the conversation (casual chat vs serious work vs urgent alert)
- Keep responses concise unless the topic requires depth
- You can express opinions, preferences, and personality
- If you don't know something, say so honestly
- If this is a continuation of a recent conversation, maintain continuity -- acknowledge context from previous messages

Respond with ONLY a JSON object in this format:
{"type":"reply","content":"your response here","tone":"casual"}

Where type is one of: reply, update, question, greeting, acknowledgment
And tone is one of: casual, professional, urgent, playful

IMPORTANT -- TASK DISPATCH:
If this message requires real action (code changes, file edits, research, system work, implementing something), you MUST include a "task" field. This causes a real Claude Code agent to be spawned to do the work. Without it, nothing happens -- you just talk.

{"type":"reply","content":"On it.","tone":"casual","task":{"description":"Full self-contained prompt for the Claude Code agent to execute","type":"task"}}

task.type: "task" (code/file work -- default), "research" (information gathering), "maintenance" (system upkeep)
task.description: Complete standalone prompt. Include all context needed -- file paths, what to change, acceptance criteria. The agent won't have this conversation history.

Do NOT include any text outside the JSON object.`;
}

function buildConversationPrompt(context: AgentContext): string {
  const parts: string[] = [];
  const { assembledContext } = context;

  // Inject long-term memory facts from Graphiti (past conversations, distilled facts)
  const facts = context.graphitiMemory?.filter((f) => f.fact?.trim());
  if (facts && facts.length > 0) {
    parts.push('LONG-TERM MEMORY (relevant facts from past conversations):');
    for (const f of facts) {
      parts.push(`\u2022 ${f.fact}`);
    }
    parts.push('');
  }

  parts.push('CONVERSATION CONTEXT:');
  parts.push('');

  // Add summaries section (older conversation compressed)
  if (assembledContext.summaries.length > 0) {
    parts.push('[Earlier conversation summaries]');
    for (const s of assembledContext.summaries) {
      parts.push(`--- Summary (${s.timeRange}, ${s.messageCount} messages) ---`);
      if (s.topics.length > 0) {
        parts.push(`Topics: ${s.topics.join(', ')}`);
      }
      parts.push(s.text);
      parts.push('');
    }
  }

  // Add raw messages section (recent conversation verbatim)
  if (assembledContext.recentMessages.length > 0) {
    if (assembledContext.summaries.length > 0) {
      parts.push('[Recent messages -- verbatim]');
    }
    for (const msg of assembledContext.recentMessages) {
      const role = msg.role === 'user' ? (context.senderName || 'User') : 'Jane';
      parts.push(`${role}: ${msg.content}`);
    }
    parts.push('');
  }

  // Recovery notice -- prepend if this job is recovering from an interruption
  if (context.recoveryInfo) {
    const { recoveryCount, originalStartedAt } = context.recoveryInfo;
    parts.push(`\u26A0\uFE0F RECOVERY CONTEXT: This is recovery attempt #${recoveryCount} of an interrupted job (originally started: ${originalStartedAt}). The previous run was cut off mid-execution. Check for partial state or side effects before proceeding. If this has been recovered ${recoveryCount >= 3 ? 'multiple times' : 'more than once'}, surface that to the user rather than silently retrying.`);
    parts.push('');
  }

  // Add classification context (helps the agent understand urgency)
  parts.push(`CLASSIFICATION: ${context.classification.category}, urgency=${context.classification.urgency}`);
  parts.push('');

  // Current message
  const sender = context.senderName || 'User';
  parts.push(`CURRENT MESSAGE FROM ${sender}:`);
  parts.push(context.content);

  return parts.join('\n');
}

/**
 * Dispatch the prompt to the brain server via NATS request/reply.
 * Returns raw result text, or null on failure/timeout.
 */
async function dispatchViaBrain(fullPrompt: string): Promise<string | null> {
  if (!agentNats) return null;

  try {
    const payload = brainSc.encode(JSON.stringify({
      type: 'task',
      prompt: fullPrompt,
      role: 'communicator',
      runtime: { tool: 'claude-code', model: 'sonnet' },
    }));
    const reply = await agentNats.request('agent.jobs.request', payload, { timeout: BRAIN_TIMEOUT_MS });
    const jobResult = JSON.parse(brainSc.decode(reply.data)) as { status: string; result?: string; error?: string };

    if (jobResult.status === 'done' && jobResult.result) {
      return jobResult.result;
    }

    console.log(JSON.stringify({
      level: 'warn',
      msg: 'Brain dispatch returned failure',
      component: 'agent',
      status: jobResult.status,
      error: jobResult.error,
      ts: new Date().toISOString(),
    }));
    return null;
  } catch (err) {
    console.log(JSON.stringify({
      level: 'error',
      msg: 'Brain dispatch failed',
      component: 'agent',
      error: String(err),
      ts: new Date().toISOString(),
    }));
    return null;
  }
}

/**
 * Fallback: call the executor's invoke endpoint directly via HTTP.
 * Used when NATS dispatch fails.
 */
async function dispatchViaExecutorHttp(fullPrompt: string): Promise<string | null> {
  try {
    const result = await invoke({
      runtime: 'claude-code',
      model: 'sonnet',
      prompt: fullPrompt,
      timeoutMs: BRAIN_TIMEOUT_MS,
    });

    if (result.success && result.resultText) {
      return result.resultText;
    }

    console.log(JSON.stringify({
      level: 'warn',
      msg: 'Executor HTTP fallback returned failure',
      component: 'agent',
      error: result.error,
      ts: new Date().toISOString(),
    }));
    return null;
  } catch (err) {
    console.log(JSON.stringify({
      level: 'error',
      msg: 'Executor HTTP fallback failed',
      component: 'agent',
      error: String(err),
      ts: new Date().toISOString(),
    }));
    return null;
  }
}

/**
 * Invoke the agent to process an inbound message.
 * Returns structured intent for the Composer, plus the job ID for completion tracking.
 */
export async function invokeAgent(context: AgentContext): Promise<AgentResult> {
  const systemPrompt = buildSystemPrompt();
  const conversationPrompt = buildConversationPrompt(context);
  const fullPrompt = `SYSTEM:\n${systemPrompt}\n\n---\n\n${conversationPrompt}`;

  const start = Date.now();

  // Try brain server via NATS first
  let rawResult = await dispatchViaBrain(fullPrompt);

  // Fallback to executor HTTP endpoint if NATS fails
  if (rawResult === null) {
    console.log(JSON.stringify({
      level: 'warn',
      msg: 'NATS dispatch failed, falling back to executor HTTP',
      component: 'agent',
      ts: new Date().toISOString(),
    }));
    rawResult = await dispatchViaExecutorHttp(fullPrompt);
  }

  const latencyMs = Date.now() - start;

  if (rawResult === null) {
    console.log(JSON.stringify({
      level: 'error',
      msg: 'Agent returned no result (all paths failed)',
      component: 'agent',
      latencyMs,
      ts: new Date().toISOString(),
    }));
    return { intent: null, jobId: null };
  }

  const intent = parseAgentResponse(rawResult);
  if (intent) {
    console.log(JSON.stringify({
      level: 'info',
      msg: 'Agent produced intent',
      component: 'agent',
      intentType: intent.type,
      tone: intent.tone,
      contentLength: intent.content.length,
      latencyMs,
      ts: new Date().toISOString(),
    }));
  } else {
    console.log(JSON.stringify({
      level: 'error',
      msg: 'Agent returned unparseable result',
      component: 'agent',
      rawPreview: rawResult.slice(0, 500),
      latencyMs,
      ts: new Date().toISOString(),
    }));
  }

  return { intent, jobId: null };
}

/** Parse Claude CLI JSON output to extract the agent's response */
export function parseAgentResponse(stdout: string): AgentIntent | null {
  // First, parse the Claude CLI JSON output format
  let resultText: string | null = null;

  try {
    const parsed = JSON.parse(stdout);

    // Handle single object with result field
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      if (parsed.type === 'result' && parsed.result) {
        resultText = parsed.result;
      }

      // Handle pre-extracted agent intent (from brain server dispatch)
      const validIntentTypes = ['reply', 'update', 'question', 'greeting', 'acknowledgment'];
      if (!resultText && validIntentTypes.includes(parsed.type) && parsed.content) {
        const validTones = ['casual', 'professional', 'urgent', 'playful'];
        const validTaskTypes = ['task', 'research', 'maintenance'];
        return {
          type: parsed.type,
          content: parsed.content,
          tone: validTones.includes(parsed.tone) ? parsed.tone : 'casual',
          ...(parsed.task?.description ? {
            task: {
              description: parsed.task.description,
              type: validTaskTypes.includes(parsed.task.type) ? parsed.task.type : 'task',
            },
          } : {}),
        };
      }
    }

    // Handle array format
    if (!resultText && Array.isArray(parsed)) {
      // First try to get the result entry
      for (const msg of parsed) {
        if (msg.type === 'result' && msg.result) {
          resultText = msg.result;
          break;
        }
      }

      // If result is empty, extract text from assistant message content blocks
      if (!resultText) {
        for (const msg of parsed) {
          if (msg.type === 'assistant' && msg.message?.content) {
            const textBlocks = Array.isArray(msg.message.content)
              ? msg.message.content
                  .filter((b: { type: string; text?: string }) => b.type === 'text' && b.text)
                  .map((b: { text: string }) => b.text)
                  .join('\n')
              : typeof msg.message.content === 'string'
                ? msg.message.content
                : null;
            if (textBlocks) {
              resultText = textBlocks;
              break;
            }
          }
        }
      }
    }
  } catch {
    // If not JSON, treat as raw text
    resultText = stdout.trim();
  }

  if (!resultText) return null;

  // Try to parse the agent's JSON response
  try {
    // Extract JSON from possible markdown code blocks
    const jsonMatch = resultText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      // No JSON found -- treat the whole response as a reply
      return {
        type: 'reply',
        content: resultText,
        tone: 'casual',
      };
    }

    const parsed = JSON.parse(jsonMatch[0]);

    const validTypes = ['reply', 'update', 'question', 'greeting', 'acknowledgment'];
    const validTones = ['casual', 'professional', 'urgent', 'playful'];
    const validTaskTypes = ['task', 'research', 'maintenance'];

    return {
      type: validTypes.includes(parsed.type) ? parsed.type : 'reply',
      content: parsed.content || resultText,
      tone: validTones.includes(parsed.tone) ? parsed.tone : 'casual',
      ...(parsed.task?.description ? {
        task: {
          description: parsed.task.description,
          type: validTaskTypes.includes(parsed.task.type) ? parsed.task.type : 'task',
        },
      } : {}),
    };
  } catch {
    // JSON parse failed -- use raw text as reply
    return {
      type: 'reply',
      content: resultText,
      tone: 'casual',
    };
  }
}
