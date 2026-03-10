/**
 * Tests for goals/candidates.ts — Phase 7.1.
 *
 * Validates the invokeAdapter-based LLM invocation for candidate generation
 * and scoring. Mocks the executor module to avoid real LLM calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Goal, CandidateAction } from './types.js';

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
const { generateCandidates, scoreCandidates } = await import('./candidates.js');

beforeEach(() => {
  mockInvokeAdapter.mockReset();
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
// scoreCandidates
// ---------------------------------------------------------------------------

describe('scoreCandidates', () => {
  it('assigns scores from LLM response', async () => {
    const goals = [makeGoal()];
    const candidates: CandidateAction[] = [
      { goalId: 'goal-1', goalTitle: 'Become a more capable assistant', description: 'Action A', rationale: '', needsWorkspace: false, projectPaths: [] },
      { goalId: 'goal-1', goalTitle: 'Become a more capable assistant', description: 'Action B', rationale: '', needsWorkspace: false, projectPaths: [] },
    ];

    mockInvokeAdapter.mockResolvedValueOnce({
      success: true,
      resultText: '[8, 4]',
      rawOutput: '',
      durationMs: 50,
    });

    const result = await scoreCandidates(candidates, goals);
    expect(result[0].description).toBe('Action A');
    expect(result[0].score).toBe(8);
    expect(result[1].description).toBe('Action B');
    expect(result[1].score).toBe(4);
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
});
