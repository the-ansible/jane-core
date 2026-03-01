import { useState } from 'react';
import { toPacific } from '@/lib/utils';
import { useIsMobile } from '@/hooks/use-is-mobile';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import type { StoredEvent } from '@/types';

interface EventsFeedProps {
  events: StoredEvent[];
}

export function EventsFeed({ events }: EventsFeedProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const isMobile = useIsMobile();
  const reversed = [...events].reverse();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Live Events
          <span className="text-[11px] font-normal text-muted-foreground">({events.length})</span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="max-h-[360px] overflow-y-auto">
          {reversed.length === 0 ? (
            <div className="px-2 py-2 text-xs text-muted-foreground">Waiting for events...</div>
          ) : isMobile ? (
            reversed.map((ev) => {
              const e = ev.event;
              const isInbound = e.direction === 'inbound';
              const isExpanded = expandedId === e.id;
              const content = e.content || '';

              return (
                <div
                  key={e.id}
                  className="cursor-pointer border-b border-muted px-2 py-2 transition-colors hover:bg-muted/50"
                  onClick={() => setExpandedId(isExpanded ? null : e.id)}
                >
                  <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                    <span className="font-mono">{toPacific(ev.receivedAt)}</span>
                    <span className={isInbound ? 'text-primary' : 'text-warning'}>
                      {isInbound ? '\u2192 in' : '\u2190 out'}
                    </span>
                    <span className="font-mono text-warning">{e.channelType || '--'}</span>
                    {e.sender?.displayName && <span>{e.sender.displayName}</span>}
                  </div>
                  <div className={`mt-0.5 text-xs ${isExpanded ? 'whitespace-pre-wrap break-words' : 'truncate'}`}>
                    {isExpanded ? content : content.slice(0, 120)}
                  </div>
                </div>
              );
            })
          ) : (
            reversed.map((ev) => {
              const e = ev.event;
              const isInbound = e.direction === 'inbound';
              const isExpanded = expandedId === e.id;
              const content = e.content || '';

              return (
                <div
                  key={e.id}
                  className="flex cursor-pointer gap-2.5 border-b border-muted px-2 py-1.5 text-xs transition-colors hover:bg-muted/50"
                  onClick={() => setExpandedId(isExpanded ? null : e.id)}
                >
                  <span className="min-w-[70px] shrink-0 font-mono text-muted-foreground">
                    {toPacific(ev.receivedAt)}
                  </span>
                  <span className={`min-w-[20px] text-center text-sm ${isInbound ? 'text-primary' : 'text-warning'}`}>
                    {isInbound ? '\u2192' : '\u2190'}
                  </span>
                  <span className="min-w-[60px] shrink-0 font-mono text-warning">
                    {e.channelType || '--'}
                  </span>
                  <span className="min-w-[60px] shrink-0 text-muted-foreground">
                    {e.sender?.displayName || e.direction || ''}
                  </span>
                  <span className={`flex-1 ${isExpanded ? 'whitespace-pre-wrap break-words' : 'truncate'}`}>
                    {isExpanded ? content : content.slice(0, 120)}
                  </span>
                </div>
              );
            })
          )}
        </div>
      </CardContent>
    </Card>
  );
}
