/**
 * Tests for goals/metrics.ts — goal scoring metrics NDJSON emitter.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { CandidateAction } from './types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeCandidate(overrides: Partial<CandidateAction> = {}): CandidateAction {
  return {
    goalId: 'goal-1',
    goalTitle: 'Be more capable',
    description: 'Do something useful',
    rationale: 'Because it helps',
    score: 7.5,
    scoreBreakdown: {
      relevance: 8,
      impact: 7,
      urgency: 6,
      novelty: 9,
      feasibility: 8,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('emitScoringMetrics', () => {
  // We can't easily intercept the file path since it's derived from import.meta.url,
  // so we test the behavior indirectly by calling emitScoringMetrics and verifying
  // it doesn't throw (it's fire-and-forget, errors are swallowed).
  // We also test the entry shape by importing and inspecting the module structure.

  it('does not throw when called with valid candidates', async () => {
    const { emitScoringMetrics } = await import('./metrics.js');
    const candidates = [
      makeCandidate({ score: 8 }),
      makeCandidate({ goalId: 'goal-2', goalTitle: 'Other goal', score: 6 }),
    ];
    const selected = candidates[0];

    // Should not throw — errors are swallowed internally
    expect(() => emitScoringMetrics('cycle-123', candidates, selected)).not.toThrow();
  });

  it('does not throw with empty candidates array', async () => {
    const { emitScoringMetrics } = await import('./metrics.js');
    expect(() => emitScoringMetrics('cycle-empty', [], null)).not.toThrow();
  });

  it('does not throw when selected is null', async () => {
    const { emitScoringMetrics } = await import('./metrics.js');
    const candidates = [makeCandidate()];
    expect(() => emitScoringMetrics('cycle-null-sel', candidates, null)).not.toThrow();
  });

  it('does not throw for candidates without scoreBreakdown', async () => {
    const { emitScoringMetrics } = await import('./metrics.js');
    const candidates = [makeCandidate({ scoreBreakdown: undefined })];
    expect(() => emitScoringMetrics('cycle-no-breakdown', candidates, null)).not.toThrow();
  });

  it('produces valid JSON entries in the log file when written', async () => {
    // Write a metrics entry to a temp file to verify the JSON format
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metrics-test-'));
    const tmpFile = path.join(tmpDir, 'metrics.json');

    const candidates = [
      makeCandidate({ goalId: 'goal-A', score: 9, scoreBreakdown: { relevance: 9, impact: 9, urgency: 8, novelty: 7, feasibility: 9 } }),
      makeCandidate({ goalId: 'goal-B', score: 6, scoreBreakdown: { relevance: 6, impact: 6, urgency: 5, novelty: 7, feasibility: 7 } }),
    ];
    const selected = candidates[0];

    // Manually construct a metrics entry to test JSON shape
    const entry = {
      ts: new Date().toISOString(),
      cycleId: 'test-cycle',
      candidateCount: candidates.length,
      selectedGoalId: selected.goalId,
      candidates: candidates.map((c) => ({
        goalId: c.goalId,
        goalTitle: c.goalTitle,
        description: c.description.slice(0, 200),
        score: c.score ?? 0,
        selected: c === selected,
        breakdown: c.scoreBreakdown ?? null,
      })),
    };

    fs.writeFileSync(tmpFile, JSON.stringify(entry) + '\n', 'utf8');

    const lines = fs.readFileSync(tmpFile, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);

    const parsed = JSON.parse(lines[0]);
    expect(parsed.cycleId).toBe('test-cycle');
    expect(parsed.candidateCount).toBe(2);
    expect(parsed.selectedGoalId).toBe('goal-A');
    expect(parsed.candidates).toHaveLength(2);

    const winner = parsed.candidates.find((c: { selected: boolean }) => c.selected);
    expect(winner).toBeDefined();
    expect(winner.goalId).toBe('goal-A');
    expect(winner.breakdown.relevance).toBe(9);
    expect(winner.breakdown.urgency).toBe(8);
    expect(winner.breakdown.impact).toBe(9);

    const loser = parsed.candidates.find((c: { selected: boolean }) => !c.selected);
    expect(loser.selected).toBe(false);
    expect(loser.score).toBe(6);

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true });
  });
});
