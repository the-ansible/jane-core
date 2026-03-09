/**
 * Communication module types -- routing decisions and pipeline interfaces.
 */

import type { CommunicationEvent } from '@the-ansible/life-system-shared';
import type { NatsConnection } from 'nats';
import type { SafetyGate } from './safety/index.js';

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

export type RoutingAction = 'log' | 'converse' | 'direct';

export interface RoutingDecision {
  action: RoutingAction;
  reason: string;
  /** For 'direct' action: the target role */
  targetRole?: string;
  /** For 'direct' action: the target ID */
  targetId?: string;
}

// ---------------------------------------------------------------------------
// Agent intent (output of the thinking layer)
// ---------------------------------------------------------------------------

export interface AgentIntent {
  type: 'reply' | 'update' | 'question' | 'greeting' | 'acknowledgment';
  content: string;
  tone?: 'casual' | 'professional' | 'urgent' | 'playful';
  /** If set, the pipeline dispatches this as a real job to the executor */
  task?: {
    description: string;
    type?: 'task' | 'research' | 'maintenance';
  };
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export interface CommunicationDeps {
  nats: NatsConnection;
  safety: SafetyGate;
}

export interface PipelineResult {
  action: string;
  reason: string;
  responded: boolean;
  responseEventId?: string;
  agentIntent?: AgentIntent | null;
  error?: string;
}

// ---------------------------------------------------------------------------
// Graphiti memory facts
// ---------------------------------------------------------------------------

export interface MemoryFact {
  uuid: string;
  fact: string;
  score: number | null;
}
