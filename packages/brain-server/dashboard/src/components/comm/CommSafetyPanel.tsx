import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import type { CommMetrics } from '@/types';
import { apiUrl } from '@/lib/utils';

interface Props {
  metrics: CommMetrics | null;
}

export function CommSafetyPanel({ metrics }: Props) {
  const safety = metrics?.safety;
  if (!safety) return null;

  const handlePause = () => { fetch(apiUrl('/api/communication/pause'), { method: 'POST' }).catch(() => {}); };
  const handleResume = () => { fetch(apiUrl('/api/communication/resume'), { method: 'POST' }).catch(() => {}); };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>Safety</CardTitle>
          {safety.paused ? (
            <button onClick={handleResume} className="rounded border border-primary/50 px-2 py-0.5 text-xs text-primary hover:bg-primary/10">
              Resume
            </button>
          ) : (
            <button onClick={handlePause} className="rounded border border-warning/50 px-2 py-0.5 text-xs text-warning hover:bg-warning/10">
              Pause
            </button>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {safety.paused && (
          <div className="mb-3 rounded bg-destructive/10 border border-destructive/30 px-3 py-1.5 text-xs text-destructive font-medium">
            PROCESSING PAUSED
          </div>
        )}

        {/* Rate limits */}
        <div className="grid grid-cols-2 gap-2 mb-3">
          {Object.entries(safety.rateLimits || {}).map(([name, rl]) => {
            const pct = rl.limit > 0 ? (rl.current / rl.limit) * 100 : 0;
            const color = pct > 90 ? '#f85149' : pct > 70 ? '#d29922' : '#58a6ff';
            return (
              <div key={name} className="rounded border border-border p-2">
                <div className="text-[10px] text-muted-foreground truncate">
                  {name} {rl.alertOnly && <span className="text-warning">(alert)</span>}
                </div>
                <div className="h-1.5 rounded-full bg-muted mt-1 overflow-hidden">
                  <div className="h-full rounded-full" style={{ width: `${Math.min(pct, 100)}%`, backgroundColor: color }} />
                </div>
                <div className="text-[10px] font-mono mt-0.5" style={{ color }}>
                  {rl.current}/{rl.limit}
                </div>
              </div>
            );
          })}
        </div>

        {/* Circuit breakers */}
        <div className="flex flex-wrap gap-2">
          {Object.entries(safety.circuitBreakers || {}).map(([name, cb]) => {
            const color = cb.state === 'closed' ? '#58a6ff' : cb.state === 'open' ? '#f85149' : '#d29922';
            return (
              <span key={name} className="flex items-center gap-1 text-[10px] text-muted-foreground">
                <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color }} />
                {name}
              </span>
            );
          })}
        </div>

        {/* Memory */}
        {safety.memory && (
          <div className="mt-2 text-[10px] text-muted-foreground">
            RSS: {Math.round(safety.memory.rssBytes / 1048576)}MB
            {safety.memory.underPressure && <span className="text-destructive ml-1">pressure!</span>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
