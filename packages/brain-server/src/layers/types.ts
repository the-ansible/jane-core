/**
 * Hierarchical Control Layer Types
 *
 * Four layers inspired by biological systems:
 *   1. Autonomic  — continuous health monitoring, no LLM
 *   2. Reflexive  — fast event-driven responses, small/fast model
 *   3. Cognitive  — deliberate multi-step reasoning (existing job spawner)
 *   4. Strategic  — meta-cognition, goal evaluation, system tuning
 */

export type LayerName = 'autonomic' | 'reflexive' | 'cognitive' | 'strategic';

// ---------------------------------------------------------------------------
// Layer events (published to NATS + persisted)
// ---------------------------------------------------------------------------

export type LayerEventType =
  | 'heartbeat'      // autonomic: I am alive
  | 'alert'          // autonomic/reflexive: anomaly detected
  | 'handled'        // reflexive: event handled, no escalation
  | 'escalate'       // reflexive: can't handle, needs cognitive
  | 'result'         // cognitive: job completed
  | 'directive'      // strategic: instruction to lower layer
  | 'evaluation';    // strategic: goal/system evaluation complete

export interface LayerEvent {
  id: string;
  layer: LayerName;
  eventType: LayerEventType;
  severity?: 'info' | 'warning' | 'critical';
  payload: Record<string, unknown>;
  createdAt: Date;
}

// ---------------------------------------------------------------------------
// Directives (strategic → lower layers)
// ---------------------------------------------------------------------------

export type DirectiveStatus = 'pending' | 'applied' | 'superseded';

export interface LayerDirective {
  id: string;
  targetLayer: LayerName;
  directive: string;
  params: Record<string, unknown>;
  status: DirectiveStatus;
  createdAt: Date;
  appliedAt: Date | null;
}

// ---------------------------------------------------------------------------
// Autonomic monitor results
// ---------------------------------------------------------------------------

export interface MonitorResult {
  name: string;
  status: 'ok' | 'warning' | 'critical';
  message: string;
  durationMs?: number;
  data?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Layer status (for API/observability)
// ---------------------------------------------------------------------------

export interface LayerStatus {
  layer: LayerName;
  running: boolean;
  lastActivity: Date | null;
  metadata: Record<string, unknown>;
}
