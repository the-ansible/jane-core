import { useState, useEffect } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { toPacific, relTime, apiUrl } from '@/lib/utils';
import { SessionContextBar, MessageContextDot, useSessionContext, getMessageContextStatus, STATUS_META } from '@/components/SessionContextBar';
import type { SessionInfo, SessionMessage } from '@/types';
import { ChevronRight, ChevronDown, Copy, Check } from 'lucide-react';

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  function handleCopy(e: React.MouseEvent) {
    e.stopPropagation();
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <button
      onClick={handleCopy}
      title="Copy session ID"
      className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors"
    >
      {copied ? <Check className="h-3 w-3 text-primary" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}

interface SessionsPanelProps {
  sessions: SessionInfo[];
}

// ── Message loader hook ──

function useSessionMessages(sessionId: string, enabled: boolean) {
  const [messages, setMessages] = useState<SessionMessage[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [diskMessageCount, setDiskMessageCount] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    setLoading(true);
    fetch(apiUrl(`/api/sessions/${sessionId}?limit=50`))
      .then((r) => r.json())
      .then((data) => {
        setMessages(data.messages || []);
        setDiskMessageCount(data.diskMessageCount ?? data.messageCount ?? 0);
        setLoading(false);
      })
      .catch(() => { setMessages([]); setLoading(false); });
  }, [sessionId, enabled]);

  return { messages, loading, diskMessageCount };
}

// ── Row styles per context status ──

const ROW_STYLES = {
  raw: {
    border: '1px solid rgba(88, 166, 255, 0.3)',
    borderLeft: '3px solid #58a6ff',
    background: 'rgba(88, 166, 255, 0.06)',
    opacity: 1,
  },
  summarized: {
    border: '1px solid rgba(210, 153, 34, 0.3)',
    borderLeft: '3px solid #d29922',
    background: 'rgba(210, 153, 34, 0.05)',
    opacity: 0.85,
  },
  excluded: {
    border: '1px solid rgba(100, 100, 100, 0.2)',
    borderLeft: '3px solid rgba(100, 100, 100, 0.4)',
    background: 'rgba(100, 100, 100, 0.04)',
    opacity: 0.55,
  },
  disk: {
    border: '1px solid rgba(80, 80, 80, 0.15)',
    borderLeft: '3px solid rgba(80, 80, 80, 0.25)',
    background: 'transparent',
    opacity: 0.35,
  },
} as const;

// ── Message list with context indicators ──

function SessionMessageList({
  sessionId,
  messageCount,
}: {
  sessionId: string;
  messageCount: number;
}) {
  const { messages, loading, diskMessageCount } = useSessionMessages(sessionId, true);
  const { summaries, assembly } = useSessionContext(sessionId);

  if (loading) {
    return <div className="py-2 text-xs text-muted-foreground">Loading messages...</div>;
  }
  if (!messages || messages.length === 0) {
    return <div className="py-2 text-xs text-muted-foreground">No messages</div>;
  }

  // How many messages exist only on disk (evicted from in-memory session)
  const diskOnlyCount = Math.max(0, diskMessageCount - messageCount);

  // Base index relative to in-memory messageCount
  // (messages[0] is at index: messageCount - messages.length)
  const baseIdx = Math.max(0, messageCount - messages.length);

  return (
    <div className="flex flex-col gap-1 py-1">
      {/* Disk-only banner — shown when older messages exist only on JSONL */}
      {diskOnlyCount > 0 && (
        <div
          style={{
            borderLeft: '3px solid rgba(80, 80, 80, 0.4)',
            background: 'rgba(80, 80, 80, 0.06)',
            borderRadius: '0 4px 4px 0',
            padding: '6px 10px',
            fontSize: 11,
            color: 'rgba(180,180,180,0.6)',
            fontStyle: 'italic',
          }}
        >
          {diskOnlyCount} older message{diskOnlyCount !== 1 ? 's' : ''} on disk only — evicted from memory
        </div>
      )}

      {messages.map((msg, i) => {
        const absIdx = baseIdx + i;
        const status = getMessageContextStatus(absIdx, messageCount, assembly, summaries, diskOnlyCount);
        const { label: statusLabel } = STATUS_META[status];
        const rowStyle = ROW_STYLES[status];

        return (
          <div
            key={i}
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 8,
              borderRadius: '0 6px 6px 0',
              padding: '6px 12px',
              transition: 'opacity 0.15s',
              ...rowStyle,
            }}
          >
            <div className="min-w-0 flex-1">
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'rgba(180,180,180,0.8)' }}>
                <span className="font-mono">{toPacific(msg.timestamp)}</span>
                <span
                  style={{
                    fontWeight: 600,
                    color: msg.role === 'user' ? '#58a6ff' : '#d29922',
                  }}
                >
                  {msg.role}
                </span>
                <span
                  title={statusLabel}
                  style={{
                    fontSize: 10,
                    padding: '1px 5px',
                    borderRadius: 3,
                    background: 'rgba(255,255,255,0.07)',
                    color: STATUS_META[status].color,
                    fontWeight: 500,
                    letterSpacing: '0.02em',
                    cursor: 'help',
                  }}
                >
                  {statusLabel}
                </span>
              </div>
              <div style={{ marginTop: 3, fontSize: 12, lineHeight: 1.5, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                {msg.content}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Session card (unified mobile + desktop) ──

function SessionCard({ session }: { session: SessionInfo }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      {/* Card header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-muted/20 transition-colors"
      >
        <span className="text-muted-foreground shrink-0">
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
        </span>
        <span className="font-mono text-xs text-primary truncate flex-1">
          {session.sessionId}
        </span>
        <CopyButton text={session.sessionId} />
        <span className="text-[11px] text-muted-foreground shrink-0 whitespace-nowrap">
          {relTime(session.lastActivityAt)}
          {session.lastActivityAt ? ` (${toPacific(session.lastActivityAt)})` : ''}
        </span>
      </button>

      {/* Context bar */}
      <div className="px-3 pb-2.5">
        <SessionContextBar sessionId={session.sessionId} messageCount={session.messageCount} />
      </div>

      {/* Expanded message list */}
      {expanded && (
        <div className="border-t border-border/50 px-3 py-2">
          <SessionMessageList
            sessionId={session.sessionId}
            messageCount={session.messageCount}
          />
        </div>
      )}
    </div>
  );
}

// ── Main component ──

export function SessionsPanel({ sessions }: SessionsPanelProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Active Sessions
          <span className="text-[11px] font-normal text-muted-foreground">
            ({sessions.length})
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {sessions.length === 0 ? (
          <div className="px-2 py-2 text-xs text-muted-foreground">No active sessions</div>
        ) : (
          <div className="flex flex-col gap-2">
            {sessions.map((s) => (
              <SessionCard key={s.sessionId} session={s} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
