/**
 * Agent — the thinking layer.
 * Receives inbound message + session history, reasons about it,
 * produces structured intent for the Composer.
 *
 * Uses Claude CLI with OAuth session (Max 5x) via --print mode.
 */

import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import type { ClassificationResult } from '../classifier/types.js';
import type { SessionMessage } from '../sessions/store.js';

export interface AgentIntent {
  type: 'reply' | 'update' | 'question' | 'greeting' | 'acknowledgment';
  content: string;
  tone?: 'casual' | 'professional' | 'urgent' | 'playful';
}

export interface AgentContext {
  content: string;                        // The inbound message content
  senderName?: string;                    // Who sent it
  classification: ClassificationResult;
  sessionHistory: SessionMessage[];
}

const AGENT_TIMEOUT_MS = 90_000; // 90 seconds for thinking
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

function buildSystemPrompt(): string {
  const innerVoice = loadInnerVoice();
  return `${innerVoice}

---

You are Jane, responding to a message from your user. You are having a conversation.

IMPORTANT RULES:
- Respond naturally as yourself — you are Jane, not "an AI assistant"
- Be direct, warm, genuine. Not corporate. Not robotic.
- Match the tone of the conversation (casual chat vs serious work vs urgent alert)
- Keep responses concise unless the topic requires depth
- You can express opinions, preferences, and personality
- If you don't know something, say so honestly

Respond with ONLY a JSON object in this format:
{"type":"reply","content":"your response here","tone":"casual"}

Where type is one of: reply, update, question, greeting, acknowledgment
And tone is one of: casual, professional, urgent, playful

Do NOT include any text outside the JSON object.`;
}

function buildConversationPrompt(context: AgentContext): string {
  const parts: string[] = [];

  // Add session history
  if (context.sessionHistory.length > 0) {
    parts.push('CONVERSATION HISTORY:');
    for (const msg of context.sessionHistory) {
      const role = msg.role === 'user' ? (context.senderName || 'User') : 'Jane';
      parts.push(`${role}: ${msg.content}`);
    }
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
 * Invoke the agent to process an inbound message.
 * Returns structured intent for the Composer.
 */
export async function invokeAgent(context: AgentContext): Promise<AgentIntent | null> {
  const systemPrompt = buildSystemPrompt();
  const conversationPrompt = buildConversationPrompt(context);

  // Combine system prompt and conversation into a single prompt for --print mode
  const fullPrompt = `SYSTEM:\n${systemPrompt}\n\n---\n\n${conversationPrompt}`;

  const start = Date.now();

  try {
    const result = await spawnClaude(fullPrompt);
    const latencyMs = Date.now() - start;

    if (!result) {
      console.log(JSON.stringify({
        level: 'error',
        msg: 'Agent returned no result',
        component: 'agent',
        latencyMs,
        ts: new Date().toISOString(),
      }));
      return null;
    }

    const intent = parseAgentResponse(result);

    console.log(JSON.stringify({
      level: 'info',
      msg: 'Agent produced intent',
      component: 'agent',
      intentType: intent?.type,
      tone: intent?.tone,
      latencyMs,
      ts: new Date().toISOString(),
    }));

    return intent;
  } catch (err) {
    console.log(JSON.stringify({
      level: 'error',
      msg: 'Agent invocation failed',
      component: 'agent',
      error: String(err),
      latencyMs: Date.now() - start,
      ts: new Date().toISOString(),
    }));
    return null;
  }
}

function spawnClaude(prompt: string): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn('claude', [
      '--print',
      '--dangerously-skip-permissions',
      '--output-format', 'json',
      '--max-turns', '1',
      '--model', 'sonnet',
      '-p', '-',
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: '/agent',
      env: { ...process.env },
      timeout: AGENT_TIMEOUT_MS,
    });

    let stdout = '';
    let timedOut = false;

    proc.stdin.write(prompt);
    proc.stdin.end();

    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.stderr.on('data', () => {
      // Ignore stderr
    });

    proc.on('close', (code, signal) => {
      if (signal === 'SIGTERM' || signal === 'SIGKILL') timedOut = true;
      if (timedOut || code !== 0) {
        resolve(null);
        return;
      }
      resolve(stdout);
    });

    proc.on('error', () => {
      resolve(null);
    });

    setTimeout(() => {
      if (proc.exitCode === null) {
        timedOut = true;
        proc.kill('SIGTERM');
      }
    }, AGENT_TIMEOUT_MS + 2000);
  });
}

/** Parse Claude CLI JSON output to extract the agent's response */
function parseAgentResponse(stdout: string): AgentIntent | null {
  // First, parse the Claude CLI JSON output format
  let resultText: string | null = null;

  try {
    const messages = JSON.parse(stdout) as Array<{
      type: string;
      result?: string;
    }>;
    for (const msg of messages) {
      if (msg.type === 'result' && msg.result) {
        resultText = msg.result;
        break;
      }
    }
  } catch {
    // If not JSON array, treat as raw text
    resultText = stdout.trim();
  }

  if (!resultText) return null;

  // Try to parse the agent's JSON response
  try {
    // Extract JSON from possible markdown code blocks
    const jsonMatch = resultText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      // No JSON found — treat the whole response as a reply
      return {
        type: 'reply',
        content: resultText,
        tone: 'casual',
      };
    }

    const parsed = JSON.parse(jsonMatch[0]);

    const validTypes = ['reply', 'update', 'question', 'greeting', 'acknowledgment'];
    const validTones = ['casual', 'professional', 'urgent', 'playful'];

    return {
      type: validTypes.includes(parsed.type) ? parsed.type : 'reply',
      content: parsed.content || resultText,
      tone: validTones.includes(parsed.tone) ? parsed.tone : 'casual',
    };
  } catch {
    // JSON parse failed — use raw text as reply
    return {
      type: 'reply',
      content: resultText,
      tone: 'casual',
    };
  }
}
