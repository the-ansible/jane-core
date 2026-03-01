/**
 * Tier 1: Structural rules classifier.
 * Only handles cases where an LLM adds no value:
 * - Empty messages (nothing to classify)
 * - Safety fast-paths (urgent keywords, system alerts — sub-ms escalation)
 * - Complete sender hints (trusted callers skip the LLM entirely)
 *
 * Everything else falls through to the LLM tier.
 */

import {
  type Classification,
  type ClassificationContext,
  VALID_URGENCY,
  VALID_CATEGORY,
  VALID_ROUTING,
  type Urgency,
  type Category,
  type Routing,
} from './types.js';

interface Rule {
  name: string;
  test: (ctx: ClassificationContext) => boolean;
  result: Classification | ((ctx: ClassificationContext) => Classification);
}

const rules: Rule[] = [
  // --- Structural: nothing to classify ---
  {
    name: 'empty_or_whitespace',
    test: (ctx) => ctx.content.trim().length === 0,
    result: { urgency: 'ignore', category: 'informational', routing: 'log_only' },
  },

  // --- Safety fast-paths ---
  {
    name: 'safety_urgent_fastpath',
    test: (ctx) => /\b(urgent|emergency|asap|critical|help me now|immediately)\b/i.test(ctx.content),
    result: { urgency: 'immediate', category: 'alert', routing: 'escalate' },
  },
  {
    name: 'safety_system_alert',
    test: (ctx) => /\b(server down|outage|error rate|circuit.?break|crash(ed|ing)?)\b/i.test(ctx.content),
    result: { urgency: 'immediate', category: 'alert', routing: 'escalate' },
  },

  // --- Complete sender hints: trusted callers skip the LLM ---
  {
    name: 'sender_hints',
    test: (ctx) => {
      if (!ctx.hints) return false;
      const { category, urgency, routing } = ctx.hints;
      if (!category || !urgency || !routing) return false;
      return (
        VALID_URGENCY.includes(urgency as Urgency) &&
        VALID_CATEGORY.includes(category as Category) &&
        VALID_ROUTING.includes(routing as Routing)
      );
    },
    result: (ctx) => ({
      urgency: ctx.hints!.urgency as Urgency,
      category: ctx.hints!.category as Category,
      routing: ctx.hints!.routing as Routing,
    }),
  },
];

/**
 * Attempt to classify a message using structural rules.
 * Returns the classification and matched rule name, or null if no rule matches.
 */
export function classifyByRules(
  ctx: ClassificationContext
): { classification: Classification; ruleName: string } | null {
  for (const rule of rules) {
    if (rule.test(ctx)) {
      const classification = typeof rule.result === 'function'
        ? rule.result(ctx)
        : rule.result;
      return { classification, ruleName: rule.name };
    }
  }
  return null;
}

/** Exported for testing */
export { rules as _rules };
