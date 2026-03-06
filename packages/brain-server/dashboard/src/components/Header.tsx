import type { BrainMetrics } from '@/types';

interface HeaderProps {
  metrics: BrainMetrics | null;
  natsConnected: boolean;
  sseConnected: boolean;
  cycleRunning: boolean;
  onTriggerCycle: () => void;
  triggering: boolean;
}

export function Header({ metrics, natsConnected, sseConnected, cycleRunning, onTriggerCycle, triggering }: HeaderProps) {
  const uptimeMs = metrics?.uptimeMs ?? 0;
  const h = Math.floor(uptimeMs / 3600000);
  const m = Math.floor((uptimeMs % 3600000) / 60000);
  const s = Math.floor((uptimeMs % 60000) / 1000);
  const uptime = `${h}h ${m}m ${s}s`;

  return (
    <header className="flex items-center justify-between border-b border-border bg-card px-6 py-3">
      <h1 className="text-lg font-semibold text-card-foreground">Brain Server</h1>

      <div className="flex items-center gap-4 text-sm text-muted-foreground">
        <span className="font-mono">{uptime}</span>

        {/* SSE status */}
        <span className="flex items-center gap-1.5">
          <span
            className={`inline-block h-2 w-2 rounded-full ${
              sseConnected
                ? 'bg-primary shadow-[0_0_5px_rgba(88,166,255,0.5)]'
                : 'bg-warning shadow-[0_0_5px_rgba(210,153,34,0.5)]'
            }`}
          />
          <span className="text-xs">{sseConnected ? 'live' : 'polling'}</span>
        </span>

        {/* NATS status */}
        <span className="flex items-center gap-1.5">
          <span
            className={`inline-block h-2.5 w-2.5 rounded-full ${
              natsConnected
                ? 'bg-primary shadow-[0_0_6px_rgba(88,166,255,0.5)]'
                : 'bg-destructive shadow-[0_0_6px_rgba(248,81,73,0.5)]'
            }`}
          />
          NATS
        </span>

        {/* Trigger Cycle */}
        <button
          onClick={onTriggerCycle}
          disabled={triggering || cycleRunning}
          className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
            cycleRunning
              ? 'border-warning/50 text-warning hover:bg-warning/10'
              : 'border-primary/50 text-primary hover:bg-primary/10'
          } disabled:opacity-40`}
        >
          {cycleRunning ? '⟳ Cycle Running' : triggering ? 'Triggering…' : 'Trigger Cycle'}
        </button>
      </div>
    </header>
  );
}
