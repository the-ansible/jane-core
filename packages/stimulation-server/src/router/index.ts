/**
 * Router — deterministic dispatch based on ClassificationResult.
 * Maps classification → action type. No LLM needed for the default path.
 */

import type { ClassificationResult, Routing } from '../classifier/types.js';

export type ActionType = 'reply' | 'think' | 'log' | 'escalate';

export interface RouteDecision {
  action: ActionType;
  reason: string;
}

/**
 * Route table: maps classification routing to action type.
 * For v1, both 'reply' and 'think' go to the same agent.
 * Future: reflexive replies could skip the full agent.
 */
const ROUTE_MAP: Record<Routing, ActionType> = {
  reflexive_reply: 'reply',
  deliberate_thought: 'think',
  log_only: 'log',
  escalate: 'escalate',
};

export function route(classification: ClassificationResult): RouteDecision {
  const action = ROUTE_MAP[classification.routing] ?? 'log';

  const reason = `${classification.routing} (${classification.category}, ` +
    `urgency=${classification.urgency}, confidence=${classification.confidence}, ` +
    `tier=${classification.tier})`;

  return { action, reason };
}
