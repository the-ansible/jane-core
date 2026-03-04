/**
 * Layer Controller — orchestrates all four hierarchical control layers.
 *
 * Starts and stops:
 *   1. Autonomic layer  — health monitors
 *   2. Reflexive layer  — event pattern handlers
 *   3. Cognitive layer  — job spawner wrapper + escalation intake
 *   4. Strategic layer  — meta-cognition + goal evaluation
 *
 * Also wires cross-layer observability: subscribes to key NATS subjects
 * to log inter-layer events for debugging.
 */

import type { NatsConnection } from 'nats';
import { startAutonomicLayer, stopAutonomicLayer, getAutonomicStatus } from './autonomic.js';
import { startReflexiveLayer, stopReflexiveLayer, getReflexiveStatus } from './reflexive.js';
import { startCognitiveLayer, stopCognitiveLayer, getCognitiveStatus } from './cognitive.js';
import { startStrategicLayer, stopStrategicLayer, getStrategicStatus, triggerStrategicEvaluation, issueDirective } from './strategic.js';
import { initLayerRegistry } from './registry.js';
import type { LayerStatus, LayerName } from './types.js';

export { triggerStrategicEvaluation, issueDirective };

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let initialized = false;
let natsRef: NatsConnection | null = null;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function startHierarchicalControl(nats: NatsConnection): Promise<void> {
  if (initialized) return;

  natsRef = nats;

  // Init DB tables first
  await initLayerRegistry();

  // Start all four layers bottom-up (autonomic → strategic)
  startAutonomicLayer(nats);
  startReflexiveLayer(nats);
  startCognitiveLayer(nats);
  startStrategicLayer(nats);

  initialized = true;

  log('info', 'Hierarchical control started — all 4 layers active');
}

export function stopHierarchicalControl(): void {
  stopAutonomicLayer();
  stopReflexiveLayer();
  stopCognitiveLayer();
  stopStrategicLayer();
  initialized = false;
  natsRef = null;
  log('info', 'Hierarchical control stopped');
}

export function getLayerStatuses(): LayerStatus[] {
  return [
    getAutonomicStatus(),
    getReflexiveStatus(),
    getCognitiveStatus(),
    getStrategicStatus(),
  ];
}

export function getLayerStatus(layer: LayerName): LayerStatus | null {
  switch (layer) {
    case 'autonomic': return getAutonomicStatus();
    case 'reflexive': return getReflexiveStatus();
    case 'cognitive': return getCognitiveStatus();
    case 'strategic': return getStrategicStatus();
    default: return null;
  }
}

export function isInitialized(): boolean {
  return initialized;
}

export function getNats(): NatsConnection | null {
  return natsRef;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(level: string, msg: string, extra?: Record<string, unknown>): void {
  console.log(JSON.stringify({ level, msg, component: 'layer-controller', ts: new Date().toISOString(), ...extra }));
}
