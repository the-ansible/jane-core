/**
 * Router -- sender-driven routing based on CommunicationEvent fields.
 *
 * No classifier. No LLM. The sender declares routing intent:
 * 1. hints.routing === 'log'  -> store only, no response
 * 2. recipients with role     -> direct to agent with that role
 * 3. recipients with id       -> direct to specific agent
 * 4. no recipients            -> default conversational handler
 */

import type { CommunicationEvent } from '@the-ansible/life-system-shared';
import type { RoutingDecision } from './types.js';

export function routeEvent(event: CommunicationEvent): RoutingDecision {
  // 1. Explicit log-only routing
  if (event.hints?.routing === 'log') {
    return {
      action: 'log',
      reason: 'Sender requested log-only (hints.routing=log)',
    };
  }

  // 2. Recipients with role -- direct to that role
  const target = event.recipients?.[0] as { id?: string; role?: string; type?: string } | undefined;
  if (target?.role) {
    return {
      action: 'direct',
      reason: `Direct to role: ${target.role}`,
      targetRole: target.role,
      targetId: target.id,
    };
  }

  // 3. Recipients with id only -- direct to specific agent
  if (target?.id && target.type === 'agent') {
    return {
      action: 'direct',
      reason: `Direct to agent: ${target.id}`,
      targetId: target.id,
    };
  }

  // 4. No recipients or human recipients -- default conversational handler
  return {
    action: 'converse',
    reason: 'No explicit routing, using default conversational handler',
  };
}
