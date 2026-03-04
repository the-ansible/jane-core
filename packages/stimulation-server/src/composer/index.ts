/**
 * Composer — the voice layer.
 * Takes structured intent from the Agent and produces a message in Jane's voice.
 * Single model, always the same, for voice consistency.
 *
 * Separated from the Agent so that multiple agent types can all feed
 * into one consistent voice. The Agent produces WHAT to say.
 * The Composer produces HOW to say it.
 *
 * Uses Mercury (mercury-2) via OpenAI-compatible API for faster, cheaper composition.
 */

import { readFileSync, existsSync } from 'node:fs';
import type { AgentIntent } from '../agent/index.js';

export interface ComposerInput {
  intent: AgentIntent;
  senderName?: string;
}

const COMPOSER_TIMEOUT_MS = 30_000; // 30 seconds — Mercury is fast
const MERCURY_BASE_URL = 'https://api.inceptionlabs.ai/v1';
const MERCURY_MODEL = 'mercury-2';
const INNER_VOICE_PATH = '/agent/INNER_VOICE.md';
const VOICE_PROFILE_PATH = '/agent/data/vault/Projects/jane-core/Voice-Profile.md';

/** Cache INNER_VOICE.md — identity source */
let innerVoiceCache: string | null = null;
let innerVoiceCacheTime = 0;

/** Cache Voice Profile — how Jane talks */
let voiceProfileCache: string | null = null;
let voiceProfileCacheTime = 0;

const CACHE_TTL = 5 * 60 * 1000;

function loadCachedFile(
  path: string,
  cache: { value: string | null; time: number }
): { content: string; time: number } {
  const now = Date.now();
  if (cache.value !== null && now - cache.time < CACHE_TTL) {
    return { content: cache.value, time: cache.time };
  }

  try {
    if (existsSync(path)) {
      const content = readFileSync(path, 'utf-8');
      return { content, time: now };
    }
  } catch {
    // Fall through
  }

  return { content: '', time: now };
}

function loadVoiceProfile(): string {
  const result = loadCachedFile(VOICE_PROFILE_PATH, {
    value: voiceProfileCache,
    time: voiceProfileCacheTime,
  });
  voiceProfileCache = result.content;
  voiceProfileCacheTime = result.time;
  return result.content;
}

function loadInnerVoiceCondensed(): string {
  const result = loadCachedFile(INNER_VOICE_PATH, {
    value: innerVoiceCache,
    time: innerVoiceCacheTime,
  });
  innerVoiceCache = result.content;
  innerVoiceCacheTime = result.time;

  if (!result.content) return '';

  // Extract just identity sections (~500 chars) — "Who I Am" and "What Matters"
  const sections = result.content.split('## ');
  const identitySections = sections.filter(s =>
    s.startsWith('Who I Am') || s.startsWith('What Matters')
  );
  if (identitySections.length > 0) {
    return identitySections.map(s => '## ' + s.trim()).join('\n\n').slice(0, 800);
  }

  // Fallback: first 500 chars
  return result.content.slice(0, 500);
}

/** Reset caches — for testing only */
export function _resetCaches(): void {
  innerVoiceCache = null;
  innerVoiceCacheTime = 0;
  voiceProfileCache = null;
  voiceProfileCacheTime = 0;
}

function buildComposerPrompt(input: ComposerInput): string {
  const voiceProfile = loadVoiceProfile();
  const identity = loadInnerVoiceCondensed();

  const parts: string[] = [];

  // Voice Profile — how Jane talks (full document)
  if (voiceProfile) {
    parts.push('VOICE PROFILE — HOW YOU TALK:');
    parts.push(voiceProfile);
    parts.push('');
  } else {
    // Fallback when Voice Profile is unavailable
    parts.push(`VOICE GUIDELINES:
- You are Jane. Write as yourself, not as "an AI assistant."
- Be direct, warm, genuine. Never corporate or robotic.
- Match the tone: ${input.intent.tone || 'casual'}
- Keep it natural — like texting a friend you work with, not writing an email to your boss.
- Don't announce what you're doing ("I'll help you with..."). Just do it.
- Don't add unnecessary preamble or sign-offs.`);
    parts.push('');
  }

  // Identity — condensed from INNER_VOICE.md
  if (identity) {
    parts.push('IDENTITY — WHO YOU ARE:');
    parts.push(identity);
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
 * Read MERCURY_API_KEY from process env or fall back to PID 1 environ.
 * Docker Desktop injects vars into PID 1 but they don't always propagate
 * down the process tree to child processes.
 */
function getMercuryApiKey(): string | undefined {
  if (process.env.MERCURY_API_KEY) return process.env.MERCURY_API_KEY;

  try {
    const environ = readFileSync('/proc/1/environ');
    const vars = environ.toString().split('\0');
    for (const v of vars) {
      if (v.startsWith('MERCURY_API_KEY=')) {
        const val = v.slice('MERCURY_API_KEY='.length);
        if (val) return val;
      }
    }
  } catch {
    // /proc/1/environ not available — not on Linux or no permission
  }

  return undefined;
}

/**
 * Compose a message in Jane's voice via Mercury API.
 * Takes structured intent and produces the final outbound message.
 */
export async function compose(input: ComposerInput): Promise<string | null> {
  const prompt = buildComposerPrompt(input);
  const start = Date.now();

  try {
    const result = await callMercury(prompt);
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

    console.log(JSON.stringify({
      level: 'info',
      msg: 'Composer produced message',
      component: 'composer',
      model: MERCURY_MODEL,
      latencyMs,
      messageLength: result.length,
      ts: new Date().toISOString(),
    }));

    return result;
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

async function callMercury(prompt: string): Promise<string | null> {
  const apiKey = getMercuryApiKey();
  if (!apiKey) {
    console.log(JSON.stringify({
      level: 'error',
      msg: 'MERCURY_API_KEY not set — cannot compose with Mercury',
      component: 'composer',
      ts: new Date().toISOString(),
    }));
    return null;
  }

  const response = await fetch(`${MERCURY_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MERCURY_MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 4096,
      reasoning_effort: 'instant',
    }),
    signal: AbortSignal.timeout(COMPOSER_TIMEOUT_MS),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    console.log(JSON.stringify({
      level: 'error',
      msg: 'Mercury API error',
      component: 'composer',
      status: response.status,
      body: text.slice(0, 300),
      ts: new Date().toISOString(),
    }));
    return null;
  }

  const data = await response.json() as { choices?: Array<{ message?: { content?: string }; finish_reason?: string }> };
  const choice = data?.choices?.[0];
  const content = choice?.message?.content;
  const finishReason = choice?.finish_reason ?? 'unknown';

  console.log(JSON.stringify({
    level: 'info',
    msg: 'Mercury response received',
    component: 'composer',
    finish_reason: finishReason,
    promptChars: prompt.length,
    responseChars: content?.length ?? 0,
    ts: new Date().toISOString(),
  }));

  if (finishReason === 'length') {
    console.log(JSON.stringify({
      level: 'warn',
      msg: 'Mercury hit token limit — response may be truncated',
      component: 'composer',
      ts: new Date().toISOString(),
    }));
  }

  return content ? cleanText(content) : null;
}

function cleanText(text: string): string {
  let cleaned = text.trim();
  // Remove wrapping quotes if present
  if ((cleaned.startsWith('"') && cleaned.endsWith('"')) ||
      (cleaned.startsWith("'") && cleaned.endsWith("'"))) {
    cleaned = cleaned.slice(1, -1);
  }
  return cleaned;
}
