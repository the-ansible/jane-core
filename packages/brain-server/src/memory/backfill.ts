/**
 * Backfill — ingests existing session files into Graphiti that haven't been processed yet.
 *
 * Run via POST /api/memory/backfill or triggered manually.
 * Skips sessions already recorded in brain.memory_ingestion_log.
 */

import { listSessionIds, readSessionMessages, chunkMessages, formatChunkAsText } from './session-chunker.js';
import { getIngestedSessionIds, recordIngestion } from './ingestion-log.js';

const GRAPHITI_URL = process.env.GRAPHITI_SERVICE_URL || 'http://localhost:3200';
// Graphiti calls Ollama multiple times per episode — empirically ~84s per episode.
// Must be well above that to avoid false timeout failures.
const INGEST_TIMEOUT_MS = 180_000;

export interface BackfillResult {
  sessionsProcessed: number;
  sessionsSkipped: number;
  chunksIngested: number;
  chunksFailed: number;
  errors: string[];
}

async function ingestChunk(
  sessionId: string,
  messages: { role: string; content: string; timestamp: string }[],
  tsStart: string
): Promise<{ episodeId: string | null; error: string | null }> {
  const text = formatChunkAsText(messages as Parameters<typeof formatChunkAsText>[0]);
  if (!text.trim()) return { episodeId: null, error: null };

  const episodeName = `${sessionId}-backfill-${tsStart}`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), INGEST_TIMEOUT_MS);

    const res = await fetch(`${GRAPHITI_URL}/episodes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: episodeName,
        content: text,
        source_description: 'conversation',
        reference_time: tsStart,
        group_id: 'jane',
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { episodeId: null, error: `HTTP ${res.status}: ${body.slice(0, 200)}` };
    }

    const data = (await res.json()) as { episode_uuid: string };
    return { episodeId: data.episode_uuid, error: null };
  } catch (err) {
    return { episodeId: null, error: String(err) };
  }
}

/**
 * Run backfill for all sessions, or a specific sessionId if provided.
 */
export async function runBackfill(targetSessionId?: string): Promise<BackfillResult> {
  const result: BackfillResult = {
    sessionsProcessed: 0,
    sessionsSkipped: 0,
    chunksIngested: 0,
    chunksFailed: 0,
    errors: [],
  };

  const alreadyIngested = await getIngestedSessionIds();
  const allSessions = targetSessionId ? [targetSessionId] : listSessionIds();

  log('info', 'Starting backfill', {
    totalSessions: allSessions.length,
    alreadyIngested: alreadyIngested.size,
    targetSessionId,
  });

  for (const sessionId of allSessions) {
    if (alreadyIngested.has(sessionId)) {
      result.sessionsSkipped++;
      continue;
    }

    const messages = readSessionMessages(sessionId);
    if (messages.length === 0) {
      result.sessionsSkipped++;
      continue;
    }

    const chunks = chunkMessages(sessionId, messages);
    let sessionSuccess = false;

    for (const chunk of chunks) {
      const { episodeId, error } = await ingestChunk(sessionId, chunk.messages, chunk.tsStart);

      await recordIngestion({
        sessionId,
        graphitiEpisodeId: episodeId,
        messageCount: chunk.messages.length,
        tsStart: chunk.tsStart,
        tsEnd: chunk.tsEnd,
        status: error ? 'failed' : 'success',
        error: error ?? undefined,
      });

      if (error) {
        result.chunksFailed++;
        result.errors.push(`${sessionId}@${chunk.tsStart}: ${error}`);
      } else {
        result.chunksIngested++;
        sessionSuccess = true;
      }
    }

    if (sessionSuccess || chunks.length === 0) {
      result.sessionsProcessed++;
    }
  }

  log('info', 'Backfill complete', result as unknown as Record<string, unknown>);
  return result;
}

function log(level: string, msg: string, extra?: Record<string, unknown>): void {
  console.log(
    JSON.stringify({ level, msg, component: 'memory-backfill', ts: new Date().toISOString(), ...extra })
  );
}
