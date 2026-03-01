import type { Metrics } from '@/types';

interface HeaderProps {
  metrics: Metrics | null;
  natsConnected: boolean;
}

export function Header({ metrics, natsConnected }: HeaderProps) {
  const secs = metrics?.uptimeSeconds ?? 0;
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  const uptime = `${h}h ${m}m ${s}s`;

  const paused = metrics?.safety?.paused ?? false;

  return (
    <>
      <header className="flex items-center justify-between border-b border-border bg-card px-6 py-3">
        <h1 className="text-lg font-semibold text-card-foreground">Stimulation Server</h1>
        <div className="flex items-center gap-4 text-sm text-muted-foreground">
          <span className="font-mono">{uptime}</span>
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
        </div>
      </header>
      {paused && (
        <div className="mx-6 mt-4 rounded-md border border-destructive bg-destructive/10 px-4 py-2.5 text-center font-semibold text-destructive">
          PROCESSING PAUSED
        </div>
      )}
    </>
  );
}
