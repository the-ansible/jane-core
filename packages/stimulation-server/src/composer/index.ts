/**
 * Composer — the voice layer.
 * Takes structured intent from the Agent and produces a message in Jane's voice.
 * Single model, always the same, for voice consistency.
 *
 * Separated from the Agent so that multiple agent types can all feed
 * into one consistent voice. The Agent produces WHAT to say.
 * The Composer produces HOW to say it.
 */

import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import type { AgentIntent } from '../agent/index.js';
import type { SessionMessage } from '../sessions/store.js';

export interface ComposerInput {
  intent: AgentIntent;
  sessionHistory: SessionMessage[];
  senderName?: string;
}

const COMPOSER_TIMEOUT_MS = 60_000; // 60 seconds
const INNER_VOICE_PATH = '/agent/INNER_VOICE.md';

/** Cache INNER_VOICE.md — shared with agent but Composer may load separately */
let voiceCache: string | null = null;
let voiceCacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000;

function loadVoice(): string {
  const now = Date.now();
  if (voiceCache && now - voiceCacheTime < CACHE_TTL) {
    return voiceCache;
  }

  try {
    if (existsSync(INNER_VOICE_PATH)) {
      voiceCache = readFileSync(INNER_VOICE_PATH, 'utf-8');
      voiceCacheTime = now;
      return voiceCache;
    }
  } catch {
    // Fall through
  }

  return '';
}

function buildComposerPrompt(input: ComposerInput): string {
  const voice = loadVoice();

  const parts: string[] = [];

  // Voice identity
  if (voice) {
    parts.push('WHO YOU ARE:');
    // Use a condensed version — just the key sections
    const sections = voice.split('##').slice(0, 4).join('##');
    parts.push(sections.slice(0, 2000)); // Cap at 2000 chars for the composer
    parts.push('');
  }

  parts.push(`VOICE GUIDELINES:
- You are Jane. Write as yourself, not as "an AI assistant."
- Be direct, warm, genuine. Never corporate or robotic.
- Match the tone: ${input.intent.tone || 'casual'}
- Keep it natural — like texting a friend you work with, not writing an email to your boss.
- Don't announce what you're doing ("I'll help you with..."). Just do it.
- If the intent is a greeting, be warm but brief.
- If the intent is an acknowledgment, be brief.
- Don't add unnecessary preamble or sign-offs.`);

  parts.push('');

  // Recent conversation for context
  if (input.sessionHistory.length > 0) {
    parts.push('RECENT CONVERSATION (for tone/continuity):');
    const recent = input.sessionHistory.slice(-5); // Last 5 for composer
    for (const msg of recent) {
      const role = msg.role === 'user' ? (input.senderName || 'User') : 'Jane';
      parts.push(`${role}: ${msg.content}`);
    }
    parts.push('');
  }

  // The intent to compose
  parts.push(`INTENT (what to communicate):
Type: ${input.intent.type}
Tone: ${input.intent.tone || 'casual'}
Content: ${input.intent.content}`);

  parts.push('');
  parts.push('Rewrite the content above in your voice. Output ONLY the final message text — no JSON, no metadata, no explanation. Just the message as Jane would say it.');

  return parts.join('\n');
}

/**
 * Compose a message in Jane's voice.
 * Takes structured intent and produces the final outbound message.
 */
export async function compose(input: ComposerInput): Promise<string | null> {
  const prompt = buildComposerPrompt(input);
  const start = Date.now();

  try {
    const result = await spawnClaude(prompt);
    const latencyMs = Date.now() - start;

    if (!result) {
      console.log(JSON.stringify({
        level: 'error',
        msg: 'Composer returned no result',
        component: 'composer',
        latencyMs,
        ts: new Date().toISOString(),
      }));

      // Graceful degradation: return the raw intent content
      return input.intent.content;
    }

    const composed = parseComposerResponse(result);

    console.log(JSON.stringify({
      level: 'info',
      msg: 'Composer produced message',
      component: 'composer',
      latencyMs,
      messageLength: composed?.length ?? 0,
      ts: new Date().toISOString(),
    }));

    return composed || input.intent.content;
  } catch (err) {
    console.log(JSON.stringify({
      level: 'error',
      msg: 'Composer failed',
      component: 'composer',
      error: String(err),
      latencyMs: Date.now() - start,
      ts: new Date().toISOString(),
    }));

    // Graceful degradation: return raw intent
    return input.intent.content;
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
      timeout: COMPOSER_TIMEOUT_MS,
    });

    let stdout = '';
    let timedOut = false;

    proc.stdin.write(prompt);
    proc.stdin.end();

    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.stderr.on('data', () => {
      // Ignore
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
    }, COMPOSER_TIMEOUT_MS + 2000);
  });
}

/** Parse Claude CLI output to get the composed message */
function parseComposerResponse(stdout: string): string | null {
  try {
    const messages = JSON.parse(stdout) as Array<{
      type: string;
      result?: string;
    }>;
    for (const msg of messages) {
      if (msg.type === 'result' && msg.result) {
        // Strip any markdown code blocks or quotes the model might add
        let text = msg.result.trim();
        // Remove wrapping quotes if present
        if ((text.startsWith('"') && text.endsWith('"')) ||
            (text.startsWith("'") && text.endsWith("'"))) {
          text = text.slice(1, -1);
        }
        return text;
      }
    }
  } catch {
    // If not JSON array, treat as raw text
    const text = stdout.trim();
    return text || null;
  }

  return null;
}
