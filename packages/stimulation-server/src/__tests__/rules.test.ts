import { describe, it, expect } from 'vitest';
import { classifyByRules } from '../classifier/rules.js';
import type { ClassificationContext } from '../classifier/types.js';

function ctx(content: string, overrides?: Partial<ClassificationContext>): ClassificationContext {
  return { content, channelType: 'realtime', sessionState: 'cold_start', ...overrides };
}

describe('Rules classifier', () => {
  describe('empty_or_whitespace', () => {
    it('classifies empty as ignore', () => {
      const r = classifyByRules(ctx(''));
      expect(r).not.toBeNull();
      expect(r!.classification.urgency).toBe('ignore');
      expect(r!.ruleName).toBe('empty_or_whitespace');
    });

    it('classifies whitespace as ignore', () => {
      const r = classifyByRules(ctx('   \n\t  '));
      expect(r).not.toBeNull();
      expect(r!.classification.urgency).toBe('ignore');
    });
  });

  describe('safety_urgent_fastpath', () => {
    it('detects "urgent" keyword', () => {
      const r = classifyByRules(ctx('This is urgent, please help'));
      expect(r).not.toBeNull();
      expect(r!.classification.urgency).toBe('immediate');
      expect(r!.classification.routing).toBe('escalate');
      expect(r!.ruleName).toBe('safety_urgent_fastpath');
    });

    it('detects "emergency"', () => {
      const r = classifyByRules(ctx('Emergency! Need help now'));
      expect(r).not.toBeNull();
      expect(r!.classification.urgency).toBe('immediate');
    });
  });

  describe('safety_system_alert', () => {
    it('detects system alerts', () => {
      const r = classifyByRules(ctx('Server down! Everything is broken'));
      expect(r).not.toBeNull();
      expect(r!.classification.urgency).toBe('immediate');
      expect(r!.classification.category).toBe('alert');
      expect(r!.ruleName).toBe('safety_system_alert');
    });

    it('detects crash mentions', () => {
      const r = classifyByRules(ctx('The API just crashed after the deploy'));
      expect(r).not.toBeNull();
      expect(r!.classification.routing).toBe('escalate');
    });
  });

  describe('sender_hints', () => {
    it('accepts complete valid hints', () => {
      const r = classifyByRules(ctx('Daily health check report', {
        hints: { category: 'informational', urgency: 'low', routing: 'log_only' },
      }));
      expect(r).not.toBeNull();
      expect(r!.ruleName).toBe('sender_hints');
      expect(r!.classification).toEqual({
        urgency: 'low',
        category: 'informational',
        routing: 'log_only',
      });
    });

    it('rejects partial hints (missing routing)', () => {
      const r = classifyByRules(ctx('Some message', {
        hints: { category: 'question', urgency: 'normal' },
      }));
      // Should NOT match sender_hints — falls through
      expect(r).toBeNull();
    });

    it('rejects partial hints (missing urgency)', () => {
      const r = classifyByRules(ctx('Some message', {
        hints: { category: 'task_request', routing: 'deliberate_thought' },
      }));
      expect(r).toBeNull();
    });

    it('rejects invalid hint values', () => {
      const r = classifyByRules(ctx('Some message', {
        hints: { category: 'bogus', urgency: 'normal', routing: 'deliberate_thought' },
      }));
      expect(r).toBeNull();
    });

    it('does not match when no hints provided', () => {
      const r = classifyByRules(ctx('Regular message'));
      expect(r).toBeNull();
    });

    it('urgent keywords take precedence over hints', () => {
      // Safety fast-path fires before sender_hints
      const r = classifyByRules(ctx('URGENT server is crashing', {
        hints: { category: 'informational', urgency: 'low', routing: 'log_only' },
      }));
      expect(r).not.toBeNull();
      expect(r!.ruleName).toBe('safety_urgent_fastpath');
      expect(r!.classification.urgency).toBe('immediate');
    });
  });

  describe('falls through to LLM', () => {
    it('greetings are not caught by rules', () => {
      const r = classifyByRules(ctx('Good morning!'));
      expect(r).toBeNull();
    });

    it('thanks are not caught by rules', () => {
      const r = classifyByRules(ctx('Thanks!'));
      expect(r).toBeNull();
    });

    it('farewells are not caught by rules', () => {
      const r = classifyByRules(ctx('Goodbye'));
      expect(r).toBeNull();
    });

    it('questions are not caught by rules', () => {
      const r = classifyByRules(ctx('What is the status of the deployment?'));
      expect(r).toBeNull();
    });

    it('task requests are not caught by rules', () => {
      const r = classifyByRules(ctx('Please update the deployment'));
      expect(r).toBeNull();
    });

    it('FYI messages are not caught by rules', () => {
      const r = classifyByRules(ctx('FYI the meeting was moved to 3pm'));
      expect(r).toBeNull();
    });

    it('link-only messages are not caught by rules', () => {
      const r = classifyByRules(ctx('https://example.com/article'));
      expect(r).toBeNull();
    });

    it('ambiguous messages fall through', () => {
      const r = classifyByRules(ctx('I was thinking about the project architecture'));
      expect(r).toBeNull();
    });
  });
});
