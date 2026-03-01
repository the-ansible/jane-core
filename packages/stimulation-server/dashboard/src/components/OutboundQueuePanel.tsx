import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import type { Metrics } from '@/types';

interface OutboundQueuePanelProps {
  metrics: Metrics | null;
}

export function OutboundQueuePanel({ metrics }: OutboundQueuePanelProps) {
  const q = metrics?.outboundQueue;
  const size = q?.size ?? 0;

  let oldest = '--';
  if (q?.oldest) {
    const age = Math.floor((Date.now() - new Date(q.oldest).getTime()) / 1000);
    oldest = `${age}s`;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Outbound Queue</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex gap-8">
          <div className="text-center">
            <div className="font-mono text-2xl font-bold text-card-foreground">{size}</div>
            <div className="text-[11px] uppercase text-muted-foreground">Queued</div>
          </div>
          <div className="text-center">
            <div className="font-mono text-2xl font-bold text-card-foreground">{oldest}</div>
            <div className="text-[11px] uppercase text-muted-foreground">Oldest</div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
