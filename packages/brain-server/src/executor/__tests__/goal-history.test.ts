/**
 * Goal history context module tests.
 *
 * Verifies that the module correctly resolves goal IDs from session metadata
 * and formats prior action history for injection into the executor's prompt.
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

import goalHistoryModule, { _resetPool } from '../context/modules/goal-history.js';
import type { ContextModuleParams, ResolvedContextPlan } from '../../executor/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const GOAL_ID = '11111111-1111-1111-1111-111111111111';
const SESSION_ID = '22222222-2222-2222-2222-222222222222';

const basePlan: ResolvedContextPlan = {
  summaryChunkSize: 6,
  summaryModel: 'gemma3:12b',
  summaryPromptTemplate: '',
  rawSummarizationThreshold: 12,
  maxSummaries: 10,
  modelContextSize: 200000,
  tokenBudgetPct: 0.06,
  tokenBudget: 12000,
  modules: ['goal-history'],
  topicTrackingEnabled: false,
  associativeRetrievalEnabled: false,
};

function makeParams(sessionId: string): ContextModuleParams {
  return { sessionId, role: 'executor', prompt: 'do something', plan: basePlan };
}

// ---------------------------------------------------------------------------
// Tests: no session ID
// ---------------------------------------------------------------------------

describe('goal-history: no sessionId', () => {
  beforeEach(() => { vi.clearAllMocks(); _resetPool(); });

  it('returns null when no sessionId provided', async () => {
    const params: ContextModuleParams = { role: 'executor', prompt: 'test', plan: basePlan };
    const result = await goalHistoryModule.assemble(params);
    expect(result).toBeNull();
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests: goal ID from session metadata
// ---------------------------------------------------------------------------

describe('goal-history: resolve from session metadata', () => {
  beforeEach(() => { vi.clearAllMocks(); _resetPool(); });

  it('returns null when session has no goalId metadata', async () => {
    // Session query returns no goalId
    mockQuery.mockResolvedValueOnce({ rows: [{ metadata: { type: 'other' } }] });
    // Goal fallback query returns nothing
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await goalHistoryModule.assemble(makeParams(SESSION_ID));
    expect(result).toBeNull();
  });

  it('reads goalId from session metadata', async () => {
    // Session metadata contains goalId
    mockQuery.mockResolvedValueOnce({ rows: [{ metadata: { goalId: GOAL_ID } }] });
    // Goal details query
    mockQuery.mockResolvedValueOnce({ rows: [{ id: GOAL_ID, title: 'Test Goal', description: 'A test goal' }] });
    // Actions query — empty
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await goalHistoryModule.assemble(makeParams(SESSION_ID));
    // No actions — should return null
    expect(result).toBeNull();
  });

  it('returns fragment when prior actions exist', async () => {
    // Session metadata contains goalId
    mockQuery.mockResolvedValueOnce({ rows: [{ metadata: { goalId: GOAL_ID } }] });
    // Goal details
    mockQuery.mockResolvedValueOnce({ rows: [{ id: GOAL_ID, title: 'Fix Tests', description: 'Make all tests pass' }] });
    // Prior actions
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 'aaa',
          description: 'Ran test suite and identified failing tests',
          status: 'done',
          outcome_text: 'Found 3 failures in auth module',
          review_text: 'Good progress, auth fixes needed',
          created_at: '2026-03-09T00:00:00Z',
          updated_at: '2026-03-09T01:00:00Z',
        },
        {
          id: 'bbb',
          description: 'Attempted to fix auth module',
          status: 'failed',
          outcome_text: null,
          review_text: 'No changes were made',
          created_at: '2026-03-09T02:00:00Z',
          updated_at: '2026-03-09T03:00:00Z',
        },
      ],
    });

    const result = await goalHistoryModule.assemble(makeParams(SESSION_ID));
    expect(result).not.toBeNull();
    expect(result!.source).toBe('goal-history');
    expect(result!.text).toContain('GOAL HISTORY');
    expect(result!.text).toContain('Fix Tests');
    expect(result!.text).toContain('Prior actions (2');
    expect(result!.text).toContain('Ran test suite');
    expect(result!.text).toContain('Found 3 failures');
    expect(result!.text).toContain('Attempted to fix auth module');
    expect(result!.tokenEstimate).toBeGreaterThan(0);
    expect(result!.meta?.goalId).toBe(GOAL_ID);
    expect(result!.meta?.actionCount).toBe(2);
    expect(result!.meta?.orphanedCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: goal ID fallback (sessionId IS a goal ID)
// ---------------------------------------------------------------------------

describe('goal-history: session ID is a goal ID', () => {
  beforeEach(() => { vi.clearAllMocks(); _resetPool(); });

  it('falls back to treating sessionId as goalId', async () => {
    // Session query returns no metadata (session not in brain.sessions)
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // Fallback: check if sessionId is a goal ID
    mockQuery.mockResolvedValueOnce({ rows: [{ id: GOAL_ID }] });
    // Goal details
    mockQuery.mockResolvedValueOnce({ rows: [{ id: GOAL_ID, title: 'My Goal', description: 'Do something' }] });
    // Actions
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'ccc',
        description: 'Did the thing',
        status: 'done',
        outcome_text: 'It worked',
        review_text: null,
        created_at: '2026-03-09T00:00:00Z',
        updated_at: '2026-03-09T01:00:00Z',
      }],
    });

    const result = await goalHistoryModule.assemble(makeParams(GOAL_ID));
    expect(result).not.toBeNull();
    expect(result!.text).toContain('My Goal');
    expect(result!.text).toContain('Did the thing');
  });
});

// ---------------------------------------------------------------------------
// Tests: orphaned startup recovery filtering
// ---------------------------------------------------------------------------

describe('goal-history: orphaned startup recovery filtering', () => {
  beforeEach(() => { vi.clearAllMocks(); _resetPool(); });

  const ORPHANED_OUTCOME = 'Recovered at startup: PID 12345 no longer exists (orphaned by previous server restart)';

  it('filters orphaned actions and notes count in header', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ metadata: { goalId: GOAL_ID } }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: GOAL_ID, title: 'Deploy Brain', description: 'Release and deploy' }] });
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 'aaa',
          description: 'Real deploy attempt',
          status: 'done',
          outcome_text: 'Deployed v0.4.4 successfully',
          review_text: null,
          created_at: '2026-03-10T00:00:00Z',
          updated_at: '2026-03-10T01:00:00Z',
        },
        {
          id: 'bbb',
          description: 'Retry deploy',
          status: 'failed',
          outcome_text: ORPHANED_OUTCOME,
          review_text: null,
          created_at: '2026-03-09T23:00:00Z',
          updated_at: '2026-03-09T23:30:00Z',
        },
        {
          id: 'ccc',
          description: 'First deploy attempt',
          status: 'failed',
          outcome_text: ORPHANED_OUTCOME,
          review_text: null,
          created_at: '2026-03-09T22:00:00Z',
          updated_at: '2026-03-09T22:30:00Z',
        },
      ],
    });

    const result = await goalHistoryModule.assemble(makeParams(SESSION_ID));
    expect(result).not.toBeNull();
    // Real action should appear
    expect(result!.text).toContain('Real deploy attempt');
    expect(result!.text).toContain('Deployed v0.4.4 successfully');
    // Orphaned actions should NOT appear as work attempts
    expect(result!.text).not.toContain('Retry deploy');
    expect(result!.text).not.toContain('First deploy attempt');
    expect(result!.text).not.toContain('PID 12345');
    // Header should note the excluded count
    expect(result!.text).toContain('2 infrastructure interruption');
    expect(result!.text).toContain('Prior actions (1');
    // Meta should reflect filtered counts
    expect(result!.meta?.actionCount).toBe(1);
    expect(result!.meta?.orphanedCount).toBe(2);
  });

  it('returns informative message when all actions are orphaned', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ metadata: { goalId: GOAL_ID } }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: GOAL_ID, title: 'Deploy', description: 'Deploy the server' }] });
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 'aaa',
          description: 'Deploy attempt',
          status: 'failed',
          outcome_text: ORPHANED_OUTCOME,
          review_text: null,
          created_at: '2026-03-09T22:00:00Z',
          updated_at: '2026-03-09T22:30:00Z',
        },
      ],
    });

    const result = await goalHistoryModule.assemble(makeParams(SESSION_ID));
    // Should return a fragment (not null) to inform agent that goal has been attempted
    expect(result).not.toBeNull();
    expect(result!.text).toContain('No completed work attempts yet');
    expect(result!.text).toContain('1 infrastructure interruption');
    expect(result!.meta?.actionCount).toBe(0);
    expect(result!.meta?.orphanedCount).toBe(1);
  });

  it('does not mention interruptions when all actions are real work', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ metadata: { goalId: GOAL_ID } }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: GOAL_ID, title: 'Fix Bug', description: 'Fix the bug' }] });
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'aaa',
        description: 'Fixed the bug',
        status: 'done',
        outcome_text: 'Bug is fixed',
        review_text: null,
        created_at: '2026-03-09T00:00:00Z',
        updated_at: '2026-03-09T01:00:00Z',
      }],
    });

    const result = await goalHistoryModule.assemble(makeParams(SESSION_ID));
    expect(result).not.toBeNull();
    expect(result!.text).not.toContain('infrastructure interruption');
    expect(result!.text).toContain('Prior actions (1, newest first):');
    expect(result!.meta?.orphanedCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: error handling
// ---------------------------------------------------------------------------

describe('goal-history: error handling', () => {
  beforeEach(() => { vi.clearAllMocks(); _resetPool(); });

  it('returns null on DB error (does not throw)', async () => {
    mockQuery.mockRejectedValueOnce(new Error('DB connection failed'));
    const result = await goalHistoryModule.assemble(makeParams(SESSION_ID));
    expect(result).toBeNull();
  });
});
