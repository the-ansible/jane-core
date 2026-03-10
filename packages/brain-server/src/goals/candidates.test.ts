/**
 * Tests for goals/candidates.ts — Phase 7.1 + Phase 8.1 (multi-dimensional scoring).
 *
 * Validates the invokeAdapter-based LLM invocation for candidate generation
 * and scoring. Mocks the executor module to avoid real LLM calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Goal, CandidateAction } from './types.js';
import { computeCompositeScore, SCORE_WEIGHTS } from './types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeGoal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: 'goal-1',
    title: 'Become a more capable assistant',
    description: 'Continuously improve reasoning and knowledge.',
    motivation: null,
    level: 'asymptotic',
    priority: 95,
    status: 'active',
    parent_id: null,
    success_criteria: null,
    progress_notes: null,
    last_evaluated_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// invokeAdapter mock
// ---------------------------------------------------------------------------

const mockInvokeAdapter = vi.fn();

vi.mock('../executor/index.js', () => ({
  invokeAdapter: mockInvokeAdapter,
}));

// Import AFTER mocking
const { generateCandidates, scoreCandidates, selectBestCandidate } = await import('./candidates.js');

beforeEach(() => {
  mockInvokeAdapter.mockReset();
});

// ---------------------------------------------------------------------------
// computeCompositeScore + SCORE_WEIGHTS — Phase 8.1
// ---------------------------------------------------------------------------

describe('computeCompositeScore', () => {
  it('weights sum to 1.0', () => {
    const total = Object.values(SCORE_WEIGHTS).reduce((sum, w) => sum + w, 0);
    expect(total).toBeCloseTo(1.0, 5);
  });

  it('computes correct weighted average for uniform score of 10', () => {
    const score = computeCompositeScore({ relevance: 10, impact: 10, urgency: 10, novelty: 10, feasibility: 10 });
    expect(score).toBeCloseTo(10, 5);
  });

  it('computes correct weighted average for uniform score of 1', () => {
    const score = computeCompositeScore({ relevance: 1, impact: 1, urgency: 1, novelty: 1, feasibility: 1 });
    expect(score).toBeCloseTo(1, 5);
  });

  it('computes correct weighted average for mixed scores', () => {
    // 9*0.35 + 8*0.25 + 7*0.20 + 6*0.10 + 10*0.10 = 3.15+2.0+1.4+0.6+1.0 = 8.15
    const score = computeCompositeScore({ relevance: 9, impact: 8, urgency: 7, novelty: 6, feasibility: 10 });
    expect(score).toBeCloseTo(8.15, 5);
  });

  it('gives highest weight to relevance', () => {
    // Relevance dominant (10 vs 1 for all others)
    const highRel = computeCompositeScore({ relevance: 10, impact: 1, urgency: 1, novelty: 1, feasibility: 1 });
    const highImp = computeCompositeScore({ relevance: 1, impact: 10, urgency: 1, novelty: 1, feasibility: 1 });
    expect(highRel).toBeGreaterThan(highImp); // relevance (35%) > impact (25%)
  });
});

// ---------------------------------------------------------------------------
// generateCandidates — Mercury primary
// ---------------------------------------------------------------------------

describe('generateCandidates', () => {
  it('parses valid candidate JSON from Mercury', async () => {
    const goals = [makeGoal()];
    const candidates = [
      {
        goalTitle: 'Become a more capable assistant',
        description: 'Read the vault for project documentation',
        rationale: 'Vault contains useful docs',
        needsWorkspace: false,
        projectPaths: [],
      },
    ];

    mockInvokeAdapter.mockResolvedValueOnce({
      success: true,
      resultText: JSON.stringify(candidates),
      rawOutput: '',
      durationMs: 100,
    });

    const result = await generateCandidates(goals, 'context string');

    expect(result).toHaveLength(1);
    expect(result[0].goalId).toBe('goal-1');
    expect(result[0].description).toBe('Read the vault for project documentation');
    expect(result[0].needsWorkspace).toBe(false);
  });

  it('falls back to Ollama when Mercury fails', async () => {
    const goals = [makeGoal()];
    const candidates = [
      {
        goalTitle: 'Become a more capable assistant',
        description: 'Fallback action',
        rationale: 'From Ollama',
        needsWorkspace: false,
        projectPaths: [],
      },
    ];

    // Mercury fails
    mockInvokeAdapter.mockResolvedValueOnce({
      success: false,
      resultText: null,
      rawOutput: '',
      durationMs: 0,
      error: 'MERCURY_API_KEY not set',
    });

    // Ollama succeeds
    mockInvokeAdapter.mockResolvedValueOnce({
      success: true,
      resultText: JSON.stringify(candidates),
      rawOutput: '',
      durationMs: 300,
    });

    const result = await generateCandidates(goals, 'context');

    expect(result).toHaveLength(1);
    expect(result[0].description).toBe('Fallback action');
    // Should have tried Mercury first, then Ollama
    expect(mockInvokeAdapter).toHaveBeenCalledTimes(2);
    expect(mockInvokeAdapter.mock.calls[0][0]).toMatchObject({ runtime: 'mercury' });
    expect(mockInvokeAdapter.mock.calls[1][0]).toMatchObject({ runtime: 'ollama' });
  });

  it('returns empty array when both adapters fail', async () => {
    const goals = [makeGoal()];

    mockInvokeAdapter.mockResolvedValueOnce({
      success: false, resultText: null, rawOutput: '', durationMs: 0, error: 'Mercury down',
    });
    mockInvokeAdapter.mockResolvedValueOnce({
      success: false, resultText: null, rawOutput: '', durationMs: 0, error: 'Ollama down',
    });

    const result = await generateCandidates(goals, 'context');
    expect(result).toHaveLength(0);
  });

  it('filters candidates whose goalTitle does not match any active goal', async () => {
    const goals = [makeGoal()];
    const candidates = [
      {
        goalTitle: 'Nonexistent Goal Title',
        description: 'This should be filtered',
        rationale: 'No match',
        needsWorkspace: false,
        projectPaths: [],
      },
    ];

    mockInvokeAdapter.mockResolvedValueOnce({
      success: true,
      resultText: JSON.stringify(candidates),
      rawOutput: '',
      durationMs: 50,
    });

    const result = await generateCandidates(goals, 'context');
    expect(result).toHaveLength(0);
  });

  it('matches goals case-insensitively', async () => {
    const goals = [makeGoal()];
    const candidates = [
      {
        goalTitle: 'BECOME A MORE CAPABLE ASSISTANT', // uppercase
        description: 'Case-insensitive match',
        rationale: 'Should match',
        needsWorkspace: false,
        projectPaths: [],
      },
    ];

    mockInvokeAdapter.mockResolvedValueOnce({
      success: true,
      resultText: JSON.stringify(candidates),
      rawOutput: '',
      durationMs: 50,
    });

    const result = await generateCandidates(goals, 'context');
    expect(result).toHaveLength(1);
    expect(result[0].goalId).toBe('goal-1');
  });

  it('handles JSON embedded in surrounding text', async () => {
    const goals = [makeGoal()];
    const candidates = [
      {
        goalTitle: 'Become a more capable assistant',
        description: 'Action in markdown',
        rationale: 'From markdown-wrapped JSON',
        needsWorkspace: false,
        projectPaths: [],
      },
    ];

    mockInvokeAdapter.mockResolvedValueOnce({
      success: true,
      resultText: `Here are my candidates:\n${JSON.stringify(candidates)}\nHope that helps!`,
      rawOutput: '',
      durationMs: 50,
    });

    const result = await generateCandidates(goals, 'context');
    expect(result).toHaveLength(1);
  });

  it('returns empty array for malformed JSON', async () => {
    const goals = [makeGoal()];

    mockInvokeAdapter.mockResolvedValueOnce({
      success: true,
      resultText: 'This is not JSON at all',
      rawOutput: '',
      durationMs: 50,
    });

    const result = await generateCandidates(goals, 'context');
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// scoreCandidates — Phase 8.1 multi-dimensional scoring
// ---------------------------------------------------------------------------

describe('scoreCandidates', () => {
  it('assigns structured breakdown scores and computes composite', async () => {
    const goals = [makeGoal()];
    const candidates: CandidateAction[] = [
      { goalId: 'goal-1', goalTitle: 'Become a more capable assistant', description: 'Action A', rationale: '', needsWorkspace: false, projectPaths: [] },
      { goalId: 'goal-1', goalTitle: 'Become a more capable assistant', description: 'Action B', rationale: '', needsWorkspace: false, projectPaths: [] },
    ];

    // LLM returns structured breakdown objects
    const breakdowns = [
      { relevance: 9, impact: 8, urgency: 7, novelty: 6, feasibility: 10 },
      { relevance: 3, impact: 4, urgency: 2, novelty: 9, feasibility: 8 },
    ];
    mockInvokeAdapter.mockResolvedValueOnce({
      success: true,
      resultText: JSON.stringify(breakdowns),
      rawOutput: '',
      durationMs: 50,
    });

    const result = await scoreCandidates(candidates, goals);

    // Sorted descending by composite score — Action A should win
    expect(result[0].description).toBe('Action A');
    expect(result[0].scoreBreakdown).toBeDefined();
    expect(result[0].scoreBreakdown?.relevance).toBe(9);
    expect(result[0].scoreBreakdown?.impact).toBe(8);
    expect(result[0].scoreBreakdown?.urgency).toBe(7);
    expect(result[0].scoreBreakdown?.novelty).toBe(6);
    expect(result[0].scoreBreakdown?.feasibility).toBe(10);

    // Composite: 9*0.35 + 8*0.25 + 7*0.20 + 6*0.10 + 10*0.10
    // = 3.15 + 2.0 + 1.4 + 0.6 + 1.0 = 8.15
    expect(result[0].score).toBeCloseTo(8.15, 1);

    expect(result[1].description).toBe('Action B');
    expect(result[1].scoreBreakdown?.relevance).toBe(3);
  });

  it('sorts candidates descending by composite score', async () => {
    const goals = [makeGoal()];
    const candidates: CandidateAction[] = [
      { goalId: 'goal-1', goalTitle: 'Become a more capable assistant', description: 'Low scorer', rationale: '', needsWorkspace: false, projectPaths: [] },
      { goalId: 'goal-1', goalTitle: 'Become a more capable assistant', description: 'High scorer', rationale: '', needsWorkspace: false, projectPaths: [] },
    ];

    mockInvokeAdapter.mockResolvedValueOnce({
      success: true,
      resultText: JSON.stringify([
        { relevance: 2, impact: 2, urgency: 2, novelty: 2, feasibility: 2 },
        { relevance: 9, impact: 9, urgency: 9, novelty: 9, feasibility: 9 },
      ]),
      rawOutput: '',
      durationMs: 50,
    });

    const result = await scoreCandidates(candidates, goals);
    expect(result[0].description).toBe('High scorer');
    expect(result[1].description).toBe('Low scorer');
  });

  it('clamps out-of-range dimension scores to 1-10', async () => {
    const goals = [makeGoal()];
    const candidates: CandidateAction[] = [
      { goalId: 'goal-1', goalTitle: 'Become a more capable assistant', description: 'Action', rationale: '', needsWorkspace: false, projectPaths: [] },
    ];

    mockInvokeAdapter.mockResolvedValueOnce({
      success: true,
      resultText: JSON.stringify([
        { relevance: 15, impact: -2, urgency: 0, novelty: 11, feasibility: 7 },
      ]),
      rawOutput: '',
      durationMs: 50,
    });

    const result = await scoreCandidates(candidates, goals);
    const b = result[0].scoreBreakdown!;
    expect(b.relevance).toBe(10);   // clamped from 15
    expect(b.impact).toBe(1);       // clamped from -2
    expect(b.urgency).toBe(1);      // clamped from 0
    expect(b.novelty).toBe(10);     // clamped from 11
    expect(b.feasibility).toBe(7);  // unchanged
  });

  it('falls back to default score=5 if LLM returns non-array JSON', async () => {
    const goals = [makeGoal()];
    const candidates: CandidateAction[] = [
      { goalId: 'goal-1', goalTitle: 'Become a more capable assistant', description: 'Action', rationale: '', needsWorkspace: false, projectPaths: [] },
    ];

    mockInvokeAdapter.mockResolvedValueOnce({
      success: true,
      resultText: '{"error": "unexpected format"}',
      rawOutput: '',
      durationMs: 50,
    });

    const result = await scoreCandidates(candidates, goals);
    expect(result[0].score).toBe(5);
    expect(result[0].scoreBreakdown).toBeUndefined();
  });

  it('returns candidates with default score on scoring failure', async () => {
    const goals = [makeGoal()];
    const candidates: CandidateAction[] = [
      { goalId: 'goal-1', goalTitle: 'Become a more capable assistant', description: 'Action', rationale: '', needsWorkspace: false, projectPaths: [] },
    ];

    // Mercury fails
    mockInvokeAdapter.mockResolvedValueOnce({
      success: false, resultText: null, rawOutput: '', durationMs: 0, error: 'Mercury down',
    });
    // Ollama also fails
    mockInvokeAdapter.mockResolvedValueOnce({
      success: false, resultText: null, rawOutput: '', durationMs: 0, error: 'Ollama down',
    });

    const result = await scoreCandidates(candidates, goals);
    expect(result).toHaveLength(1);
    expect(result[0].score).toBe(5); // default
  });

  it('returns empty array for empty input', async () => {
    const result = await scoreCandidates([], [makeGoal()]);
    expect(result).toHaveLength(0);
    expect(mockInvokeAdapter).not.toHaveBeenCalled();
  });

  it('handles missing dimensions with default value 5', async () => {
    const goals = [makeGoal()];
    const candidates: CandidateAction[] = [
      { goalId: 'goal-1', goalTitle: 'Become a more capable assistant', description: 'Action', rationale: '', needsWorkspace: false, projectPaths: [] },
    ];

    // LLM omits some fields
    mockInvokeAdapter.mockResolvedValueOnce({
      success: true,
      resultText: JSON.stringify([{ relevance: 8 }]),  // only relevance provided
      rawOutput: '',
      durationMs: 50,
    });

    const result = await scoreCandidates(candidates, goals);
    const b = result[0].scoreBreakdown!;
    expect(b.relevance).toBe(8);
    expect(b.impact).toBe(5);      // default
    expect(b.urgency).toBe(5);     // default
    expect(b.novelty).toBe(5);     // default
    expect(b.feasibility).toBe(5); // default
  });
});

// ---------------------------------------------------------------------------
// selectBestCandidate — Phase 8.2 priority tiebreaking
// ---------------------------------------------------------------------------

describe('selectBestCandidate', () => {
  function makeCandidate(overrides: Partial<CandidateAction> = {}): CandidateAction {
    return {
      goalId: 'goal-1',
      goalTitle: 'Become a more capable assistant',
      description: 'Default action',
      rationale: '',
      score: 7,
      needsWorkspace: false,
      projectPaths: [],
      ...overrides,
    };
  }

  it('returns null for empty array', () => {
    expect(selectBestCandidate([], [])).toBeNull();
  });

  it('returns the single candidate when only one exists', () => {
    const c = makeCandidate({ description: 'Only action' });
    expect(selectBestCandidate([c], [makeGoal()])).toBe(c);
  });

  it('returns the highest-scoring candidate when scores differ beyond threshold', () => {
    const high = makeCandidate({ description: 'High', score: 9.0 });
    const low  = makeCandidate({ description: 'Low',  score: 7.0 });
    const result = selectBestCandidate([high, low], [makeGoal()]);
    expect(result?.description).toBe('High');
  });

  it('breaks ties by goal priority when scores are within threshold', () => {
    const goals = [
      makeGoal({ id: 'goal-low',  title: 'Low priority goal',  priority: 50 }),
      makeGoal({ id: 'goal-high', title: 'High priority goal', priority: 90 }),
    ];
    // Both score 8.0 — within 0.5 tie threshold
    const cLow  = makeCandidate({ goalId: 'goal-low',  goalTitle: 'Low priority goal',  description: 'Low-priority action',  score: 8.0 });
    const cHigh = makeCandidate({ goalId: 'goal-high', goalTitle: 'High priority goal', description: 'High-priority action', score: 8.0 });

    const result = selectBestCandidate([cLow, cHigh], goals);
    expect(result?.description).toBe('High-priority action');
  });

  it('does NOT break ties when score gap exceeds threshold', () => {
    const goals = [
      makeGoal({ id: 'goal-low',  title: 'Low priority goal',  priority: 50 }),
      makeGoal({ id: 'goal-high', title: 'High priority goal', priority: 90 }),
    ];
    // cLow scores higher beyond the tie threshold
    const cLow  = makeCandidate({ goalId: 'goal-low',  description: 'Low-priority but higher-scoring',  score: 9.0 });
    const cHigh = makeCandidate({ goalId: 'goal-high', description: 'High-priority but lower-scoring', score: 8.0 });

    const result = selectBestCandidate([cLow, cHigh], goals);
    expect(result?.description).toBe('Low-priority but higher-scoring');
  });

  it('returns first tied candidate when goal priorities are equal', () => {
    const goals = [makeGoal({ id: 'goal-1', priority: 80 }), makeGoal({ id: 'goal-2', priority: 80 })];
    const c1 = makeCandidate({ goalId: 'goal-1', description: 'First tied', score: 8.0 });
    const c2 = makeCandidate({ goalId: 'goal-2', description: 'Second tied', score: 8.0 });

    const result = selectBestCandidate([c1, c2], goals);
    expect(result?.description).toBe('First tied'); // falls back to sort order
  });
});
