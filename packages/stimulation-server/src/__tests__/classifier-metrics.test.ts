import { describe, it, expect, beforeEach } from 'vitest';
import { recordClassification, getClassifierMetrics, resetClassifierMetrics } from '../classifier/classifier-metrics.js';

describe('classifier-metrics', () => {
  beforeEach(() => {
    resetClassifierMetrics();
  });

  it('starts with zero counts', () => {
    const m = getClassifierMetrics();
    expect(m.totalClassified).toBe(0);
    expect(m.byTier.rules).toBe(0);
  });

  it('records a rules classification', () => {
    recordClassification('rules', 'low', 'social', 'reflexive_reply', 'high', 1);
    const m = getClassifierMetrics();
    expect(m.totalClassified).toBe(1);
    expect(m.byTier.rules).toBe(1);
    expect(m.rates.rulesHitRate).toBe(100);
    expect(m.distribution.urgency.low).toBe(1);
    expect(m.distribution.category.social).toBe(1);
  });

  it('records consensus with agreement', () => {
    recordClassification('local_consensus', 'normal', 'question', 'deliberate_thought', 'high', 1500, { votes: 3, agreeing: 3 });
    const m = getClassifierMetrics();
    expect(m.consensus.perfectAgreement).toBe(1);
    expect(m.consensus.totalVotes).toBe(3);
  });

  it('tracks majority agreement separately from perfect', () => {
    recordClassification('local_consensus', 'normal', 'question', 'deliberate_thought', 'medium', 1200, { votes: 3, agreeing: 2 });
    const m = getClassifierMetrics();
    expect(m.consensus.perfectAgreement).toBe(0);
    expect(m.consensus.majorityAgreement).toBe(1);
  });

  it('computes average latency per tier', () => {
    recordClassification('rules', 'low', 'social', 'reflexive_reply', 'high', 2);
    recordClassification('rules', 'low', 'social', 'reflexive_reply', 'high', 4);
    const m = getClassifierMetrics();
    expect(m.latency.rules).toBe(3); // average of 2 and 4
  });

  it('resets cleanly', () => {
    recordClassification('rules', 'low', 'social', 'reflexive_reply', 'high', 1);
    resetClassifierMetrics();
    const m = getClassifierMetrics();
    expect(m.totalClassified).toBe(0);
  });
});
