import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { fmtMs } from '@/lib/utils';
import type { Metrics } from '@/types';

interface PipelinePanelProps {
  metrics: Metrics | null;
}

function LatencyGauge({ label, latency, color }: {
  label: string;
  latency?: { p50: number; p95: number; p99: number };
  color: string;
}) {
  const p50 = latency?.p50 ?? 0;
  return (
    <div className="flex-1">
      <div className="mb-1 text-[11px] text-muted-foreground">{label}</div>
      <Progress value={p50} max={30000} color={color} />
      <div className="mt-1 font-mono text-xs text-foreground">
        p50: {fmtMs(latency?.p50)} · p95: {fmtMs(latency?.p95)} · p99: {fmtMs(latency?.p99)}
      </div>
    </div>
  );
}

export function PipelinePanel({ metrics }: PipelinePanelProps) {
  const p = metrics?.pipeline;
  const rr = p && p.total > 0 ? `${((p.responded / p.total) * 100).toFixed(1)}%` : '--';
  const rrColor =
    p && p.responseRate > 0.8 ? 'text-primary' : p && p.responseRate > 0.5 ? 'text-warning' : 'text-destructive';

  return (
    <Card>
      <CardHeader>
        <CardTitle>Pipeline Performance</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="mb-3">
          <span className="text-xs text-muted-foreground">Response rate: </span>
          <span className={`font-mono text-base font-bold ${rrColor}`}>{rr}</span>
        </div>

        <div className="flex gap-6">
          <LatencyGauge label="Agent Latency" latency={p?.latency?.agent} color="bg-primary" />
          <LatencyGauge label="Composer Latency" latency={p?.latency?.composer} color="bg-warning" />
          <LatencyGauge label="Total Latency" latency={p?.latency?.total} color="bg-card-foreground" />
        </div>

        <div className="mt-3">
          <div className="mb-1 text-[11px] text-muted-foreground">Recent Errors</div>
          <div className="max-h-28 overflow-y-auto">
            {p?.recentErrors && p.recentErrors.length > 0 ? (
              p.recentErrors.slice(-5).map((e, i) => (
                <div key={i} className="break-words font-mono text-[11px] text-destructive">
                  {e}
                </div>
              ))
            ) : (
              <span className="text-[11px] text-muted-foreground">None</span>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
