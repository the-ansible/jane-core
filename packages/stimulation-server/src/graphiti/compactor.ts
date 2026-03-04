/**
 * Compactor — wires session compaction with Graphiti episode ingestion.
 *
 * Flow:
 *   1. Session exceeds 40 messages → pipeline calls compactAndIngest()
 *   2. Before compaction destroys old messages, ingest them to Graphiti
 *   3. Compact session (summarize → rewrite JSONL)
 *   4. Publish memory.session.compacted to NATS
 */

import type { NatsClient } from '../nats/client.js';
import { getSession, compactSession } from '../sessions/store.js';
import { ingestEpisode, resolveSpeaker } from './client.js';
import type { SessionMessage } from '../sessions/store.js';

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://host.docker.internal:11434';
const COMPACTION_SUBJECT = 'memory.session.compacted';
// Mirrors KEEP_RECENT in store.ts — messages to preserve after compaction
const KEEP_RECENT = 10;
// Max messages per Graphiti episode — keeps each call within the timeout budget
const CHUNK_SIZE = 15;

async function summarizeForCompaction(messages: SessionMessage[]): Promise<string> {
  const formatted = messages
    .filter((m) => m.role !== 'system')
    .map((m) => `${resolveSpeaker(m)}: ${m.content}`)
    .join('\n');

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);

    const res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gemma3:12b',
        prompt: `Summarize this conversation concisely. Preserve key decisions, facts, questions asked, answers given, and action items:\n\n${formatted}`,
        stream: false,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);
    if (!res.ok) throw new Error(`Ollama ${res.status}`);
    const data = (await res.json()) as { response: string };
    return data.response.trim() || `[summarization_empty] ${formatted.slice(0, 300)}`;
  } catch (err) {
    log('warn', 'Compaction summarization failed, using fallback', { error: String(err) });
    return `[summarization_failed] ${formatted.slice(0, 500)}`;
  }
}

/**
 * Compact a session with Graphiti ingestion.
 * Intended to be called fire-and-forget from the pipeline.
 */
export async function compactAndIngest(
  sessionId: string,
  nats: NatsClient | null
): Promise<void> {
  // Snapshot the messages that WILL be compacted before the store overwrites them.
  // store.ts keeps the last KEEP_RECENT messages and summarizes everything before.
  const session = getSession(sessionId);
  const toCompact = session.messages.slice(0, -KEEP_RECENT);

  // Split into CHUNK_SIZE-message episodes so each Ollama call stays within the timeout.
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

  // Compact the session (summarize + rewrite JSONL)
  await compactSession(sessionId, summarizeForCompaction);

  // Emit core NATS event so brain-server can track memory state.
  // Using nc.publish() (not JetStream) — no stream required for this event.
  if (nats?.isConnected()) {
    try {
      const payload = JSON.stringify({
        sessionId,
        messageCount: toCompact.length,
        graphitiEpisodeId: ingestResult.episodeId,
        ingestError: ingestResult.error,
        ts: new Date().toISOString(),
      });
      nats.nc.publish(COMPACTION_SUBJECT, new TextEncoder().encode(payload));
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
    JSON.stringify({ level, msg, component: 'graphiti-compactor', ts: new Date().toISOString(), ...extra })
  );
}
