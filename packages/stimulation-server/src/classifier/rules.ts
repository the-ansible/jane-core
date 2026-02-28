/**
 * Tier 1: Rules-based classifier.
 * Pattern matching for obvious cases — fast, free, no LLM needed.
 * Returns Classification or null if no rule matches (falls through to LLM).
 */

import type { Classification } from './types.js';

interface Rule {
  name: string;
  test: (content: string, channelType: string) => boolean;
  result: Classification;
}

const rules: Rule[] = [
  // --- Urgency: Immediate ---
  {
    name: 'urgent_keywords',
    test: (c) => /\b(urgent|emergency|asap|critical|help me now|immediately)\b/i.test(c),
    result: { urgency: 'immediate', category: 'alert', routing: 'escalate' },
  },
  {
    name: 'system_alert',
    test: (c) => /\b(server down|outage|error rate|circuit.?break|crash(ed|ing)?)\b/i.test(c),
    result: { urgency: 'immediate', category: 'alert', routing: 'escalate' },
  },

  // --- Social / Greetings ---
  {
    name: 'greeting',
    test: (c) => /^(good morning|good afternoon|good evening|hello|hey|hi|howdy|yo|sup|what'?s up)\b/i.test(c.trim()),
    result: { urgency: 'low', category: 'social', routing: 'reflexive_reply' },
  },
  {
    name: 'thanks',
    test: (c) => /^(thanks?|thank you|ty|thx|cheers|appreciate it)\b/i.test(c.trim()),
    result: { urgency: 'low', category: 'social', routing: 'reflexive_reply' },
  },
  {
    name: 'farewell',
    test: (c) => /^(bye|goodbye|good ?night|gn|see you|later|ttyl|cya)\b/i.test(c.trim()),
    result: { urgency: 'low', category: 'social', routing: 'reflexive_reply' },
  },

  // --- Task requests (before questions — "can you X?" is a request, not a question) ---
  {
    name: 'task_imperative',
    test: (c) => /^(please |can you |could you |would you |I need you to |go ahead and )/i.test(c.trim()),
    result: { urgency: 'normal', category: 'task_request', routing: 'deliberate_thought' },
  },

  // --- Questions ---
  {
    name: 'direct_question',
    test: (c) => {
      const trimmed = c.trim();
      // Short message ending in ? is clearly a question
      return trimmed.endsWith('?') && trimmed.length < 500;
    },
    result: { urgency: 'normal', category: 'question', routing: 'deliberate_thought' },
  },

  // --- Informational / low-priority ---
  {
    name: 'fyi_prefix',
    test: (c) => /^(fyi|for your info|heads up|just so you know|note:)/i.test(c.trim()),
    result: { urgency: 'low', category: 'informational', routing: 'log_only' },
  },
  {
    name: 'link_only',
    test: (c) => {
      const trimmed = c.trim();
      // Message is just a URL (possibly with minimal text)
      return /^https?:\/\/\S+$/.test(trimmed);
    },
    result: { urgency: 'low', category: 'informational', routing: 'log_only' },
  },

  // --- Ignore ---
  {
    name: 'empty_or_whitespace',
    test: (c) => c.trim().length === 0,
    result: { urgency: 'ignore', category: 'informational', routing: 'log_only' },
  },
];

/**
 * Attempt to classify a message using rules.
 * Returns the classification and matched rule name, or null if no rule matches.
 */
export function classifyByRules(
  content: string,
  channelType: string
): { classification: Classification; ruleName: string } | null {
  for (const rule of rules) {
    if (rule.test(content, channelType)) {
      return { classification: rule.result, ruleName: rule.name };
    }
  }
  return null;
}

/** Exported for testing */
export { rules as _rules };
