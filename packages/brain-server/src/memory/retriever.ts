/**
 * Memory Retriever — surfaces relevant memories for context injection.
 *
 * Used by the goal engine and strategic layer to bring relevant past
 * experience into LLM prompts without re-reading the whole memory store.
 */

import { listMemories, searchMemories } from './registry.js';
import type { Memory } from './types.js';

const CONTEXT_LIMIT = 8; // max memories to inject into a prompt

// ---------------------------------------------------------------------------
// Context retrieval — blends keyword search + recency + importance
// ---------------------------------------------------------------------------

export async function getRelevantMemories(opts: {
  query?: string;
  tags?: string[];
  limit?: number;
  minImportance?: number;
}): Promise<Memory[]> {
  const limit = opts.limit ?? CONTEXT_LIMIT;
  const results: Map<string, Memory> = new Map();

  // 1. Keyword search if query provided
  if (opts.query) {
    const keyword = await searchMemories(opts.query, limit);
    for (const m of keyword) results.set(m.id, m);
  }

  // 2. Tag-filtered recent memories
  if (opts.tags && opts.tags.length > 0) {
    const tagged = await listMemories({
      tags: opts.tags,
      minImportance: opts.minImportance ?? 0.4,
      limit,
    });
    for (const m of tagged) results.set(m.id, m);
  }

  // 3. If we have very few results so far, pad with high-importance recent memories
  if (results.size < Math.ceil(limit / 2)) {
    const recent = await listMemories({
      minImportance: opts.minImportance ?? 0.6,
      limit: limit - results.size,
    });
    for (const m of recent) results.set(m.id, m);
  }

  // Score and sort: importance * recency factor
  const scored = Array.from(results.values()).map((m) => ({
    memory: m,
    score: scoreMemory(m),
  }));

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.memory);
}

// ---------------------------------------------------------------------------
// Format memories as a compact text block for LLM context injection
// ---------------------------------------------------------------------------

export function formatMemoriesForContext(memories: Memory[]): string {
  if (memories.length === 0) return '(No relevant memories found)';

  const lines = memories.map((m, i) => {
    const age = formatAge(new Date(m.created_at));
    const tags = m.tags.length > 0 ? ` [${m.tags.join(', ')}]` : '';
    return `${i + 1}. [${m.type.toUpperCase()}${tags}] ${m.title} (${age})\n   ${m.content.slice(0, 300)}${m.content.length > 300 ? '…' : ''}`;
  });

  return lines.join('\n\n');
}

// ---------------------------------------------------------------------------
// Goal-context retrieval — pre-built for the goal engine
// ---------------------------------------------------------------------------

export async function getGoalContextMemories(): Promise<string> {
  const memories = await getRelevantMemories({
    tags: ['goal-cycle', 'directive', 'strategic'],
    minImportance: 0.5,
    limit: 6,
  });
  return formatMemoriesForContext(memories);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function scoreMemory(m: Memory): number {
  const ageMs = Date.now() - new Date(m.created_at).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  // Recency factor: 1.0 at 0 days, decays to 0.2 at 90 days
  const recency = Math.max(0.2, 1 - ageDays / 90);
  // Access boost: frequently accessed memories are more relevant
  const accessBoost = Math.min(0.2, m.access_count * 0.02);
  return m.importance * recency + accessBoost;
}

function formatAge(d: Date): string {
  const ms = Date.now() - d.getTime();
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}
