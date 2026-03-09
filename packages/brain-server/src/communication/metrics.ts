/**
 * Communication metrics -- in-memory counters for pipeline activity.
 */

export interface CommMetrics {
  received: number;
  validated: number;
  deduplicated: number;
  routed: number;
  pipelineProcessed: number;
  validationErrors: number;
  errors: number;
  startedAt: string;
}

const metrics: CommMetrics = {
  received: 0,
  validated: 0,
  deduplicated: 0,
  routed: 0,
  pipelineProcessed: 0,
  validationErrors: 0,
  errors: 0,
  startedAt: new Date().toISOString(),
};

export function increment(key: keyof Omit<CommMetrics, 'startedAt'>): void {
  metrics[key]++;
}

export function getCommMetrics(): CommMetrics & { uptimeSeconds: number } {
  const uptimeSeconds = Math.floor(
    (Date.now() - new Date(metrics.startedAt).getTime()) / 1000
  );
  return { ...metrics, uptimeSeconds };
}

export function resetCommMetrics(): void {
  metrics.received = 0;
  metrics.validated = 0;
  metrics.deduplicated = 0;
  metrics.routed = 0;
  metrics.pipelineProcessed = 0;
  metrics.validationErrors = 0;
  metrics.errors = 0;
  metrics.startedAt = new Date().toISOString();
}
