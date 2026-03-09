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
