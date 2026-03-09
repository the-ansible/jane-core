/**
 * Goal action snapshot writer tests.
 *
 * Verifies that writeGoalActionSnapshot() correctly writes to context.summaries
 * with proper sequential indexing and summary formatting.
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

// Mock the compaction module so it doesn't interfere with snapshot tests
vi.mock('../goal-compaction.js', () => ({
  compactGoalSessionIfNeeded: vi.fn().mockResolvedValue(undefined),
}));

import { writeGoalActionSnapshot, _resetPool } from '../goal-snapshots.js';

const GOAL_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

beforeEach(() => {
  vi.clearAllMocks();
  _resetPool();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('writeGoalActionSnapshot', () => {
  it('inserts a context.summaries row with correct fields', async () => {
    // First query: count existing snapshots → 0
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] });
    // Second query: INSERT
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await writeGoalActionSnapshot({
      goalSessionId: GOAL_ID,
      description: 'Implement Phase 5.2 goal snapshots',
      outcomeText: 'Created goal-snapshots.ts and integrated into engine.ts',
      reviewText: 'Significant progress. Snapshot written correctly.',
      startedAt: new Date('2026-03-09T08:00:00Z'),
      completedAt: new Date('2026-03-09T09:00:00Z'),
      status: 'done',
    });

    expect(mockQuery).toHaveBeenCalledTimes(2);

    // Verify count query
    const countCall = mockQuery.mock.calls[0];
    expect(countCall[0]).toContain('COUNT(*)');
    expect(countCall[0]).toContain('context.summaries');
    expect(countCall[1]).toEqual([GOAL_ID]);

    // Verify insert query
    const insertCall = mockQuery.mock.calls[1];
    expect(insertCall[0]).toContain('INSERT INTO context.summaries');
    expect(insertCall[1][0]).toBe(GOAL_ID);  // session_id
    const summary = insertCall[1][1];
    expect(summary).toContain('COMPLETED');
    expect(summary).toContain('Implement Phase 5.2 goal snapshots');
    expect(summary).toContain('Created goal-snapshots.ts');
    expect(summary).toContain('Significant progress');
    expect(insertCall[1][3]).toBe(0);  // msg_idx = 0 for first snapshot
    expect(insertCall[1][4]).toBe('2026-03-09T08:00:00.000Z');  // ts_start
    expect(insertCall[1][5]).toBe('2026-03-09T09:00:00.000Z');  // ts_end
  });

  it('uses sequential index based on existing snapshot count', async () => {
    // Three existing snapshots → next index is 3
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '3' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await writeGoalActionSnapshot({
      goalSessionId: GOAL_ID,
      description: 'Fourth action on this goal',
      outcomeText: 'Done.',
      reviewText: null,
      startedAt: new Date('2026-03-09T10:00:00Z'),
      completedAt: new Date('2026-03-09T11:00:00Z'),
      status: 'done',
    });

    const insertCall = mockQuery.mock.calls[1];
    expect(insertCall[1][3]).toBe(3);  // msg_idx = 3 (0-based, 4th snapshot)
  });

  it('labels failed actions correctly', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '1' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await writeGoalActionSnapshot({
      goalSessionId: GOAL_ID,
      description: 'Failed to migrate scheduler',
      outcomeText: 'Error: connection refused',
      reviewText: 'The action did not complete — infrastructure was unavailable.',
      startedAt: new Date('2026-03-09T08:00:00Z'),
      completedAt: new Date('2026-03-09T09:00:00Z'),
      status: 'failed',
    });

    const insertCall = mockQuery.mock.calls[1];
    const summary = insertCall[1][1];
    expect(summary).toContain('FAILED');
    expect(summary).not.toContain('COMPLETED');
  });

  it('handles null outcomeText and reviewText gracefully', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await writeGoalActionSnapshot({
      goalSessionId: GOAL_ID,
      description: 'Minimal action with no output',
      outcomeText: null,
      reviewText: null,
      startedAt: new Date('2026-03-09T08:00:00Z'),
      completedAt: new Date('2026-03-09T09:00:00Z'),
      status: 'done',
    });

    const insertCall = mockQuery.mock.calls[1];
    const summary = insertCall[1][1];
    expect(summary).toContain('Minimal action with no output');
    // Should not contain "Outcome:" or "Review:" sections
    expect(summary).not.toContain('Outcome:');
    expect(summary).not.toContain('Review:');
  });

  it('uses ON CONFLICT DO NOTHING to prevent duplicate entries', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await writeGoalActionSnapshot({
      goalSessionId: GOAL_ID,
      description: 'Some action',
      outcomeText: 'Done.',
      reviewText: 'Good.',
      startedAt: new Date('2026-03-09T08:00:00Z'),
      completedAt: new Date('2026-03-09T09:00:00Z'),
      status: 'done',
    });

    const insertCall = mockQuery.mock.calls[1];
    expect(insertCall[0]).toContain('ON CONFLICT');
    expect(insertCall[0]).toContain('DO NOTHING');
  });

  it('uses plan_name = goal-action-snapshot and model = goal-engine', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await writeGoalActionSnapshot({
      goalSessionId: GOAL_ID,
      description: 'Some action',
      outcomeText: null,
      reviewText: null,
      startedAt: new Date('2026-03-09T08:00:00Z'),
      completedAt: new Date('2026-03-09T09:00:00Z'),
      status: 'done',
    });

    const insertCall = mockQuery.mock.calls[1];
    expect(insertCall[0]).toContain("'goal-engine'");
    expect(insertCall[0]).toContain("'goal-action-snapshot'");
  });
});
