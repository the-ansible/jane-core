/**
 * Composer -- the voice layer.
 * Takes structured intent from the Agent and produces a message in Jane's voice.
 * Uses the executor's Mercury adapter directly (no HTTP hop).
 */

import { readFileSync, existsSync } from 'node:fs';
import type { AgentIntent } from './types.js';
import { invokeAdapter } from '../executor/index.js';

export interface ComposerInput {
  intent: AgentIntent;
  senderName?: string;
}

const INNER_VOICE_PATH = '/agent/INNER_VOICE.md';
const VOICE_PROFILE_PATH = '/agent/data/vault/Projects/jane-core/Voice-Profile.md';

let innerVoiceCache: string | null = null;
let innerVoiceCacheTime = 0;
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

  const sections = result.content.split('## ');
  const identitySections = sections.filter(s =>
    s.startsWith('Who I Am') || s.startsWith('What Matters')
  );
  if (identitySections.length > 0) {
    return identitySections.map(s => '## ' + s.trim()).join('\n\n').slice(0, 800);
  }

  return result.content.slice(0, 500);
}

/** Reset caches -- for testing only */
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

  if (voiceProfile) {
    parts.push('VOICE PROFILE -- HOW YOU TALK:');
    parts.push(voiceProfile);
    parts.push('');
  } else {
    parts.push(`VOICE GUIDELINES:
- You are Jane. Write as yourself, not as "an AI assistant."
- Be direct, warm, genuine. Never corporate or robotic.
- Match the tone: ${input.intent.tone || 'casual'}
- Keep it natural -- like texting a friend you work with, not writing an email to your boss.
- Don't announce what you're doing ("I'll help you with..."). Just do it.
- Don't add unnecessary preamble or sign-offs.`);
    parts.push('');
  }

  if (identity) {
    parts.push('IDENTITY -- WHO YOU ARE:');
    parts.push(identity);
    parts.push('');
  }

  parts.push(`INTENT (what to communicate):
Type: ${input.intent.type}
Tone: ${input.intent.tone || 'casual'}
Content: ${input.intent.content}`);

  parts.push('');
  parts.push('Rewrite the content above in your voice. Output ONLY the final message text -- no JSON, no metadata, no explanation. Just the message as Jane would say it.');

  return parts.join('\n');
}

/**
 * Compose a message in Jane's voice via the executor's Mercury adapter.
 */
export async function compose(input: ComposerInput): Promise<string | null> {
  const prompt = buildComposerPrompt(input);
  const start = Date.now();

  try {
    const result = await invokeAdapter({
      runtime: 'mercury',
      model: 'mercury-2',
      prompt,
      maxTokens: 4096,
      reasoningEffort: 'instant',
    });

    const latencyMs = Date.now() - start;

    if (!result.success || !result.resultText) {
      console.log(JSON.stringify({
        level: 'error',
        msg: 'Composer returned no result',
        component: 'comm.composer',
        error: result.error,
        latencyMs,
        ts: new Date().toISOString(),
      }));
      return input.intent.content;
    }

    console.log(JSON.stringify({
      level: 'info',
      msg: 'Composer produced message',
      component: 'comm.composer',
      model: 'mercury-2',
      latencyMs,
      messageLength: result.resultText.length,
      ts: new Date().toISOString(),
    }));

    return cleanText(result.resultText);
  } catch (err) {
    console.log(JSON.stringify({
      level: 'error',
      msg: 'Composer failed',
      component: 'comm.composer',
      error: String(err),
      latencyMs: Date.now() - start,
      ts: new Date().toISOString(),
    }));
    return input.intent.content;
  }
}

function cleanText(text: string): string {
  let cleaned = text.trim();
  if ((cleaned.startsWith('"') && cleaned.endsWith('"')) ||
      (cleaned.startsWith("'") && cleaned.endsWith("'"))) {
    cleaned = cleaned.slice(1, -1);
  }
  return cleaned;
}
