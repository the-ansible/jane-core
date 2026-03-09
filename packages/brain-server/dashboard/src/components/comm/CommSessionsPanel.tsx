import { useState, useCallback } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import type { CommSession } from '@/types';
import { relTime, toPacific, apiUrl } from '@/lib/utils';

interface Props {
  sessions: CommSession[];
}

interface SessionMessage {
  role: string;
  content: string;
  timestamp: string;
  sender?: { id: string; displayName?: string; type?: string };
}

function SessionMessages({ sessionId }: { sessionId: string }) {
  const [messages, setMessages] = useState<SessionMessage[] | null>(null);

  const load = useCallback(() => {
    fetch(apiUrl(`/api/communication/sessions/${sessionId}?limit=20`))
      .then(r => r.json())
      .then(d => setMessages(d.messages || []))
      .catch(() => setMessages([]));
  }, [sessionId]);

  if (messages === null) {
    return (
      <button onClick={load} className="text-[10px] text-primary hover:underline mt-1">
        Load messages
      </button>
    );
  }

  return (
    <div className="mt-2 space-y-1 max-h-48 overflow-y-auto">
      {messages.map((m, i) => {
        const isUser = m.role === 'user';
        const roleColor = isUser ? '#58a6ff' : '#d29922';
        const name = m.sender?.displayName || m.sender?.id || (isUser ? 'User' : 'Jane');
        return (
          <div key={i} className="text-xs flex gap-2" style={{ borderLeft: `2px solid ${roleColor}`, paddingLeft: 6 }}>
            <span className="font-mono text-[10px] text-muted-foreground flex-shrink-0 w-16">
              {new Date(m.timestamp).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles' })}
            </span>
            <span className="font-medium flex-shrink-0" style={{ color: roleColor }}>{name}</span>
            <span className="text-card-foreground line-clamp-2">{m.content}</span>
          </div>
        );
      })}
      {messages.length === 0 && <div className="text-[10px] text-muted-foreground">No messages</div>}
    </div>
  );
}

export function CommSessionsPanel({ sessions }: Props) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const sorted = [...sessions].sort((a, b) => {
    if (!a.lastActivity) return 1;
    if (!b.lastActivity) return -1;
    return new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime();
  });

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <CardTitle>Sessions</CardTitle>
          <span className="text-xs text-muted-foreground">({sessions.length})</span>
        </div>
      </CardHeader>
      <CardContent>
        {sorted.length === 0 ? (
          <div className="text-xs text-muted-foreground">No active sessions</div>
        ) : (
          <div className="space-y-1 max-h-[400px] overflow-y-auto">
            {sorted.slice(0, 20).map((s) => {
              const expanded = expandedId === s.sessionId;
              return (
                <div
                  key={s.sessionId}
                  className="rounded border border-border p-2 cursor-pointer hover:bg-muted/30 transition-colors"
                  onClick={() => setExpandedId(expanded ? null : s.sessionId)}
                >
                  <div className="flex items-center gap-2 text-xs">
                    <span className="font-mono text-[10px] text-primary truncate max-w-[180px]">{s.sessionId}</span>
                    <span className="text-muted-foreground">{s.messageCount} msgs</span>
                    {s.diskMessageCount > s.messageCount && (
                      <span className="text-[10px] text-muted-foreground">({s.diskMessageCount} on disk)</span>
                    )}
                    <span className="ml-auto text-[10px] text-muted-foreground">{relTime(s.lastActivity)}</span>
                  </div>
                  {expanded && <SessionMessages sessionId={s.sessionId} />}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
