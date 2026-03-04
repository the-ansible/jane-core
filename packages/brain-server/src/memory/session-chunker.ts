/**
 * Session Chunker — reads JSONL session files and splits messages into
 * episodes suitable for Graphiti ingestion.
 *
 * Used by the backfill job to process existing sessions on disk.
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export interface RawMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  eventId?: string;
}

export interface SessionChunk {
  sessionId: string;
  messages: RawMessage[];
  tsStart: string;
  tsEnd: string;
}

const CHUNK_SIZE = 15; // messages per Graphiti episode
const SESSIONS_DIR = process.env.SESSIONS_DIR || '/agent/data/sessions';

/**
 * Read all messages from a JSONL session file.
 * Skips system messages (compaction summaries).
 */
export function readSessionMessages(sessionId: string): RawMessage[] {
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const filePath = join(SESSIONS_DIR, `${safe}.jsonl`);

  if (!existsSync(filePath)) return [];

  try {
    const lines = readFileSync(filePath, 'utf-8')
      .trim()
      .split('\n')
      .filter(Boolean);

    const messages: RawMessage[] = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.type === 'message' && entry.message) {
          const msg = entry.message as RawMessage;
          // Skip system summary messages — they're synthesized, not raw conversation
          if (msg.role !== 'system') {
            messages.push(msg);
          }
        }
      } catch {
        // Skip malformed lines
      }
    }

    return messages;
  } catch {
    return [];
  }
}

/**
 * Split a list of messages into fixed-size chunks for episode ingestion.
 */
export function chunkMessages(sessionId: string, messages: RawMessage[]): SessionChunk[] {
  const chunks: SessionChunk[] = [];

  for (let i = 0; i < messages.length; i += CHUNK_SIZE) {
    const slice = messages.slice(i, i + CHUNK_SIZE);
    if (slice.length === 0) continue;

    chunks.push({
      sessionId,
      messages: slice,
      tsStart: slice[0].timestamp,
      tsEnd: slice[slice.length - 1].timestamp,
    });
  }

  return chunks;
}

/**
 * List all session IDs available on disk.
 */
export function listSessionIds(): string[] {
  if (!existsSync(SESSIONS_DIR)) return [];

  try {
    return readdirSync(SESSIONS_DIR)
      .filter((f) => f.endsWith('.jsonl') && !f.endsWith('.tmp'))
      .map((f) => f.replace(/\.jsonl$/, ''));
  } catch {
    return [];
  }
}

/**
 * Format messages as readable conversation text for Graphiti.
 */
export function formatChunkAsText(messages: RawMessage[]): string {
  return messages
    .map((m) => `${m.role === 'user' ? 'Chris' : 'Jane'}: ${m.content}`)
    .join('\n');
}
