import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Use temp session dir
process.env.SESSIONS_DIR = mkdtempSync(join(tmpdir(), 'assembler-test-'));

// Mock the DB module
vi.mock('../context/db.js', () => {
  const queries: any[] = [];
  return {
    db: {
      query: vi.fn(async (sql: string, params?: any[]) => {
        queries.push({ sql, params });
        // Route by SQL content
        if (sql.includes('FROM context.summaries')) {
          return { rows: (globalThis as any).__mockSummaryRows || [] };
        }
        if (sql.includes('INSERT INTO context.assembly_log')) {
          return { rows: [] };
        }
        if (sql.includes('INSERT INTO context.summaries')) {
          return { rows: [] };
        }
        return { rows: [] };
      }),
      exec: vi.fn(),
    },
    initializeContextDb: vi.fn(),
    updateAssemblyOutcome: vi.fn(),
    _resetPool: vi.fn(),
    _getQueries: () => queries,
  };
});

// Mock plans module
vi.mock('../context/plans.js', () => ({
  getActivePlan: vi.fn().mockResolvedValue({
    name: 'baseline_v1',
    config: {
      summaryChunkSize: 6,
      summaryModel: 'gemma3:12b',
      summaryPromptTemplate: 'default_v1',
      rawSummarizationThreshold: 12,
      maxSummaries: 10,
      modelContextSize: 200000,
      tokenBudgetPct: 0.06,
      composer: { maxSummaries: 3, tokenBudgetPct: 0.02 },
      topicTrackingEnabled: false,
      associativeRetrievalEnabled: false,
    },
  }),
  resolvePlan: vi.fn((config: any, component: string) => {
    const overrides = config[component] || {};
    return {
      ...config,
      maxSummaries: overrides.maxSummaries ?? config.maxSummaries,
      tokenBudgetPct: overrides.tokenBudgetPct ?? config.tokenBudgetPct,
    };
  }),
  _resetPlanCache: vi.fn(),
}));

// Mock summarizer
vi.mock('../context/summarizer.js', () => ({
  summarizeChunk: vi.fn().mockResolvedValue({
    id: 'test-summary-id',
    sessionId: 'test-session',
    summary: 'Test summary of conversation',
    topics: ['testing'],
    entities: ['Chris', 'Jane'],
    msgStartIdx: 0,
    msgEndIdx: 5,
    msgCount: 6,
    tsStart: '2026-03-01T10:00:00.000Z',
    tsEnd: '2026-03-01T10:30:00.000Z',
    model: 'gemma3:12b',
    promptTokens: 100,
    outputTokens: 50,
    latencyMs: 200,
    planName: 'baseline_v1',
    createdAt: new Date().toISOString(),
  }),
}));

import { assembleContext } from '../context/assembler.js';
import { appendMessage, clearAllSessions } from '../sessions/store.js';
import { db } from '../context/db.js';
import { summarizeChunk } from '../context/summarizer.js';

const mockDb = vi.mocked(db);
const mockSummarize = vi.mocked(summarizeChunk);

function seedMessages(sessionId: string, count: number) {
  for (let i = 0; i < count; i++) {
    const role = i % 2 === 0 ? 'user' : 'assistant';
    appendMessage(sessionId, {
      role: role as 'user' | 'assistant',
      content: `Message ${i + 1}`,
      timestamp: new Date(Date.now() - (count - i) * 60000).toISOString(),
    });
  }
}

describe('Context Assembler', () => {
  beforeEach(() => {
    clearAllSessions();
    vi.clearAllMocks();
    (globalThis as any).__mockSummaryRows = [];
  });

  it('falls back to raw messages when no summaries exist', async () => {
    seedMessages('no-summaries', 5);

    const result = await assembleContext('no-summaries', 'agent');

    expect(result.summaries).toEqual([]);
    expect(result.recentMessages).toHaveLength(5);
    expect(result.meta.summaryCount).toBe(0);
    expect(result.meta.rawMessageCount).toBe(5);
    expect(result.meta.planName).toBe('baseline_v1');
  });

  it('includes existing summaries with raw messages', async () => {
    seedMessages('with-summaries', 8);

    (globalThis as any).__mockSummaryRows = [
      {
        id: 'sum-1',
        session_id: 'with-summaries',
        summary: 'Earlier conversation about project setup',
        topics: ['setup', 'config'],
        entities: ['Chris'],
        msg_start_idx: 0,
        msg_end_idx: 3,
        msg_count: 4,
        ts_start: '2026-03-01T09:00:00.000Z',
        ts_end: '2026-03-01T09:20:00.000Z',
        model: 'gemma3:12b',
        plan_name: 'baseline_v1',
      },
    ];

    const result = await assembleContext('with-summaries', 'agent');

    expect(result.summaries).toHaveLength(1);
    expect(result.summaries[0].text).toBe('Earlier conversation about project setup');
    expect(result.summaries[0].topics).toEqual(['setup', 'config']);
    // Raw messages should be from boundary+1 (4) to end (7)
    expect(result.recentMessages).toHaveLength(4);
    expect(result.meta.summaryCount).toBe(1);
    expect(result.meta.rawMessageCount).toBe(4);
    expect(result.meta.totalMessageCoverage).toBe(8); // 4 summarized + 4 raw
  });

  it('respects token budget for summaries', async () => {
    seedMessages('budget-test', 5);

    // Create summaries that exceed budget (budget = 200000 * 0.06 = 12000 tokens)
    // Each summary is ~50 chars = ~13 tokens, way under budget
    // But let's test the limit path with maxSummaries
    const manySummaries = [];
    for (let i = 0; i < 15; i++) {
      manySummaries.push({
        id: `sum-${i}`,
        session_id: 'budget-test',
        summary: `Summary ${i} of conversation chunk`,
        topics: ['topic'],
        entities: [],
        msg_start_idx: i * 2,
        msg_end_idx: i * 2 + 1,
        msg_count: 2,
        ts_start: `2026-03-01T0${Math.floor(i / 6)}:${(i * 10) % 60}:00.000Z`,
        ts_end: `2026-03-01T0${Math.floor(i / 6)}:${(i * 10 + 5) % 60}:00.000Z`,
        model: 'gemma3:12b',
        plan_name: 'baseline_v1',
      });
    }
    (globalThis as any).__mockSummaryRows = manySummaries;

    const result = await assembleContext('budget-test', 'agent');

    // Should be capped at maxSummaries (10 for agent)
    expect(result.meta.summaryCount).toBeLessThanOrEqual(10);
  });

  it('applies composer overrides for fewer summaries', async () => {
    seedMessages('composer-test', 5);

    const summaries = [];
    for (let i = 0; i < 5; i++) {
      summaries.push({
        id: `sum-${i}`,
        session_id: 'composer-test',
        summary: `Summary ${i}`,
        topics: [],
        entities: [],
        msg_start_idx: i * 2,
        msg_end_idx: i * 2 + 1,
        msg_count: 2,
        ts_start: '2026-03-01T09:00:00.000Z',
        ts_end: '2026-03-01T09:10:00.000Z',
        model: 'gemma3:12b',
        plan_name: 'baseline_v1',
      });
    }
    (globalThis as any).__mockSummaryRows = summaries;

    const result = await assembleContext('composer-test', 'composer');

    // Composer maxSummaries is 3
    expect(result.meta.summaryCount).toBeLessThanOrEqual(3);
  });

  it('triggers eager summarization when raw exceeds threshold', async () => {
    // Seed 15 messages (exceeds threshold of 12)
    seedMessages('eager-test', 15);

    const result = await assembleContext('eager-test', 'agent');

    // Should have called summarizeChunk at least once
    expect(mockSummarize).toHaveBeenCalled();
    expect(result.meta.newSummariesCreated).toBeGreaterThan(0);
    expect(result.meta.summarizationMs).not.toBeNull();
  });

  it('does not trigger summarization when under threshold', async () => {
    seedMessages('under-threshold', 8);

    await assembleContext('under-threshold', 'agent');

    expect(mockSummarize).not.toHaveBeenCalled();
  });

  it('logs assembly to assembly_log table', async () => {
    seedMessages('log-test', 5);

    await assembleContext('log-test', 'agent', 'event-123');

    // Check that assembly_log INSERT was called
    const insertCalls = mockDb.query.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].includes('INSERT INTO context.assembly_log')
    );
    expect(insertCalls.length).toBe(1);
    // Check event_id was passed
    const params = insertCalls[0][1] as any[];
    expect(params[2]).toBe('event-123'); // event_id position
  });

  it('returns rawOverBudget warning when appropriate', async () => {
    // Create a session with messages that have very long content
    for (let i = 0; i < 5; i++) {
      appendMessage('huge-raw', {
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: 'x'.repeat(20000), // ~5000 tokens each
        timestamp: new Date(Date.now() - (5 - i) * 60000).toISOString(),
      });
    }

    // With composer budget = 200000 * 0.02 = 4000 tokens, 5 messages of 5000 tokens = 25000 >> 4000
    const result = await assembleContext('huge-raw', 'composer');

    expect(result.meta.rawOverBudget).toBe(true);
    // But raw messages are still included (non-negotiable)
    expect(result.recentMessages).toHaveLength(5);
  });

  it('handles empty session gracefully', async () => {
    const result = await assembleContext('empty-session', 'agent');

    expect(result.summaries).toEqual([]);
    expect(result.recentMessages).toHaveLength(0);
    expect(result.meta.rawMessageCount).toBe(0);
    expect(result.meta.summaryCount).toBe(0);
  });
});
