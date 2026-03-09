import { useState } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import type { PipelineRun, PipelineStage } from '@/types';
import { fmtMs, relTime } from '@/lib/utils';

interface Props {
  runs: PipelineRun[];
}

const STAGE_ORDER: PipelineStage[] = ['routing', 'safety_check', 'context_assembly', 'agent', 'composer', 'publish'];

const STAGE_COLORS: Record<string, { done: string; running: string; fail: string }> = {
  routing: { done: '#58a6ff', running: '#d29922', fail: '#f85149' },
  safety_check: { done: '#58a6ff', running: '#d29922', fail: '#f85149' },
  context_assembly: { done: '#58a6ff', running: '#d29922', fail: '#f85149' },
  agent: { done: '#58a6ff', running: '#d29922', fail: '#f85149' },
  composer: { done: '#58a6ff', running: '#d29922', fail: '#f85149' },
  publish: { done: '#58a6ff', running: '#d29922', fail: '#f85149' },
};

function StageBar({ run }: { run: PipelineRun }) {
  const stageMap = new Map(run.stages.map(s => [s.stage, s]));
  return (
    <div className="flex gap-0.5 h-2 mt-1">
      {STAGE_ORDER.map((stage) => {
        const s = stageMap.get(stage);
        const colors = STAGE_COLORS[stage];
        let bg = '#21262d';
        if (s) {
          bg = s.status === 'success' ? colors.done : s.status === 'failure' ? colors.fail : colors.running;
        }
        return (
          <div
            key={stage}
            className={`flex-1 rounded-sm ${s?.status === 'running' ? 'animate-pulse' : ''}`}
            style={{ backgroundColor: bg }}
            title={`${stage}: ${s?.status ?? 'not reached'}${s?.durationMs ? ` (${fmtMs(s.durationMs)})` : ''}`}
          />
        );
      })}
    </div>
  );
}

function RunDetail({ run }: { run: PipelineRun }) {
  const stageMap = new Map(run.stages.map(s => [s.stage, s]));
  return (
    <div className="mt-2 space-y-1.5 text-xs">
      {STAGE_ORDER.map((stage) => {
        const s = stageMap.get(stage);
        if (!s) return null;
        const color = s.status === 'success' ? '#58a6ff' : s.status === 'failure' ? '#f85149' : '#d29922';
        return (
          <div key={stage} className="flex items-center gap-2">
            <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color }} />
            <span className="w-28 text-muted-foreground">{stage.replace('_', ' ')}</span>
            <span className="font-mono">{s.durationMs != null ? fmtMs(s.durationMs) : '--'}</span>
            {s.detail && <span className="text-muted-foreground truncate max-w-[200px]">{s.detail}</span>}
            {s.error && <span className="text-destructive truncate max-w-[200px]">{s.error}</span>}
          </div>
        );
      })}
      {run.agentOutput && (
        <div className="mt-2 rounded border border-primary/30 bg-primary/5 p-2">
          <div className="text-[10px] uppercase text-primary mb-1">Agent Output</div>
          <div className="text-xs text-card-foreground whitespace-pre-wrap break-words max-h-32 overflow-y-auto">{run.agentOutput}</div>
        </div>
      )}
      {run.composerOutput && run.composerOutput !== run.agentOutput && (
        <div className="mt-1 rounded border border-warning/30 bg-warning/5 p-2">
          <div className="text-[10px] uppercase text-warning mb-1">Composed</div>
          <div className="text-xs text-card-foreground whitespace-pre-wrap break-words max-h-32 overflow-y-auto">{run.composerOutput}</div>
        </div>
      )}
      {run.error && (
        <div className="text-xs text-destructive mt-1">{run.error}</div>
      )}
    </div>
  );
}

export function CommRunsPanel({ runs }: Props) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const activeCount = runs.filter(r => r.status === 'running').length;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <CardTitle>Pipeline Runs</CardTitle>
          {activeCount > 0 && <Badge variant="warning">{activeCount} active</Badge>}
        </div>
      </CardHeader>
      <CardContent>
        {runs.length === 0 ? (
          <div className="text-xs text-muted-foreground">No recent runs</div>
        ) : (
          <div className="space-y-1">
            {runs.slice(0, 20).map((run) => {
              const expanded = expandedId === run.runId;
              const statusColor = run.status === 'success' ? '#58a6ff' : run.status === 'failure' ? '#f85149' : '#d29922';
              return (
                <div
                  key={run.runId}
                  className="rounded border border-border p-2 cursor-pointer hover:bg-muted/30 transition-colors"
                  onClick={() => setExpandedId(expanded ? null : run.runId)}
                >
                  <div className="flex items-center gap-2 text-xs">
                    <span className="inline-block h-2 w-2 rounded-full flex-shrink-0" style={{ backgroundColor: statusColor }} />
                    <span className="truncate max-w-[200px] text-card-foreground">{run.contentPreview}</span>
                    <span className="text-muted-foreground">{run.senderName}</span>
                    <span className="ml-auto font-mono text-muted-foreground">
                      {run.totalMs != null ? fmtMs(run.totalMs) : run.status === 'running' ? 'running...' : '--'}
                    </span>
                    {run.routeAction && (
                      <Badge variant="muted">{run.routeAction}</Badge>
                    )}
                  </div>
                  <StageBar run={run} />
                  {expanded && <RunDetail run={run} />}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
