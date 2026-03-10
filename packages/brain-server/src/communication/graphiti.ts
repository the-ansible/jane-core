/**
 * Graphiti -- HTTP client for graphiti-service (:3200) + session compaction.
 * Handles episode ingestion, knowledge graph search, and session compaction wiring.
 */

import type { NatsConnection } from 'nats';
import { StringCodec } from 'nats';
import type { SessionMessage } from './sessions/store.js';
import { getSession, compactSession } from './sessions/store.js';
import { invokeAdapter } from '../executor/index.js';
import type { MemoryFact } from './types.js';

const GRAPHITI_URL = process.env.GRAPHITI_SERVICE_URL || 'http://localhost:3200';
const INGEST_TIMEOUT_MS = 120_000;
const COMPACTION_SUBJECT = 'memory.session.compacted';
const KEEP_RECENT = 10;
const CHUNK_SIZE = 15;

const sc = StringCodec();

export interface IngestResult {
  episodeId: string | null;
  error: string | null;
}

/**
 * Resolve the display name for a message speaker.
 */
export function resolveSpeaker(message: SessionMessage): string {
  if (message.role === 'assistant') return 'Jane';

  if (message.sender) {
    const { id, displayName, type } = message.sender;
    if (type === 'system' || type === 'agent') {
      return `Jane (${displayName || id})`;
    }
    if (id === 'chris') return 'Chris';
    if (id === 'jane') return 'Jane';
    return displayName || id;
  }

  // Legacy fallback
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
 */
export async function ingestEpisode(
  sessionId: string,
  messages: SessionMessage[]
): Promise<IngestResult> {
  const content = formatMessagesAsText(messages);
  if (!content.trim()) return { episodeId: null, error: null };

  const referenceTime = messages.find((m) => m.timestamp)?.timestamp ?? new Date().toISOString();
  const firstEventId = messages.find((m) => m.eventId)?.eventId;
  const episodeName = firstEventId ?? `${sessionId}-${messages[0]?.timestamp ?? new Date().toISOString()}`;

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
  } catch (err) {
    log('warn', 'Graphiti memory search failed', { query, error: String(err) });
    return [];
  }
}

// ---------------------------------------------------------------------------
// Compaction -- wires session compaction with Graphiti episode ingestion
// ---------------------------------------------------------------------------

async function summarizeForCompaction(messages: SessionMessage[]): Promise<string> {
  const formatted = messages
    .filter((m) => m.role !== 'system')
    .map((m) => `${resolveSpeaker(m)}: ${m.content}`)
    .join('\n');

  try {
    const result = await invokeAdapter({
      runtime: 'claude-code',
      model: 'haiku',
      prompt: `Summarize this conversation concisely. Preserve key decisions, facts, questions asked, answers given, and action items:\n\n${formatted}`,
    });

    if (!result.success || !result.resultText) {
      throw new Error(`Adapter returned: ${result.error ?? 'no result'}`);
    }

    return result.resultText.trim() || `[summarization_empty] ${formatted.slice(0, 300)}`;
  } catch (err) {
    log('warn', 'Compaction summarization failed, using fallback', { error: String(err) });
    return `[summarization_failed] ${formatted.slice(0, 500)}`;
  }
}

/**
 * Compact a session with Graphiti ingestion.
 * Fire-and-forget from the pipeline.
 */
export async function compactAndIngest(
  sessionId: string,
  nats: NatsConnection | null
): Promise<void> {
  const session = getSession(sessionId);
  const toCompact = session.messages.slice(0, -KEEP_RECENT);

  const nonSystem = toCompact.filter((m) => m.role !== 'system');
  let lastEpisodeId: string | null = null;
  let lastError: string | null = null;

  if (nonSystem.length > 0) {
    const chunks: SessionMessage[][] = [];
    for (let i = 0; i < toCompact.length; i += CHUNK_SIZE) {
      chunks.push(toCompact.slice(i, i + CHUNK_SIZE));
    }

    log('info', 'Ingesting session chunks to Graphiti before compaction', {
      sessionId,
      messageCount: nonSystem.length,
      chunks: chunks.length,
    });

    for (const chunk of chunks) {
      const result = await ingestEpisode(sessionId, chunk);
      if (result.episodeId) lastEpisodeId = result.episodeId;
      if (result.error) lastError = result.error;
    }
  }

  const ingestResult = { episodeId: lastEpisodeId, error: lastError };

  await compactSession(sessionId, summarizeForCompaction);

  if (nats) {
    try {
      const payload = JSON.stringify({
        sessionId,
        messageCount: toCompact.length,
        graphitiEpisodeId: ingestResult.episodeId,
        ingestError: ingestResult.error,
        ts: new Date().toISOString(),
      });
      nats.publish(COMPACTION_SUBJECT, sc.encode(payload));
    } catch (err) {
      log('warn', 'Failed to publish compaction NATS event', { sessionId, error: String(err) });
    }
  }

  log('info', 'Session compacted and ingested', {
    sessionId,
    graphitiEpisodeId: ingestResult.episodeId,
    ingestError: ingestResult.error,
  });
}

function log(level: string, msg: string, extra?: Record<string, unknown>): void {
  console.log(
    JSON.stringify({ level, msg, component: 'comm.graphiti', ts: new Date().toISOString(), ...extra })
  );
}
