/**
 * Session Store — persistent conversation memory keyed by sessionId.
 * In-memory map with JSONL write-through to disk.
 * Supports auto-compaction when message count exceeds threshold.
 */

import { readFileSync, appendFileSync, writeFileSync, renameSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export interface SessionMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  eventId?: string;
}

export interface SessionState {
  sessionId: string;
  messages: SessionMessage[];
  createdAt: string;
  lastActivityAt: string;
  metadata: Record<string, unknown>;
}

function getSessionsDir(): string {
  return process.env.SESSIONS_DIR || '/agent/data/sessions';
}
const COMPACTION_THRESHOLD = 40;
const KEEP_RECENT = 10; // Keep last N raw messages after compaction

// In-memory session cache
const sessions = new Map<string, SessionState>();

function ensureDir(): void {
  const dir = getSessionsDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function sessionFilePath(sessionId: string): string {
  // Sanitize sessionId for filesystem safety
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return join(getSessionsDir(), `${safe}.jsonl`);
}

/**
 * Atomic write: write to a temp file, then rename.
 * rename() is atomic on POSIX systems when src and dest are on the same filesystem.
 */
function atomicWriteFileSync(filePath: string, data: string): void {
  const tmpPath = filePath + '.tmp';
  writeFileSync(tmpPath, data);
  renameSync(tmpPath, filePath);
}

/** Load session from disk if not in memory */
function loadFromDisk(sessionId: string): SessionState | null {
  const filePath = sessionFilePath(sessionId);
  if (!existsSync(filePath)) return null;

  try {
    const lines = readFileSync(filePath, 'utf-8').trim().split('\n').filter(Boolean);
    const messages: SessionMessage[] = [];
    let metadata: Record<string, unknown> = {};
    let createdAt = '';

    for (const line of lines) {
      const entry = JSON.parse(line);
      if (entry.type === 'meta') {
        createdAt = entry.createdAt || '';
        metadata = entry.metadata || {};
      } else if (entry.type === 'message') {
        messages.push(entry.message);
      }
    }

    return {
      sessionId,
      messages,
      createdAt: createdAt || new Date().toISOString(),
      lastActivityAt: messages.length > 0
        ? messages[messages.length - 1].timestamp
        : new Date().toISOString(),
      metadata,
    };
  } catch (err) {
    console.log(JSON.stringify({
      level: 'error',
      msg: 'Failed to load session from disk',
      sessionId,
      error: String(err),
      component: 'sessions',
      ts: new Date().toISOString(),
    }));
    return null;
  }
}

/** Get or create a session */
export function getSession(sessionId: string): SessionState {
  let session = sessions.get(sessionId);
  if (session) return session;

  // Try loading from disk
  session = loadFromDisk(sessionId) ?? undefined;
  if (session) {
    sessions.set(sessionId, session);
    return session;
  }

  // Create new session
  const now = new Date().toISOString();
  session = {
    sessionId,
    messages: [],
    createdAt: now,
    lastActivityAt: now,
    metadata: {},
  };
  sessions.set(sessionId, session);

  // Write metadata to disk
  ensureDir();
  writeFileSync(
    sessionFilePath(sessionId),
    JSON.stringify({ type: 'meta', createdAt: now, metadata: {} }) + '\n'
  );

  return session;
}

/** Append a message to a session */
export function appendMessage(sessionId: string, message: SessionMessage): void {
  const session = getSession(sessionId);
  session.messages.push(message);
  session.lastActivityAt = message.timestamp;

  // Write-through to disk
  ensureDir();
  appendFileSync(
    sessionFilePath(sessionId),
    JSON.stringify({ type: 'message', message }) + '\n'
  );
}

/** Get recent messages for context (returns last N messages) */
export function getContextMessages(sessionId: string, limit = 20): SessionMessage[] {
  const session = getSession(sessionId);
  return session.messages.slice(-limit);
}

/** Check if session needs compaction */
export function needsCompaction(sessionId: string): boolean {
  const session = sessions.get(sessionId);
  if (!session) return false;
  return session.messages.length > COMPACTION_THRESHOLD;
}

/**
 * Compact a session by summarizing older messages.
 * Takes a summarizer function so the store doesn't depend on any specific LLM.
 */
export async function compactSession(
  sessionId: string,
  summarize: (messages: SessionMessage[]) => Promise<string>
): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session || session.messages.length <= COMPACTION_THRESHOLD) return;

  const toCompact = session.messages.slice(0, -KEEP_RECENT);
  const toKeep = session.messages.slice(-KEEP_RECENT);

  const summary = await summarize(toCompact);

  // Replace messages with summary + recent
  session.messages = [
    {
      role: 'system',
      content: `[Conversation summary]\n${summary}`,
      timestamp: new Date().toISOString(),
    },
    ...toKeep,
  ];

  // Rewrite the session file atomically (write to .tmp, then rename)
  ensureDir();
  const filePath = sessionFilePath(sessionId);
  const lines = [
    JSON.stringify({ type: 'meta', createdAt: session.createdAt, metadata: session.metadata }),
    ...session.messages.map(m => JSON.stringify({ type: 'message', message: m })),
  ];
  atomicWriteFileSync(filePath, lines.join('\n') + '\n');

  console.log(JSON.stringify({
    level: 'info',
    msg: 'Session compacted',
    sessionId,
    compactedMessages: toCompact.length,
    remainingMessages: session.messages.length,
    component: 'sessions',
    ts: new Date().toISOString(),
  }));
}

/**
 * List all session IDs — in-memory + any on disk not yet loaded.
 * Returns deduplicated sorted list.
 */
export function listSessions(): string[] {
  const inMemory = new Set(sessions.keys());

  // Discover sessions on disk
  const dir = getSessionsDir();
  if (existsSync(dir)) {
    try {
      for (const file of readdirSync(dir)) {
        if (file.endsWith('.jsonl') && !file.endsWith('.tmp')) {
          inMemory.add(file.replace(/\.jsonl$/, ''));
        }
      }
    } catch {
      // If we can't read the dir, just return in-memory sessions
    }
  }

  return Array.from(inMemory).sort();
}

/** Get message count for a session */
export function getMessageCount(sessionId: string): number {
  const session = sessions.get(sessionId);
  return session?.messages.length ?? 0;
}

/** Clear all in-memory sessions (for testing) */
export function clearAllSessions(): void {
  sessions.clear();
}
