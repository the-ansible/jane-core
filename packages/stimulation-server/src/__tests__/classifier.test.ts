import { describe, it, expect, beforeEach } from 'vitest';
import { classify, getClassifierMetrics, resetClassifierMetrics } from '../classifier/index.js';

describe('classify orchestrator', () => {
  beforeEach(() => {
    resetClassifierMetrics();
  });

  it('classifies greetings via rules tier', async () => {
    const result = await classify('Good morning!', 'slack', null);
    expect(result.tier).toBe('rules');
    expect(result.category).toBe('social');
    expect(result.urgency).toBe('low');
    expect(result.confidence).toBe('high');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('classifies questions via rules tier', async () => {
    const result = await classify('What time is it?', 'slack', null);
    expect(result.tier).toBe('rules');
    expect(result.category).toBe('question');
  });

  it('classifies urgent messages via rules tier', async () => {
    const result = await classify('URGENT: server is down!', 'slack', null);
    expect(result.tier).toBe('rules');
    expect(result.urgency).toBe('immediate');
    expect(result.routing).toBe('escalate');
  });

  it('classifies empty messages via rules tier', async () => {
    const result = await classify('', 'slack', null);
    expect(result.tier).toBe('rules');
    expect(result.urgency).toBe('ignore');
  });

  it('classifies FYI messages via rules tier', async () => {
    const result = await classify('FYI the build is green now', 'slack', null);
    expect(result.tier).toBe('rules');
    expect(result.routing).toBe('log_only');
  });

  it('tracks metrics correctly', async () => {
    await classify('Hello!', 'slack', null);
    await classify('Thanks!', 'slack', null);
    await classify('What is 2+2?', 'slack', null);

    const metrics = getClassifierMetrics();
    expect(metrics.totalClassified).toBe(3);
    expect(metrics.byTier.rules).toBe(3);
    expect(metrics.rates.rulesHitRate).toBe(100);
    expect(metrics.distribution.category.social).toBe(2);
    expect(metrics.distribution.category.question).toBe(1);
  });
});
