import { useState, useEffect, Fragment } from 'react';
import {
  useReactTable,
  getCoreRowModel,
  getExpandedRowModel,
  flexRender,
  type ColumnDef,
  type ColumnResizeMode,
} from '@tanstack/react-table';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { toPacific, relTime, apiUrl } from '@/lib/utils';
import { useIsMobile } from '@/hooks/use-is-mobile';
import type { SessionInfo, SessionMessage } from '@/types';
import { ChevronRight, ChevronDown } from 'lucide-react';

interface SessionsPanelProps {
  sessions: SessionInfo[];
}

// ── Desktop: TanStack Table columns ──

const columns: ColumnDef<SessionInfo>[] = [
  {
    id: 'expander',
    size: 32,
    enableResizing: false,
    header: () => null,
    cell: ({ row }) => (
      <button
        onClick={(e) => { e.stopPropagation(); row.toggleExpanded(); }}
        className="flex items-center text-muted-foreground hover:text-foreground"
      >
        {row.getIsExpanded() ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
      </button>
    ),
  },
  {
    accessorKey: 'sessionId',
    header: 'Session ID',
    size: 320,
    cell: ({ getValue }) => <span className="font-mono text-primary">{getValue() as string}</span>,
  },
  {
    accessorKey: 'messageCount',
    header: 'Messages',
    size: 100,
  },
  {
    accessorKey: 'lastActivityAt',
    header: 'Last Activity',
    size: 260,
    cell: ({ getValue }) => {
      const val = getValue() as string;
      return <span className="text-muted-foreground">{relTime(val)}{val ? ` (${toPacific(val)})` : ''}</span>;
    },
  },
];

// ── Shared: message loader hook ──

function useSessionMessages(sessionId: string, enabled: boolean) {
  const [messages, setMessages] = useState<SessionMessage[] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!enabled) return;
    setLoading(true);
    fetch(apiUrl(`/api/sessions/${sessionId}?limit=50`))
      .then((r) => r.json())
      .then((data) => { setMessages(data.messages || []); setLoading(false); })
      .catch(() => { setMessages([]); setLoading(false); });
  }, [sessionId, enabled]);

  return { messages, loading };
}

// ── Desktop: message sub-table ──

function SessionMessagesTable({ sessionId }: { sessionId: string }) {
  const { messages, loading } = useSessionMessages(sessionId, true);

  if (loading) return <div className="px-4 py-2 text-xs text-muted-foreground">Loading messages...</div>;
  if (!messages || messages.length === 0)
    return <div className="px-4 py-2 text-xs text-muted-foreground">No messages</div>;

  return (
    <Table>
      <TableHeader>
        <TableRow className="border-border/50">
          <TableHead className="w-20">Role</TableHead>
          <TableHead className="w-28">Time</TableHead>
          <TableHead>Content</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {messages.map((msg, i) => (
          <TableRow key={i} className="border-border/30">
            <TableCell>
              <span className={`font-mono ${msg.role === 'user' ? 'text-primary' : 'text-warning'}`}>{msg.role}</span>
            </TableCell>
            <TableCell className="font-mono text-muted-foreground">{toPacific(msg.timestamp)}</TableCell>
            <TableCell className="max-w-md truncate">{msg.content}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

// ── Mobile: message cards ──

function SessionMessagesCards({ sessionId }: { sessionId: string }) {
  const { messages, loading } = useSessionMessages(sessionId, true);

  if (loading) return <div className="px-3 py-2 text-xs text-muted-foreground">Loading...</div>;
  if (!messages || messages.length === 0)
    return <div className="px-3 py-2 text-xs text-muted-foreground">No messages</div>;

  return (
    <div className="flex flex-col gap-1.5 py-1">
      {messages.map((msg, i) => (
        <div key={i} className="rounded-md border border-border/50 bg-background px-3 py-2">
          <div className="text-[11px] text-muted-foreground">
            <span className="font-mono">{toPacific(msg.timestamp)}</span>
            {' \u2014 '}
            <span className={`font-semibold ${msg.role === 'user' ? 'text-primary' : 'text-warning'}`}>{msg.role}</span>
          </div>
          <div className="mt-0.5 text-xs leading-relaxed text-foreground">{msg.content}</div>
        </div>
      ))}
    </div>
  );
}

// ── Mobile: card list layout ──

function MobileSessionCard({ session }: { session: SessionInfo }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="rounded-lg border border-border bg-card">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-start gap-2 px-3 py-2.5 text-left"
      >
        <span className="mt-0.5 text-muted-foreground">
          {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-xs text-muted-foreground">
            {relTime(session.lastActivityAt)}
            {session.lastActivityAt ? ` (${toPacific(session.lastActivityAt)})` : ''}
          </div>
          <div className="mt-0.5 truncate font-mono text-xs text-primary">
            {session.sessionId}
            <span className="ml-2 text-muted-foreground">[{session.messageCount} msgs]</span>
          </div>
        </div>
      </button>
      {expanded && (
        <div className="border-t border-border/50 px-3 py-2">
          <SessionMessagesCards sessionId={session.sessionId} />
        </div>
      )}
    </div>
  );
}

function MobileSessionList({ sessions }: { sessions: SessionInfo[] }) {
  return (
    <div className="flex flex-col gap-2">
      {sessions.map((s) => (
        <MobileSessionCard key={s.sessionId} session={s} />
      ))}
    </div>
  );
}

// ── Desktop: TanStack Table layout ──

function DesktopSessionTable({ sessions }: { sessions: SessionInfo[] }) {
  const [columnResizeMode] = useState<ColumnResizeMode>('onChange');

  const table = useReactTable({
    data: sessions,
    columns,
    columnResizeMode,
    getCoreRowModel: getCoreRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
    getRowCanExpand: () => true,
    getRowId: (row) => row.sessionId,
  });

  return (
    <Table style={{ width: table.getCenterTotalSize() }}>
      <TableHeader>
        {table.getHeaderGroups().map((headerGroup) => (
          <TableRow key={headerGroup.id}>
            {headerGroup.headers.map((header) => (
              <TableHead
                key={header.id}
                className="relative"
                style={{ width: header.getSize() }}
              >
                {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
                {header.column.getCanResize() && (
                  <div
                    onMouseDown={header.getResizeHandler()}
                    onTouchStart={header.getResizeHandler()}
                    className={`absolute right-0 top-0 h-full w-1 cursor-col-resize select-none touch-none ${
                      header.column.getIsResizing() ? 'bg-primary opacity-100' : 'bg-border opacity-0 hover:opacity-100'
                    }`}
                  />
                )}
              </TableHead>
            ))}
          </TableRow>
        ))}
      </TableHeader>
      <TableBody>
        {table.getRowModel().rows.map((row) => (
          <Fragment key={row.id}>
            <TableRow className="cursor-pointer" onClick={() => row.toggleExpanded()}>
              {row.getVisibleCells().map((cell) => (
                <TableCell key={cell.id} style={{ width: cell.column.getSize() }}>
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </TableCell>
              ))}
            </TableRow>
            {row.getIsExpanded() && (
              <TableRow>
                <TableCell colSpan={columns.length} className="bg-muted/30 p-0">
                  <div className="border-l-2 border-primary/30 px-4 py-2">
                    <SessionMessagesTable sessionId={row.original.sessionId} />
                  </div>
                </TableCell>
              </TableRow>
            )}
          </Fragment>
        ))}
      </TableBody>
    </Table>
  );
}

// ── Main component ──

export function SessionsPanel({ sessions }: SessionsPanelProps) {
  const isMobile = useIsMobile();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Active Sessions
          <span className="text-[11px] font-normal text-muted-foreground">({sessions.length})</span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {sessions.length === 0 ? (
          <div className="px-2 py-2 text-xs text-muted-foreground">No active sessions</div>
        ) : isMobile ? (
          <MobileSessionList sessions={sessions} />
        ) : (
          <DesktopSessionTable sessions={sessions} />
        )}
      </CardContent>
    </Card>
  );
}
