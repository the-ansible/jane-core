import { Card } from '@/components/ui/card';
import { relTime } from '@/lib/utils';
import type { LayerStatus, MonitorResult } from '@/types';

interface LayersPanelProps {
  layers: LayerStatus[];
  monitors: MonitorResult[];
}

const LAYER_ORDER = ['autonomic', 'reflexive', 'cognitive', 'strategic'] as const;

const LAYER_DESC: Record<string, string> = {
  autonomic: 'Health monitors',
  reflexive: 'Event-driven responses',
  cognitive: 'Job spawner',
  strategic: 'Meta-cognition',
};

function monitorStatusColor(status: MonitorResult['status']): string {
  if (status === 'ok') return '#58a6ff';
  if (status === 'warning') return '#d29922';
  return '#f85149';
}

function LayerCard({
  layer,
  monitors,
}: {
  layer: LayerStatus;
  monitors: MonitorResult[];
}) {
  const isRunning = layer.running;
  const lastActivity = layer.lastActivity ? relTime(layer.lastActivity) : 'never';
  const worseMonitor = monitors.reduce<MonitorResult | null>((worst, m) => {
    if (!worst) return m;
    const order = { ok: 0, warning: 1, critical: 2 };
    return order[m.status] > order[worst.status] ? m : worst;
  }, null);

  return (
    <Card className="p-3.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span
              className={`inline-block h-2 w-2 shrink-0 rounded-full ${
                isRunning
                  ? 'bg-primary shadow-[0_0_5px_rgba(88,166,255,0.5)]'
                  : 'bg-muted-foreground'
              }`}
            />
            <span className="text-xs font-semibold uppercase tracking-wide text-card-foreground">
              {layer.layer}
            </span>
          </div>
          <div className="mt-0.5 text-[11px] text-muted-foreground">
            {LAYER_DESC[layer.layer] ?? ''}
          </div>
        </div>
        <span
          className="shrink-0 font-mono text-[11px]"
          style={{ color: isRunning ? '#58a6ff' : '#8b949e' }}
        >
          {isRunning ? 'running' : 'stopped'}
        </span>
      </div>

      {/* Monitor summary for autonomic layer */}
      {monitors.length > 0 && (
        <div className="mt-2 space-y-0.5">
          {monitors.map((m) => (
            <div key={m.name} className="flex items-center gap-1.5 text-[11px]">
              <span
                className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ backgroundColor: monitorStatusColor(m.status) }}
              />
              <span className="text-muted-foreground">{m.name}</span>
              {m.status !== 'ok' && (
                <span style={{ color: monitorStatusColor(m.status) }}>{m.message}</span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Worst monitor indicator for non-autonomic layers */}
      {monitors.length === 0 && worseMonitor && worseMonitor.status !== 'ok' && (
        <div
          className="mt-1.5 text-[11px]"
          style={{ color: monitorStatusColor(worseMonitor.status) }}
        >
          {worseMonitor.message}
        </div>
      )}

      <div className="mt-1.5 text-[10px] text-muted-foreground">
        last active: {lastActivity}
      </div>
    </Card>
  );
}

export function LayersPanel({ layers, monitors }: LayersPanelProps) {
  // Sort layers in canonical order, fill in any missing ones
  const orderedLayers = LAYER_ORDER.map((name) => {
    const found = layers.find((l) => l.layer === name);
    return found ?? { layer: name, running: false, lastActivity: null, metadata: {} };
  });

  // Autonomic monitors go on the autonomic card
  const autonomicMonitors = monitors;

  if (orderedLayers.every((l) => !l.running) && layers.length === 0) {
    return null; // Hide if server just started and layers aren't initialized yet
  }

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {orderedLayers.map((layer) => (
        <LayerCard
          key={layer.layer}
          layer={layer}
          monitors={layer.layer === 'autonomic' ? autonomicMonitors : []}
        />
      ))}
    </div>
  );
}
