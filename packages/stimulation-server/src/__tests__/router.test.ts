import { describe, it, expect } from 'vitest';
import { route } from '../router/index.js';
import type { ClassificationResult } from '../classifier/types.js';

function makeClassification(overrides: Partial<ClassificationResult> = {}): ClassificationResult {
  return {
    category: 'chat',
    urgency: 'low',
    confidence: 0.9,
    routing: 'reflexive_reply',
    tier: 'rules',
    ...overrides,
  };
}

describe('Router', () => {
  it('routes reflexive_reply to reply', () => {
    const result = route(makeClassification({ routing: 'reflexive_reply' }));
    expect(result.action).toBe('reply');
    expect(result.reason).toContain('reflexive_reply');
  });

  it('routes deliberate_thought to think', () => {
    const result = route(makeClassification({ routing: 'deliberate_thought' }));
    expect(result.action).toBe('think');
    expect(result.reason).toContain('deliberate_thought');
  });

  it('routes log_only to log', () => {
    const result = route(makeClassification({ routing: 'log_only' }));
    expect(result.action).toBe('log');
    expect(result.reason).toContain('log_only');
  });

  it('routes escalate to escalate', () => {
    const result = route(makeClassification({ routing: 'escalate' }));
    expect(result.action).toBe('escalate');
    expect(result.reason).toContain('escalate');
  });

  it('includes classification details in reason', () => {
    const result = route(makeClassification({
      routing: 'reflexive_reply',
      category: 'question',
      urgency: 'high',
      confidence: 0.85,
      tier: 'ollama',
    }));
    expect(result.reason).toContain('question');
    expect(result.reason).toContain('urgency=high');
    expect(result.reason).toContain('confidence=0.85');
    expect(result.reason).toContain('tier=ollama');
  });

  it('defaults unknown routing to log', () => {
    const result = route(makeClassification({ routing: 'unknown_type' as any }));
    expect(result.action).toBe('log');
  });
});
