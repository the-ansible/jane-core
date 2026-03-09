import { useState } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import type { CommEvent } from '@/types';
import { relTime, toPacific } from '@/lib/utils';

interface Props {
  events: CommEvent[];
}

export function CommEventsPanel({ events }: Props) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Events</CardTitle>
      </CardHeader>
      <CardContent>
        {events.length === 0 ? (
          <div className="text-xs text-muted-foreground">No recent events</div>
        ) : (
          <div className="space-y-0.5 max-h-[400px] overflow-y-auto">
            {events.slice(0, 30).map((ev) => {
              const e = ev.event;
              const expanded = expandedId === e.id;
              const isInbound = e.direction === 'inbound';
              const dirColor = isInbound ? '#58a6ff' : '#d29922';
              const dirArrow = isInbound ? '\u2192' : '\u2190';
              return (
                <div
                  key={e.id}
                  className="flex items-start gap-2 rounded px-2 py-1 text-xs cursor-pointer hover:bg-muted/30 transition-colors"
                  onClick={() => setExpandedId(expanded ? null : e.id)}
                >
                  <span className="font-mono text-muted-foreground flex-shrink-0 w-14 text-[10px]">
                    {relTime(e.timestamp)}
                  </span>
                  <span style={{ color: dirColor }} className="flex-shrink-0">{dirArrow}</span>
                  <span className="font-mono text-[10px] flex-shrink-0" style={{ color: '#d29922' }}>
                    {e.channelType}
                  </span>
                  <span className="text-muted-foreground flex-shrink-0">
                    {e.sender?.displayName || e.sender?.id || '--'}
                  </span>
                  <span className={`text-card-foreground ${expanded ? '' : 'truncate'}`}>
                    {e.content?.slice(0, expanded ? undefined : 80)}
                  </span>
                  {ev.routing && (
                    <Badge variant="muted" className="ml-auto flex-shrink-0">{ev.routing.action}</Badge>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
