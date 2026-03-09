import { useState, useCallback } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import type { CommSession } from '@/types';
import { relTime, apiUrl } from '@/lib/utils';

interface Props {
  sessions: CommSession[];
}

interface SessionMessage {
  role: string;
  content: string;
  timestamp: string;
  sender?: { id: string; displayName?: string; type?: string };
}

interface ContextSummary {
  id: string;
  summary: string;
  topics: string[];
  entities: string[];
  msg_start_idx: number;
  msg_end_idx: number;
  msg_count: number;
  ts_start: string;
  ts_end: string;
  model: string;
  latency_ms: number | null;
  plan_name: string;
}

interface AssemblyRecord {
  id: string;
  plan_name: string;
  summary_count: number;
  raw_msg_count: number;
  total_msg_coverage: number;
  estimated_tokens: number;
  raw_tokens: number;
  summary_tokens: number;
  summary_budget: number;
  budget_utilization: number;
  raw_over_budget: boolean;
  assembly_ms: number;
  summarization_ms: number | null;
  pipeline_succeeded: boolean | null;
  assembled_at: string;
}

type SessionTab = 'messages' | 'context';

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

function SessionContext({ sessionId }: { sessionId: string }) {
  const [summaries, setSummaries] = useState<ContextSummary[] | null>(null);
  const [assemblies, setAssemblies] = useState<AssemblyRecord[] | null>(null);
  const [expandedSummary, setExpandedSummary] = useState<string | null>(null);

  const load = useCallback(() => {
    Promise.all([
      fetch(apiUrl(`/api/communication/context/sessions/${sessionId}/summaries`))
        .then(r => r.json()).then(d => d.summaries || []),
      fetch(apiUrl(`/api/communication/context/sessions/${sessionId}/assembly`))
        .then(r => r.json()).then(d => d.assemblies || []),
    ])
      .then(([s, a]) => { setSummaries(s); setAssemblies(a); })
      .catch(() => { setSummaries([]); setAssemblies([]); });
  }, [sessionId]);

  if (summaries === null) {
    return (
      <button onClick={load} className="text-[10px] text-primary hover:underline mt-1">
        Load context
      </button>
    );
  }

  const latestAssembly = assemblies && assemblies.length > 0 ? assemblies[0] : null;

  return (
    <div className="mt-2 space-y-3" onClick={e => e.stopPropagation()}>
      {/* Latest Assembly Stats */}
      {latestAssembly && (
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-1">
            Latest Assembly
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] rounded bg-muted/30 p-2">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Plan</span>
              <span className="font-mono">{latestAssembly.plan_name}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Assembly</span>
              <span className="font-mono">{latestAssembly.assembly_ms}ms</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Summaries</span>
              <span className="font-mono">{latestAssembly.summary_count}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Raw msgs</span>
              <span className="font-mono">{latestAssembly.raw_msg_count}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Coverage</span>
              <span className="font-mono">{latestAssembly.total_msg_coverage} msgs</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Tokens</span>
              <span className="font-mono">
                {latestAssembly.estimated_tokens.toLocaleString()}
                <span className="text-muted-foreground"> / {latestAssembly.summary_budget.toLocaleString()}</span>
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Budget</span>
              <span className={`font-mono ${latestAssembly.budget_utilization > 0.9 ? 'text-[#f85149]' : latestAssembly.budget_utilization > 0.7 ? 'text-[#d29922]' : 'text-[#58a6ff]'}`}>
                {(latestAssembly.budget_utilization * 100).toFixed(0)}%
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Pipeline</span>
              <span className={`font-mono ${latestAssembly.pipeline_succeeded === true ? 'text-[#58a6ff]' : latestAssembly.pipeline_succeeded === false ? 'text-[#f85149]' : 'text-muted-foreground'}`}>
                {latestAssembly.pipeline_succeeded === true ? 'ok' : latestAssembly.pipeline_succeeded === false ? 'failed' : 'pending'}
              </span>
            </div>
            {latestAssembly.raw_over_budget && (
              <div className="col-span-2 text-[10px] text-[#d29922]">
                Raw messages exceed summary budget (eager summarization needed)
              </div>
            )}
          </div>
          {/* Token breakdown bar */}
          {latestAssembly.estimated_tokens > 0 && (
            <div className="mt-1.5">
              <div className="flex h-2 rounded overflow-hidden bg-muted/50">
                <div
                  className="bg-[#58a6ff]"
                  style={{ width: `${(latestAssembly.summary_tokens / latestAssembly.estimated_tokens) * 100}%` }}
                  title={`Summaries: ${latestAssembly.summary_tokens.toLocaleString()} tokens`}
                />
                <div
                  className="bg-[#d29922]"
                  style={{ width: `${(latestAssembly.raw_tokens / latestAssembly.estimated_tokens) * 100}%` }}
                  title={`Raw: ${latestAssembly.raw_tokens.toLocaleString()} tokens`}
                />
              </div>
              <div className="flex justify-between text-[9px] text-muted-foreground mt-0.5">
                <span>Summaries ({latestAssembly.summary_tokens.toLocaleString()})</span>
                <span>Raw ({latestAssembly.raw_tokens.toLocaleString()})</span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Summaries List */}
      <div>
        <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-1">
          Summaries ({summaries.length})
        </div>
        {summaries.length === 0 ? (
          <div className="text-[10px] text-muted-foreground">No summaries yet (conversation too short or no summarization triggered)</div>
        ) : (
          <div className="space-y-1 max-h-56 overflow-y-auto">
            {summaries.map((s) => {
              const isExpanded = expandedSummary === s.id;
              const tsStart = new Date(s.ts_start).toLocaleString('en-US', {
                month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
                timeZone: 'America/Los_Angeles',
              });
              const tsEnd = new Date(s.ts_end).toLocaleTimeString('en-US', {
                hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles',
              });
              return (
                <div
                  key={s.id}
                  className="rounded border border-border p-1.5 cursor-pointer hover:bg-muted/20 transition-colors"
                  onClick={() => setExpandedSummary(isExpanded ? null : s.id)}
                >
                  <div className="flex items-center gap-2 text-[11px]">
                    <span className="text-muted-foreground font-mono text-[10px]">
                      msgs {s.msg_start_idx}-{s.msg_end_idx}
                    </span>
                    <span className="text-muted-foreground">{tsStart} - {tsEnd}</span>
                    <span className="ml-auto text-[10px] text-muted-foreground">{s.model}</span>
                    {s.latency_ms != null && (
                      <span className="text-[10px] text-muted-foreground">{s.latency_ms}ms</span>
                    )}
                  </div>
                  {s.topics.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-1">
                      {s.topics.map((t, i) => (
                        <span key={i} className="rounded bg-primary/10 px-1.5 py-0.5 text-[9px] text-primary">
                          {t}
                        </span>
                      ))}
                    </div>
                  )}
                  {isExpanded && (
                    <div className="mt-1.5 text-xs text-card-foreground whitespace-pre-wrap leading-relaxed border-t border-border pt-1.5">
                      {s.summary}
                      {s.entities.length > 0 && (
                        <div className="mt-1 text-[10px] text-muted-foreground">
                          Entities: {s.entities.join(', ')}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Assembly History */}
      {assemblies && assemblies.length > 1 && (
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-1">
            Assembly History ({assemblies.length})
          </div>
          <div className="space-y-0.5 max-h-32 overflow-y-auto">
            {assemblies.slice(0, 10).map((a) => (
              <div key={a.id} className="flex items-center gap-2 text-[10px] font-mono text-muted-foreground">
                <span className="w-16">
                  {new Date(a.assembled_at).toLocaleTimeString('en-US', {
                    hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles',
                  })}
                </span>
                <span>{a.summary_count}s+{a.raw_msg_count}r</span>
                <span>{a.estimated_tokens.toLocaleString()}tok</span>
                <span>{a.assembly_ms}ms</span>
                <span className={a.pipeline_succeeded === true ? 'text-[#58a6ff]' : a.pipeline_succeeded === false ? 'text-[#f85149]' : ''}>
                  {a.pipeline_succeeded === true ? 'ok' : a.pipeline_succeeded === false ? 'fail' : '-'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function CommSessionsPanel({ sessions }: Props) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<Record<string, SessionTab>>({});
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
          <div className="space-y-1 max-h-[500px] overflow-y-auto">
            {sorted.slice(0, 20).map((s) => {
              const expanded = expandedId === s.sessionId;
              const tab = activeTab[s.sessionId] || 'messages';
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
                  {expanded && (
                    <div onClick={e => e.stopPropagation()}>
                      {/* Tab switcher */}
                      <div className="flex gap-1 mt-2 mb-1">
                        {(['messages', 'context'] as const).map((t) => (
                          <button
                            key={t}
                            onClick={() => setActiveTab(prev => ({ ...prev, [s.sessionId]: t }))}
                            className={`rounded px-2 py-0.5 text-[10px] font-medium capitalize transition-colors ${
                              tab === t
                                ? 'bg-primary/15 text-primary'
                                : 'text-muted-foreground hover:text-card-foreground hover:bg-muted/50'
                            }`}
                          >
                            {t}
                          </button>
                        ))}
                      </div>
                      {tab === 'messages'
                        ? <SessionMessages sessionId={s.sessionId} />
                        : <SessionContext sessionId={s.sessionId} />
                      }
                    </div>
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
