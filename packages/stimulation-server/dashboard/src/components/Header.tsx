import { useState } from 'react';
import { apiUrl } from '@/lib/utils';
import { Pause, Play } from 'lucide-react';
import type { Metrics } from '@/types';

interface HeaderProps {
  metrics: Metrics | null;
  natsConnected: boolean;
  sseConnected: boolean;
}

export function Header({ metrics, natsConnected, sseConnected }: HeaderProps) {
  const [toggling, setToggling] = useState(false);

  const secs = metrics?.uptimeSeconds ?? 0;
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  const uptime = `${h}h ${m}m ${s}s`;

  const paused = metrics?.safety?.paused ?? false;

  async function togglePause() {
    setToggling(true);
    try {
      await fetch(apiUrl(paused ? '/api/resume' : '/api/pause'), { method: 'POST' });
    } catch {}
    setToggling(false);
  }

  return (
    <>
      <header className="flex items-center justify-between border-b border-border bg-card px-6 py-3">
        <h1 className="text-lg font-semibold text-card-foreground">Stimulation Server</h1>
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

          {/* Pause/Resume */}
          <button
            onClick={togglePause}
            disabled={toggling || !metrics}
            className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
              paused
                ? 'border-primary/50 text-primary hover:bg-primary/10'
                : 'border-destructive/50 text-destructive hover:bg-destructive/10'
            } disabled:opacity-40`}
          >
            {paused ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
            {paused ? 'Resume' : 'Pause'}
          </button>
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
