/**
 * Goal session compaction tests.
 *
 * Verifies that compactGoalSessionIfNeeded() correctly triggers compaction
 * when the threshold is exceeded, and does nothing when below threshold.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock pg Pool
// ---------------------------------------------------------------------------

const mockQuery = vi.fn();
vi.mock('pg', () => ({
  default: {
    Pool: vi.fn(() => ({
      query: (...args: any[]) => mockQuery(...args),
    })),
  },
}));

vi.stubEnv('JANE_DATABASE_URL', 'postgres://test:test@localhost/test');

// ---------------------------------------------------------------------------
// Mock summarizer
// ---------------------------------------------------------------------------

const mockSummarizeTexts = vi.fn();
vi.mock('../context/summarizer.js', () => ({
  summarizeTexts: (...args: any[]) => mockSummarizeTexts(...args),
}));

import { compactGoalSessionIfNeeded, _resetPool } from '../goal-compaction.js';

const GOAL_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

const SUMMARY_RESULT = {
  summary: 'Compacted: phases 1-5 implemented and released.',
  topics: ['brain-server', 'executor'],
  entities: ['Jane', 'brain-server'],
  latencyMs: 200,
  model: 'haiku',
  promptTokens: 500,
  outputTokens: 100,
};

function makeRows(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `id-${i}`,
    summary: `Action ${i + 1}: some work done.`,
    topics: ['topic-a'],
    entities: ['Jane'],
    ts_start: `2026-03-09T0${i}:00:00Z`,
    ts_end: `2026-03-09T0${i}:30:00Z`,
    msg_start_idx: i,
    msg_end_idx: i,
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetPool();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('compactGoalSessionIfNeeded', () => {
  it('does nothing when count is below threshold (15)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '10' }] });

    await compactGoalSessionIfNeeded(GOAL_ID);

    // Only 1 query (count check), no summarization, no insert/delete
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockSummarizeTexts).not.toHaveBeenCalled();
  });

  it('does nothing when count is exactly at threshold (15)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '15' }] });

    await compactGoalSessionIfNeeded(GOAL_ID);

    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockSummarizeTexts).not.toHaveBeenCalled();
  });

  it('triggers compaction when count exceeds threshold (16)', async () => {
    // Count check → 16
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '16' }] });
    // Oldest 5 entries
    mockQuery.mockResolvedValueOnce({ rows: makeRows(5) });
    // BEGIN
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // INSERT compacted
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // DELETE originals
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // COMMIT
    mockQuery.mockResolvedValueOnce({ rows: [] });

    mockSummarizeTexts.mockResolvedValueOnce(SUMMARY_RESULT);

    await compactGoalSessionIfNeeded(GOAL_ID);

    expect(mockSummarizeTexts).toHaveBeenCalledOnce();
    // Verify the texts passed to summarizer
    const texts = mockSummarizeTexts.mock.calls[0][0];
    expect(texts).toHaveLength(5);
    expect(texts[0]).toContain('Action 1');
  });

  it('inserts compacted entry with correct plan_name', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '20' }] });
    mockQuery.mockResolvedValueOnce({ rows: makeRows(5) });
    mockQuery.mockResolvedValueOnce({ rows: [] }); // BEGIN
    mockQuery.mockResolvedValueOnce({ rows: [] }); // INSERT
    mockQuery.mockResolvedValueOnce({ rows: [] }); // DELETE
    mockQuery.mockResolvedValueOnce({ rows: [] }); // COMMIT

    mockSummarizeTexts.mockResolvedValueOnce(SUMMARY_RESULT);

    await compactGoalSessionIfNeeded(GOAL_ID);

    // Find the INSERT call
    const insertCall = mockQuery.mock.calls.find(([sql]) =>
      typeof sql === 'string' && sql.includes('INSERT INTO context.summaries')
    );
    expect(insertCall).toBeDefined();
    expect(insertCall![0]).toContain("'goal-action-compacted'");
    expect(insertCall![0]).toContain("'goal-engine'");
  });

  it('deletes the 5 original entries after compaction', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '16' }] });
    const rows = makeRows(5);
    mockQuery.mockResolvedValueOnce({ rows });
    mockQuery.mockResolvedValueOnce({ rows: [] }); // BEGIN
    mockQuery.mockResolvedValueOnce({ rows: [] }); // INSERT
    mockQuery.mockResolvedValueOnce({ rows: [] }); // DELETE
    mockQuery.mockResolvedValueOnce({ rows: [] }); // COMMIT

    mockSummarizeTexts.mockResolvedValueOnce(SUMMARY_RESULT);

    await compactGoalSessionIfNeeded(GOAL_ID);

    const deleteCall = mockQuery.mock.calls.find(([sql]) =>
      typeof sql === 'string' && sql.includes('DELETE FROM context.summaries')
    );
    expect(deleteCall).toBeDefined();
    // Should pass the array of IDs
    const ids = deleteCall![1][0];
    expect(ids).toEqual(['id-0', 'id-1', 'id-2', 'id-3', 'id-4']);
  });

  it('merges topics and entities from all compacted entries', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '16' }] });
    const rows = makeRows(5).map((r, i) => ({
      ...r,
      topics: [`topic-${i}`],
      entities: [`entity-${i}`],
    }));
    mockQuery.mockResolvedValueOnce({ rows });
    mockQuery.mockResolvedValueOnce({ rows: [] }); // BEGIN
    mockQuery.mockResolvedValueOnce({ rows: [] }); // INSERT
    mockQuery.mockResolvedValueOnce({ rows: [] }); // DELETE
    mockQuery.mockResolvedValueOnce({ rows: [] }); // COMMIT

    mockSummarizeTexts.mockResolvedValueOnce({
      ...SUMMARY_RESULT,
      topics: ['new-topic'],
      entities: ['new-entity'],
    });

    await compactGoalSessionIfNeeded(GOAL_ID);

    const insertCall = mockQuery.mock.calls.find(([sql]) =>
      typeof sql === 'string' && sql.includes('INSERT INTO context.summaries')
    );
    const topics: string[] = insertCall![1][2];
    const entities: string[] = insertCall![1][3];

    // Should include topics from rows + summarizer result
    expect(topics).toContain('topic-0');
    expect(topics).toContain('new-topic');
    expect(entities).toContain('entity-0');
    expect(entities).toContain('new-entity');
  });

  it('rolls back transaction if insert fails', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '16' }] });
    mockQuery.mockResolvedValueOnce({ rows: makeRows(5) });
    mockQuery.mockResolvedValueOnce({ rows: [] }); // BEGIN
    mockQuery.mockRejectedValueOnce(new Error('Insert failed')); // INSERT fails
    mockQuery.mockResolvedValueOnce({ rows: [] }); // ROLLBACK

    mockSummarizeTexts.mockResolvedValueOnce(SUMMARY_RESULT);

    // Should not throw — errors are caught and logged
    await expect(compactGoalSessionIfNeeded(GOAL_ID)).resolves.toBeUndefined();

    const rollbackCall = mockQuery.mock.calls.find(([sql]) =>
      typeof sql === 'string' && sql === 'ROLLBACK'
    );
    expect(rollbackCall).toBeDefined();
  });

  it('does not throw when query fails — errors are swallowed', async () => {
    mockQuery.mockRejectedValueOnce(new Error('DB connection lost'));

    await expect(compactGoalSessionIfNeeded(GOAL_ID)).resolves.toBeUndefined();
  });
});
