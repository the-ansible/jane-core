import { useState } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { apiUrl, fmtMs, relTime } from '@/lib/utils';
import type { MemoryStats, ConsolidationState, Memory } from '@/types';

interface MemoryPanelProps {
  memoryStats: MemoryStats | null;
  consolidation: ConsolidationState | null;
  memories: Memory[];
}

const TYPE_COLORS: Record<string, string> = {
  episodic: '#58a6ff',
  semantic: '#d29922',
  procedural: '#388bfd',
  working: '#8b949e',
};

function MemoryRow({ memory }: { memory: Memory }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      className="cursor-pointer rounded px-2 py-1.5 hover:bg-muted/50"
      onClick={() => setExpanded(!expanded)}
    >
      <div className="flex items-start gap-2">
        <span
          className="mt-0.5 inline-block h-2 w-2 shrink-0 rounded-full"
          style={{ backgroundColor: TYPE_COLORS[memory.type] ?? '#8b949e' }}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-xs text-card-foreground">{memory.title}</span>
            <span
              className="shrink-0 font-mono text-[10px]"
              style={{ color: TYPE_COLORS[memory.type] ?? '#8b949e' }}
            >
              {memory.type}
            </span>
            <span className="shrink-0 text-[10px] text-muted-foreground">
              {(memory.importance * 10).toFixed(0)}/10
            </span>
          </div>
          {expanded && (
            <div className="mt-1.5 border-t border-border pt-1.5 text-[11px] text-muted-foreground">
              <p className="whitespace-pre-wrap leading-relaxed">{memory.content}</p>
              {memory.tags.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {memory.tags.map((t) => (
                    <span
                      key={t}
                      className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
                    >
                      {t}
                    </span>
                  ))}
                </div>
              )}
              <p className="mt-1 text-[10px]">Created {relTime(memory.created_at)}</p>
            </div>
          )}
        </div>
        <span className="shrink-0 text-[10px] text-muted-foreground">{relTime(memory.created_at)}</span>
      </div>
    </div>
  );
}

export function MemoryPanel({ memoryStats, consolidation, memories }: MemoryPanelProps) {
  const [consolidating, setConsolidating] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  async function handleConsolidate() {
    if (consolidating || consolidation?.consolidating) return;
    setConsolidating(true);
    try {
      await fetch(apiUrl('/api/memories/consolidate'), { method: 'POST' });
    } catch { /* ignore */ } finally {
      setTimeout(() => setConsolidating(false), 3000);
    }
  }

  const isConsolidating = consolidating || (consolidation?.consolidating ?? false);
  const lastResult = consolidation?.result;

  // Count by type from memories list
  const typeCounts = memories.reduce<Record<string, number>>((acc, m) => {
    acc[m.type] = (acc[m.type] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <Card>
      <CardHeader
        className="cursor-pointer select-none"
        onClick={() => setCollapsed(!collapsed)}
      >
        <CardTitle className="flex items-center gap-2">
          <span className="text-xs">{collapsed ? '▶' : '▼'}</span>
          Memory
          <span className="ml-auto text-xs font-normal text-muted-foreground">
            {memoryStats?.total ?? '—'} total
          </span>
          {isConsolidating && (
            <Badge variant="warning" className="text-[10px]">consolidating</Badge>
          )}
        </CardTitle>
      </CardHeader>

      {!collapsed && (
        <CardContent>
          {/* Type breakdown + consolidation controls */}
          <div className="mb-3 flex flex-wrap items-center gap-4">
            {(['episodic', 'semantic', 'procedural', 'working'] as const).map((t) => (
              <div key={t} className="flex items-center gap-1.5">
                <span
                  className="inline-block h-2 w-2 rounded-full"
                  style={{ backgroundColor: TYPE_COLORS[t] }}
                />
                <span className="text-xs text-muted-foreground">{t}</span>
                <span className="font-mono text-xs" style={{ color: TYPE_COLORS[t] }}>
                  {typeCounts[t] ?? 0}
                </span>
              </div>
            ))}

            <div className="ml-auto flex items-center gap-3">
              {lastResult && (
                <span className="text-[11px] text-muted-foreground">
                  last run: {relTime(consolidation?.lastRunAt ?? undefined)}
                  {lastResult.stored > 0 && (
                    <> · <span className="text-primary">{lastResult.stored} stored</span></>
                  )}
                  {lastResult.durationMs && (
                    <> · {fmtMs(lastResult.durationMs)}</>
                  )}
                  {lastResult.error && (
                    <> · <span className="text-destructive">error</span></>
                  )}
                </span>
              )}
              <button
                onClick={(e) => { e.stopPropagation(); handleConsolidate(); }}
                disabled={isConsolidating}
                className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
                  isConsolidating
                    ? 'border-warning/50 text-warning'
                    : 'border-primary/50 text-primary hover:bg-primary/10'
                } disabled:opacity-40`}
              >
                {isConsolidating ? 'Consolidating…' : 'Consolidate'}
              </button>
            </div>
          </div>

          {/* Memory list */}
          {memories.length === 0 ? (
            <div className="py-4 text-center text-xs text-muted-foreground">No memories recorded yet</div>
          ) : (
            <div className="max-h-64 space-y-0.5 overflow-y-auto">
              {memories.slice(0, 30).map((m) => (
                <MemoryRow key={m.id} memory={m} />
              ))}
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}
