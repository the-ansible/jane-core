/**
 * Agent -- the thinking layer.
 * Receives inbound message + session history, reasons about it,
 * produces structured intent for the Composer.
 *
 * Calls invokeAdapter() directly (same process, no HTTP/NATS hop).
 */

import { readFileSync, existsSync } from 'node:fs';
import type { AssembledContext } from './context/types.js';
import type { AgentIntent, RoutingDecision } from './types.js';
import type { MemoryFact } from './types.js';
import { invokeAdapter } from '../executor/index.js';

export interface AgentContext {
  content: string;
  senderName?: string;
  routing: RoutingDecision;
  assembledContext: AssembledContext;
  graphitiMemory?: MemoryFact[];
  recoveryInfo?: { recoveryCount: number; originalStartedAt: string };
}

export interface AgentResult {
  intent: AgentIntent | null;
}

const INNER_VOICE_PATH = '/agent/INNER_VOICE.md';

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
  const sections = full.split('## ');
  const kept = sections.slice(0, 4);
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

  // Inject long-term memory facts from Graphiti
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

  if (context.recoveryInfo) {
    const { recoveryCount, originalStartedAt } = context.recoveryInfo;
    parts.push(`\u26A0\uFE0F RECOVERY CONTEXT: This is recovery attempt #${recoveryCount} of an interrupted job (originally started: ${originalStartedAt}). The previous run was cut off mid-execution. Check for partial state or side effects before proceeding. If this has been recovered ${recoveryCount >= 3 ? 'multiple times' : 'more than once'}, surface that to the user rather than silently retrying.`);
    parts.push('');
  }

  // Routing context (replaces old classification context)
  parts.push(`ROUTING: action=${context.routing.action}, reason=${context.routing.reason}`);
  if (context.routing.targetRole) {
    parts.push(`TARGET ROLE: ${context.routing.targetRole}`);
  }
  parts.push('');

  const sender = context.senderName || 'User';
  parts.push(`CURRENT MESSAGE FROM ${sender}:`);
  parts.push(context.content);

  return parts.join('\n');
}

/**
 * Invoke the agent to process an inbound message.
 * Calls invokeAdapter directly (no NATS/HTTP dispatch).
 */
export async function invokeAgent(context: AgentContext): Promise<AgentResult> {
  const systemPrompt = buildSystemPrompt();
  const conversationPrompt = buildConversationPrompt(context);
  const fullPrompt = `SYSTEM:\n${systemPrompt}\n\n---\n\n${conversationPrompt}`;

  const start = Date.now();

  try {
    const result = await invokeAdapter({
      runtime: 'claude-code',
      model: 'sonnet',
      prompt: fullPrompt,
    });

    const latencyMs = Date.now() - start;

    if (!result.success || !result.resultText) {
      console.log(JSON.stringify({
        level: 'error',
        msg: 'Agent adapter returned no result',
        component: 'comm.agent',
        error: result.error,
        latencyMs,
        ts: new Date().toISOString(),
      }));
      return { intent: null };
    }

    const intent = parseAgentResponse(result.resultText);
    if (intent) {
      console.log(JSON.stringify({
        level: 'info',
        msg: 'Agent produced intent',
        component: 'comm.agent',
        intentType: intent.type,
        tone: intent.tone,
        contentLength: intent.content.length,
        hasTask: !!intent.task,
        latencyMs,
        ts: new Date().toISOString(),
      }));
    } else {
      console.log(JSON.stringify({
        level: 'error',
        msg: 'Agent returned unparseable result',
        component: 'comm.agent',
        rawPreview: result.resultText.slice(0, 500),
        latencyMs,
        ts: new Date().toISOString(),
      }));
    }

    return { intent };
  } catch (err) {
    console.log(JSON.stringify({
      level: 'error',
      msg: 'Agent invocation failed',
      component: 'comm.agent',
      error: String(err),
      latencyMs: Date.now() - start,
      ts: new Date().toISOString(),
    }));
    return { intent: null };
  }
}

/** Parse agent output to extract structured intent */
export function parseAgentResponse(stdout: string): AgentIntent | null {
  let resultText: string | null = null;

  try {
    const parsed = JSON.parse(stdout);

    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      if (parsed.type === 'result' && parsed.result) {
        resultText = parsed.result;
      }

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

    if (!resultText && Array.isArray(parsed)) {
      for (const msg of parsed) {
        if (msg.type === 'result' && msg.result) {
          resultText = msg.result;
          break;
        }
      }

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
    resultText = stdout.trim();
  }

  if (!resultText) return null;

  try {
    const jsonMatch = resultText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { type: 'reply', content: resultText, tone: 'casual' };
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
    return { type: 'reply', content: resultText, tone: 'casual' };
  }
}
