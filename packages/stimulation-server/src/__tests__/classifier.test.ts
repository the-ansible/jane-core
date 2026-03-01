import { describe, it, expect, beforeEach } from 'vitest';
import { classify, getClassifierMetrics, resetClassifierMetrics } from '../classifier/index.js';
import type { ClassificationContext } from '../classifier/types.js';

function ctx(content: string, overrides?: Partial<ClassificationContext>): ClassificationContext {
  return { content, channelType: 'realtime', sessionState: 'cold_start', ...overrides };
}

describe('classify orchestrator', () => {
  beforeEach(() => {
    resetClassifierMetrics();
  });

  it('classifies empty messages via rules tier', async () => {
    const result = await classify(ctx(''), null);
    expect(result.tier).toBe('rules');
    expect(result.urgency).toBe('ignore');
  });

  it('classifies urgent messages via rules tier', async () => {
    const result = await classify(ctx('URGENT: server is down!'), null);
    expect(result.tier).toBe('rules');
    expect(result.urgency).toBe('immediate');
    expect(result.routing).toBe('escalate');
  });

  it('classifies system alerts via rules tier', async () => {
    const result = await classify(ctx('Server down, everything crashed'), null);
    expect(result.tier).toBe('rules');
    expect(result.urgency).toBe('immediate');
    expect(result.category).toBe('alert');
  });

  it('classifies complete hints via rules tier', async () => {
    const result = await classify(ctx('Health check report', {
      hints: { category: 'informational', urgency: 'low', routing: 'log_only' },
    }), null);
    expect(result.tier).toBe('rules');
    expect(result.category).toBe('informational');
    expect(result.urgency).toBe('low');
    expect(result.routing).toBe('log_only');
    expect(result.confidence).toBe('high');
  });

  it('tracks metrics correctly', async () => {
    await classify(ctx(''), null);
    await classify(ctx('This is urgent'), null);
    await classify(ctx('Report', {
      hints: { category: 'informational', urgency: 'low', routing: 'log_only' },
    }), null);

    const metrics = getClassifierMetrics();
    expect(metrics.totalClassified).toBe(3);
    expect(metrics.byTier.rules).toBe(3);
    expect(metrics.rates.rulesHitRate).toBe(100);
  });
});
