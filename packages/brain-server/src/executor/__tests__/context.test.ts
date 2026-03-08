/**
 * Context system tests.
 *
 * Tests plan resolution, token estimation, and module composition.
 * Module tests that require DB are integration tests (need JANE_DATABASE_URL).
 */

import { describe, it, expect } from 'vitest';
import { estimateTokens } from '../context/tokens.js';
import { resolvePlan } from '../context/plans.js';
import type { ContextPlanConfig } from '../types.js';

describe('token estimation', () => {
  it('estimates tokens from text length', () => {
    expect(estimateTokens('hello')).toBe(2); // ceil(5/4)
    expect(estimateTokens('a'.repeat(100))).toBe(25);
    expect(estimateTokens('')).toBe(0);
  });

  it('rounds up for partial tokens', () => {
    expect(estimateTokens('abc')).toBe(1); // ceil(3/4) = 1
    expect(estimateTokens('abcde')).toBe(2); // ceil(5/4) = 2
  });
});

describe('plan resolution', () => {
  const basePlan: ContextPlanConfig = {
    summaryChunkSize: 6,
    summaryModel: 'haiku',
    summaryPromptTemplate: 'default_v1',
    rawSummarizationThreshold: 12,
    maxSummaries: 10,
    modelContextSize: 200_000,
    tokenBudgetPct: 0.06,
    overrides: {
      composer: { maxSummaries: 3, tokenBudgetPct: 0.02 },
      scorer: { maxSummaries: 0, tokenBudgetPct: 0.01, modules: ['system-state'] },
    },
    topicTrackingEnabled: false,
    associativeRetrievalEnabled: false,
  };

  it('resolves default plan for executor role', () => {
    const resolved = resolvePlan(basePlan, 'executor');
    expect(resolved.maxSummaries).toBe(10);
    expect(resolved.tokenBudgetPct).toBe(0.06);
    expect(resolved.tokenBudget).toBe(12_000);
    expect(resolved.modules).toEqual(['conversation', 'semantic-facts', 'memory', 'system-state']);
  });

  it('applies per-role overrides', () => {
    const resolved = resolvePlan(basePlan, 'composer');
    expect(resolved.maxSummaries).toBe(3);
    expect(resolved.tokenBudgetPct).toBe(0.02);
    expect(resolved.tokenBudget).toBe(4_000);
  });

  it('applies module overrides', () => {
    const resolved = resolvePlan(basePlan, 'scorer');
    expect(resolved.maxSummaries).toBe(0);
    expect(resolved.modules).toEqual(['system-state']);
  });

  it('uses defaults for unknown role', () => {
    const resolved = resolvePlan(basePlan, 'unknown-role');
    expect(resolved.maxSummaries).toBe(10);
    expect(resolved.tokenBudgetPct).toBe(0.06);
  });

  it('handles plan without overrides', () => {
    const noOverrides = { ...basePlan, overrides: undefined };
    const resolved = resolvePlan(noOverrides, 'composer');
    expect(resolved.maxSummaries).toBe(10); // falls back to base
  });
});
