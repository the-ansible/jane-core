import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { toPacific, relTime } from '@/lib/utils';
import type { Metrics } from '@/types';

interface OutboundQueuePanelProps {
  metrics: Metrics | null;
}

export function OutboundQueuePanel({ metrics }: OutboundQueuePanelProps) {
  const q = metrics?.outboundQueue;
  const size = q?.size ?? 0;
  const messages = q?.messages ?? [];

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

        {messages.length > 0 && (
          <div className="mt-3 max-h-32 overflow-y-auto">
            <div className="mb-1 text-[11px] text-muted-foreground">Queued Messages</div>
            {messages.map((msg) => (
              <div
                key={msg.eventId}
                className="flex items-center gap-3 border-b border-muted py-1.5 text-xs"
              >
                <span className="font-mono text-primary">{msg.eventId.slice(0, 12)}...</span>
                <span className="font-mono text-warning">{msg.subject.split('.').pop()}</span>
                <span className="text-muted-foreground">{relTime(msg.queuedAt)}</span>
                <span className="text-muted-foreground">
                  {msg.attempts > 0 ? `${msg.attempts} retries` : 'pending'}
                </span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
