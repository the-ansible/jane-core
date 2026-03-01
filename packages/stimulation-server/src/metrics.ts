export interface Metrics {
  received: number;
  validated: number;
  deduplicated: number;
  classified: number;
  pipelineProcessed: number;
  validationErrors: number;
  errors: number;
  startedAt: string;
}

const metrics: Metrics = {
  received: 0,
  validated: 0,
  deduplicated: 0,
  classified: 0,
  pipelineProcessed: 0,
  validationErrors: 0,
  errors: 0,
  startedAt: new Date().toISOString(),
};

export function increment(key: keyof Omit<Metrics, 'startedAt'>): void {
  metrics[key]++;
}

export function getMetrics(): Metrics & { uptimeSeconds: number } {
  const uptimeSeconds = Math.floor(
    (Date.now() - new Date(metrics.startedAt).getTime()) / 1000
  );
  return { ...metrics, uptimeSeconds };
}

export function resetMetrics(): void {
  metrics.received = 0;
  metrics.validated = 0;
  metrics.deduplicated = 0;
  metrics.classified = 0;
  metrics.pipelineProcessed = 0;
  metrics.validationErrors = 0;
  metrics.errors = 0;
  metrics.startedAt = new Date().toISOString();
}
