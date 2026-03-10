/**
 * Memory Consolidator — periodic synthesis of episodic memories into
 * semantic knowledge and learned patterns.
 *
 * Runs every 12 hours (configurable). Uses LLM to:
 *   1. Group related episodic memories
 *   2. Extract patterns (what keeps happening, what works, what fails)
 *   3. Synthesize semantic memories (distilled facts/knowledge)
 *   4. Apply importance decay to old, unaccessed memories
 *   5. Purge expired working memories
 *
 * Conservative by design — does not delete source episodic memories.
 */

import { launchClaude } from '@jane-core/claude-launcher';
import { listMemories, recordMemory, recordPattern, applyImportanceDecay, purgeExpiredMemories } from './registry.js';
import { getSchedulerState, setSchedulerState } from '../layers/registry.js';
import type { Memory } from './types.js';

const CLAUDE_MODEL = process.env.CONSOLIDATION_CLAUDE_MODEL || 'claude-sonnet-4-6';
const CONSOLIDATION_INTERVAL_MS = parseInt(process.env.MEMORY_CONSOLIDATION_INTERVAL_MS || String(12 * 60 * 60 * 1000), 10);
const LAUNCH_TIMEOUT_MS = 120_000;
const SCHEDULER_KEY = 'memory-consolidator';

let consolidationTimer: ReturnType<typeof setTimeout> | null = null;
let isRunning = false;
let lastRunAt: Date | null = null;
let lastRunResult: ConsolidationResult | null = null;

export interface ConsolidationResult {
  semanticMemoriesCreated: number;
  patternsUpserted: number;
  memoriesDecayed: number;
  expiredPurged: number;
  durationMs: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export function startConsolidator(): void {
  log('info', 'Memory consolidator started', { intervalMs: CONSOLIDATION_INTERVAL_MS });

  // Check persisted state and catch up if needed, then schedule next run
  getSchedulerState(SCHEDULER_KEY)
    .then((state) => {
      if (!state?.nextRunAt) {
        scheduleNext();
        return;
      }

      const remaining = new Date(state.nextRunAt as string).getTime() - Date.now();

      if (remaining <= 0) {
        // Overdue — run immediately then schedule normally
        log('info', 'Memory consolidator overdue — running catch-up', { overdueMs: -remaining });
        runConsolidation()
          .catch((err) => log('error', 'Catch-up consolidation failed', { error: String(err) }))
          .finally(() => scheduleNext());
      } else {
        // Not yet due — schedule for the right time, then switch to regular interval
        log('info', 'Memory consolidator rescheduling to match persisted schedule', { remainingMs: remaining });
        consolidationTimer = setTimeout(async () => {
          try { await runConsolidation(); } catch (err) {
            log('error', 'Scheduled consolidation threw', { error: String(err) });
          }
          scheduleNext();
        }, remaining);
      }
    })
    .catch(() => scheduleNext()); // If DB unavailable, proceed with normal schedule
}

export function stopConsolidator(): void {
  if (consolidationTimer) {
    clearTimeout(consolidationTimer);
    consolidationTimer = null;
  }
}

export function isConsolidating(): boolean {
  return isRunning;
}

export function getLastConsolidationResult(): { lastRunAt: Date | null; result: ConsolidationResult | null } {
  return { lastRunAt, result: lastRunResult };
}

// ---------------------------------------------------------------------------
// Consolidation run
// ---------------------------------------------------------------------------

export async function runConsolidation(): Promise<ConsolidationResult> {
  if (isRunning) {
    throw new Error('Consolidation already in progress');
  }

  isRunning = true;
  const start = Date.now();
  const result: ConsolidationResult = {
    semanticMemoriesCreated: 0,
    patternsUpserted: 0,
    memoriesDecayed: 0,
    expiredPurged: 0,
    durationMs: 0,
  };

  try {
    log('info', 'Starting memory consolidation');

    // 1. Maintenance: decay old episodes + purge expired
    result.memoriesDecayed = await applyImportanceDecay({ olderThanDays: 14, decayFactor: 0.05 });
    result.expiredPurged = await purgeExpiredMemories();

    // 2. Fetch recent episodic memories for synthesis
    const episodics = await listMemories({
      type: 'episodic',
      minImportance: 0.4,
      limit: 30,
    });

    if (episodics.length >= 3) {
      const synthesis = await synthesizeMemories(episodics);
      result.semanticMemoriesCreated = synthesis.semanticCount;
      result.patternsUpserted = synthesis.patternCount;
    } else {
      log('info', 'Too few episodic memories for synthesis', { count: episodics.length });
    }

    result.durationMs = Date.now() - start;
    lastRunResult = result;
    lastRunAt = new Date();
    log('info', 'Memory consolidation complete', result as unknown as Record<string, unknown>);
    return result;
  } catch (err) {
    result.error = String(err);
    result.durationMs = Date.now() - start;
    lastRunResult = result;
    lastRunAt = new Date();
    log('error', 'Memory consolidation failed', { error: result.error });
    return result;
  } finally {
    isRunning = false;
  }
}

// ---------------------------------------------------------------------------
// LLM-based synthesis
// ---------------------------------------------------------------------------

async function synthesizeMemories(memories: Memory[]): Promise<{ semanticCount: number; patternCount: number }> {
  const memoryText = memories
    .map((m, i) => `${i + 1}. [${m.type}/${m.source}] ${m.title}\n   ${m.content.slice(0, 250)}`)
    .join('\n\n');

  const prompt = `You are Jane's memory consolidator. Analyze these recent memories and extract:
1. Key patterns (recurring themes, successes, failures)
2. Semantic facts worth remembering long-term

## Recent Memories
${memoryText}

## Instructions
Respond ONLY with valid JSON, no markdown:
{
  "patterns": [
    { "type": "success|failure|recurring|behavioral", "description": "concise pattern description", "confidence": 0.7 }
  ],
  "semantic_memories": [
    { "title": "short title", "content": "distilled fact or insight", "tags": ["tag1", "tag2"], "importance": 0.6 }
  ]
}

Extract 0-3 patterns and 0-3 semantic memories. Only include genuinely useful, non-obvious insights. If nothing notable, return empty arrays.`;

  try {
    const raw = await claudeGenerate(prompt);
    const parsed = extractJson(raw) as {
      patterns?: Array<{ type: string; description: string; confidence: number }>;
      semantic_memories?: Array<{ title: string; content: string; tags: string[]; importance: number }>;
    };

    let patternCount = 0;
    let semanticCount = 0;

    if (Array.isArray(parsed.patterns)) {
      for (const p of parsed.patterns) {
        if (p.description && p.type) {
          await recordPattern({
            patternType: p.type,
            description: p.description,
            confidence: Math.max(0.1, Math.min(1, p.confidence ?? 0.5)),
          }).catch((err) => log('warn', 'Failed to record pattern', { type: p.type, error: String(err) }));
          patternCount++;
        }
      }
    }

    if (Array.isArray(parsed.semantic_memories)) {
      for (const sm of parsed.semantic_memories) {
        if (sm.title && sm.content) {
          await recordMemory({
            type: 'semantic',
            source: 'consolidation',
            title: sm.title,
            content: sm.content,
            tags: Array.isArray(sm.tags) ? sm.tags : [],
            importance: Math.max(0.3, Math.min(1, sm.importance ?? 0.6)),
          }).catch((err) => log('warn', 'Failed to record semantic memory', { title: sm.title, error: String(err) }));
          semanticCount++;
        }
      }
    }

    return { patternCount, semanticCount };
  } catch (err) {
    log('warn', 'Synthesis failed — skipping', { error: String(err) });
    return { patternCount: 0, semanticCount: 0 };
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function scheduleNext(): void {
  setSchedulerState(SCHEDULER_KEY, {
    nextRunAt: new Date(Date.now() + CONSOLIDATION_INTERVAL_MS).toISOString(),
  }).catch((err) => log('warn', 'Failed to persist consolidator scheduler state', { error: String(err) }));

  consolidationTimer = setTimeout(async () => {
    try {
      await runConsolidation();
    } catch (err) {
      log('error', 'Scheduled consolidation threw', { error: String(err) });
    }
    scheduleNext();
  }, CONSOLIDATION_INTERVAL_MS);
}

async function claudeGenerate(prompt: string): Promise<string> {
  const result = await launchClaude({
    prompt,
    model: CLAUDE_MODEL,
    outputFormat: 'text',
    maxTurns: 1,
    timeout: LAUNCH_TIMEOUT_MS,
  });

  if (result.timedOut) throw new Error('Claude launcher timed out');
  if (result.exitCode !== 0) throw new Error(`Claude launcher exited with code ${result.exitCode}`);
  const text = result.stdout.trim();
  if (!text) throw new Error('Claude launcher returned empty response');
  return text;
}

function extractJson(text: string): unknown {
  const start = text.search(/[\[{]/);
  if (start === -1) throw new Error('No JSON found in response');
  const end = text.lastIndexOf(text[start] === '[' ? ']' : '}');
  if (end === -1) throw new Error('Unclosed JSON in response');
  return JSON.parse(text.slice(start, end + 1));
}

function log(level: string, msg: string, extra?: Record<string, unknown>): void {
  console.log(JSON.stringify({ level, msg, component: 'memory-consolidator', ts: new Date().toISOString(), ...extra }));
}
