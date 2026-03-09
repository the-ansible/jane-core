import type { BrainMetrics } from '@/types';

export type DashboardTab = 'autonomy' | 'communication';

interface HeaderProps {
  metrics: BrainMetrics | null;
  natsConnected: boolean;
  sseConnected: boolean;
  cycleRunning: boolean;
  onTriggerCycle: () => void;
  triggering: boolean;
  activeTab: DashboardTab;
  onTabChange: (tab: DashboardTab) => void;
}

export function Header({ metrics, natsConnected, sseConnected, cycleRunning, onTriggerCycle, triggering, activeTab, onTabChange }: HeaderProps) {
  const uptimeMs = metrics?.uptimeMs ?? 0;
  const h = Math.floor(uptimeMs / 3600000);
  const m = Math.floor((uptimeMs % 3600000) / 60000);
  const s = Math.floor((uptimeMs % 60000) / 1000);
  const uptime = `${h}h ${m}m ${s}s`;

  return (
    <header className="border-b border-border bg-card px-6 py-3">
      <div className="flex items-center justify-between">
      <div className="flex items-center gap-6">
        <h1 className="text-lg font-semibold text-card-foreground">Brain Server</h1>
        <nav className="flex gap-1">
          {(['autonomy', 'communication'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => onTabChange(tab)}
              className={`rounded-md px-3 py-1 text-xs font-medium capitalize transition-colors ${
                activeTab === tab
                  ? 'bg-primary/15 text-primary'
                  : 'text-muted-foreground hover:text-card-foreground hover:bg-muted/50'
              }`}
            >
              {tab}
            </button>
          ))}
        </nav>
      </div>

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
      </div>
    </header>
  );
}
