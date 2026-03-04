/**
 * Graphiti Client — thin HTTP wrapper for graphiti-service (:3200).
 * Handles episode ingestion and knowledge graph search.
 */

import type { SessionMessage } from '../sessions/store.js';

const GRAPHITI_URL = process.env.GRAPHITI_SERVICE_URL || 'http://localhost:3200';
// Graphiti calls Ollama multiple times per episode — empirically ~84s for entity extraction.
// 120s gives a comfortable margin for a single 15-message chunk.
const INGEST_TIMEOUT_MS = 120_000;

export interface IngestResult {
  episodeId: string | null;
  error: string | null;
}

export interface MemoryFact {
  uuid: string;
  fact: string;
  score: number | null;
}

/**
 * Resolve the display name for a message speaker.
 *
 * Priority: explicit sender field → legacy content heuristics.
 * The sender field is set at ingest time directly from CommunicationEvent.sender,
 * so it's structurally correct (no guessing from content).
 *
 * Content-based heuristics are kept as a fallback for legacy JSONL files
 * that predate the sender field.
 */
export function resolveSpeaker(message: SessionMessage): string {
  if (message.role === 'assistant') return 'Jane';

  // Prefer explicit sender over heuristics
  if (message.sender) {
    const { id, displayName, type } = message.sender;
    // Automated sources (agent/system) are Jane's subsystems
    if (type === 'system' || type === 'agent') {
      return `Jane (${displayName || id})`;
    }
    if (id === 'chris') return 'Chris';
    if (id === 'jane') return 'Jane';
    return displayName || id;
  }

  // Legacy fallback: content heuristics for old JSONL without sender field
  const automatedPatterns = [
    /^\s*(weekly|daily|monthly|hourly)\s+\w[\w\s]+\s+(audit|check|review|cleanup|scan)/i,
    /^\s*health\s+check/i,
    /^\s*good\s+morning,?\s+chris/i,
    /^\s*storage\s+audit/i,
    /^\s*efficiency\s+audit/i,
    /^\s*log\s+cleanup/i,
    /^\s*script\s+review/i,
    /\bvault\s+healthy\b/i,
    /audit\s+report\s+saved\s+to\s+operations\//i,
  ];
  return automatedPatterns.some((p) => p.test(message.content)) ? 'Jane (automated)' : 'Chris';
}

function formatMessagesAsText(messages: SessionMessage[]): string {
  return messages
    .filter((m) => m.role !== 'system')
    .map((m) => `${resolveSpeaker(m)}: ${m.content}`)
    .join('\n');
}

/**
 * Ingest a chunk of session messages as a Graphiti episode.
 * Returns { episodeId, error } — never throws.
 */
export async function ingestEpisode(
  sessionId: string,
  messages: SessionMessage[]
): Promise<IngestResult> {
  const content = formatMessagesAsText(messages);
  if (!content.trim()) return { episodeId: null, error: null };

  const referenceTime = messages.find((m) => m.timestamp)?.timestamp ?? new Date().toISOString();
  // Use first message timestamp as unique identifier for this chunk
  const chunkTs = messages[0]?.timestamp ?? new Date().toISOString();
  const episodeName = `${sessionId}-${chunkTs}`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), INGEST_TIMEOUT_MS);

    const res = await fetch(`${GRAPHITI_URL}/episodes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: episodeName,
        content,
        source_description: 'conversation',
        reference_time: referenceTime,
        group_id: 'jane',
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const error = `HTTP ${res.status}: ${body.slice(0, 200)}`;
      log('warn', 'Episode ingest failed', { sessionId, episodeName, error });
      return { episodeId: null, error };
    }

    const data = (await res.json()) as { episode_uuid: string };
    log('info', 'Episode ingested', {
      sessionId,
      episodeName,
      episodeId: data.episode_uuid,
      messageCount: messages.filter((m) => m.role !== 'system').length,
    });
    return { episodeId: data.episode_uuid, error: null };
  } catch (err) {
    const error = String(err);
    log('warn', 'Episode ingest error', { sessionId, episodeName, error });
    return { episodeId: null, error };
  }
}

/**
 * Search the Graphiti knowledge graph.
 * Returns top facts — empty array on error.
 */
export async function searchMemory(query: string, limit = 5): Promise<MemoryFact[]> {
  try {
    const res = await fetch(`${GRAPHITI_URL}/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, limit, group_ids: ['jane'] }),
    });
    if (!res.ok) return [];
    return (await res.json()) as MemoryFact[];
  } catch {
    return [];
  }
}

function log(level: string, msg: string, extra?: Record<string, unknown>): void {
  console.log(
    JSON.stringify({ level, msg, component: 'graphiti-client', ts: new Date().toISOString(), ...extra })
  );
}
