import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import type { CommMetrics } from '@/types';
import { fmtMs } from '@/lib/utils';

interface Props {
  metrics: CommMetrics | null;
}

function LatencyGauge({ label, p50, p95, p99 }: { label: string; p50: number; p95: number; p99: number }) {
  const max = 30000;
  const pct = Math.min((p50 / max) * 100, 100);
  const color = p50 > 15000 ? '#f85149' : p50 > 5000 ? '#d29922' : '#58a6ff';
  return (
    <div>
      <div className="text-xs text-muted-foreground mb-1">{label}</div>
      <div className="h-2 rounded-full bg-muted overflow-hidden">
        <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, backgroundColor: color }} />
      </div>
      <div className="flex gap-3 mt-0.5 text-[10px] text-muted-foreground font-mono">
        <span>p50: {fmtMs(p50)}</span>
        <span>p95: {fmtMs(p95)}</span>
        <span>p99: {fmtMs(p99)}</span>
      </div>
    </div>
  );
}

export function CommPipelinePanel({ metrics }: Props) {
  const pipeline = metrics?.pipeline;
  const responseRate = pipeline?.responseRate ?? 0;
  const rateColor = responseRate > 80 ? '#58a6ff' : responseRate > 50 ? '#d29922' : '#f85149';

  return (
    <Card>
      <CardHeader>
        <CardTitle>Pipeline</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="mb-3">
          <span className="text-xs text-muted-foreground">Response Rate </span>
          <span className="text-lg font-semibold font-mono" style={{ color: rateColor }}>
            {responseRate.toFixed(0)}%
          </span>
        </div>
        {pipeline?.latency && (
          <div className="space-y-3">
            <LatencyGauge label="Agent" {...pipeline.latency.agent} />
            <LatencyGauge label="Composer" {...pipeline.latency.composer} />
            <LatencyGauge label="Total" {...pipeline.latency.total} />
          </div>
        )}
        {pipeline?.recentErrors && pipeline.recentErrors.length > 0 && (
          <div className="mt-3 border-t border-border pt-2">
            <div className="text-[10px] uppercase text-destructive mb-1">Recent Errors</div>
            <div className="max-h-20 overflow-y-auto text-xs text-destructive/80 space-y-0.5">
              {pipeline.recentErrors.slice(0, 5).map((e, i) => (
                <div key={i} className="truncate">{e}</div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
