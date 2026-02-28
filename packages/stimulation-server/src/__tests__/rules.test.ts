import { describe, it, expect } from 'vitest';
import { classifyByRules } from '../classifier/rules.js';

describe('Rules classifier', () => {
  describe('urgent keywords', () => {
    it('detects "urgent" keyword', () => {
      const r = classifyByRules('This is urgent, please help', 'slack');
      expect(r).not.toBeNull();
      expect(r!.classification.urgency).toBe('immediate');
      expect(r!.classification.routing).toBe('escalate');
    });

    it('detects system alerts', () => {
      const r = classifyByRules('Server down! Everything is broken', 'slack');
      expect(r).not.toBeNull();
      expect(r!.classification.urgency).toBe('immediate');
      expect(r!.classification.category).toBe('alert');
    });
  });

  describe('greetings', () => {
    it('detects "good morning"', () => {
      const r = classifyByRules('Good morning!', 'slack');
      expect(r).not.toBeNull();
      expect(r!.classification).toEqual({
        urgency: 'low',
        category: 'social',
        routing: 'reflexive_reply',
      });
      expect(r!.ruleName).toBe('greeting');
    });

    it('detects "hey"', () => {
      const r = classifyByRules('Hey there', 'slack');
      expect(r).not.toBeNull();
      expect(r!.classification.category).toBe('social');
    });
  });

  describe('thanks', () => {
    it('detects "thanks"', () => {
      const r = classifyByRules('Thanks!', 'slack');
      expect(r).not.toBeNull();
      expect(r!.classification.category).toBe('social');
      expect(r!.classification.routing).toBe('reflexive_reply');
    });
  });

  describe('farewell', () => {
    it('detects "goodbye"', () => {
      const r = classifyByRules('Goodbye', 'slack');
      expect(r).not.toBeNull();
      expect(r!.classification.category).toBe('social');
    });
  });

  describe('questions', () => {
    it('detects questions ending in ?', () => {
      const r = classifyByRules('What is the status of the deployment?', 'slack');
      expect(r).not.toBeNull();
      expect(r!.classification.category).toBe('question');
      expect(r!.classification.routing).toBe('deliberate_thought');
    });

    it('does not match very long messages as simple questions', () => {
      const long = 'x'.repeat(501) + '?';
      const r = classifyByRules(long, 'slack');
      // Long question should not match the simple question rule
      expect(r?.ruleName).not.toBe('direct_question');
    });
  });

  describe('task requests', () => {
    it('detects "please" prefix', () => {
      const r = classifyByRules('Please update the deployment', 'slack');
      expect(r).not.toBeNull();
      expect(r!.classification.category).toBe('task_request');
    });

    it('detects "can you" prefix', () => {
      const r = classifyByRules('Can you check the logs?', 'slack');
      expect(r).not.toBeNull();
      expect(r!.classification.category).toBe('task_request');
    });
  });

  describe('informational', () => {
    it('detects FYI prefix', () => {
      const r = classifyByRules('FYI the meeting was moved to 3pm', 'slack');
      expect(r).not.toBeNull();
      expect(r!.classification.urgency).toBe('low');
      expect(r!.classification.routing).toBe('log_only');
    });

    it('detects link-only messages', () => {
      const r = classifyByRules('https://example.com/article', 'slack');
      expect(r).not.toBeNull();
      expect(r!.classification.routing).toBe('log_only');
    });
  });

  describe('empty messages', () => {
    it('classifies empty as ignore', () => {
      const r = classifyByRules('', 'slack');
      expect(r).not.toBeNull();
      expect(r!.classification.urgency).toBe('ignore');
    });

    it('classifies whitespace as ignore', () => {
      const r = classifyByRules('   \n\t  ', 'slack');
      expect(r).not.toBeNull();
      expect(r!.classification.urgency).toBe('ignore');
    });
  });

  describe('no match', () => {
    it('returns null for ambiguous messages', () => {
      const r = classifyByRules('I was thinking about the project architecture and had some ideas about how we could restructure the data layer', 'slack');
      expect(r).toBeNull();
    });
  });
});
