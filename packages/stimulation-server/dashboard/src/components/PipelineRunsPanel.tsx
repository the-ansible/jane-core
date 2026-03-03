import { useState } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { fmtMs, toPacific } from '@/lib/utils';
import type { PipelineRun, PipelineStage, PipelineRunStatus, RecoveryReport } from '@/types';

const STAGES: PipelineStage[] = ['routing', 'safety_check', 'context_assembly', 'agent', 'composer', 'publish'];

const STAGE_LABELS: Record<PipelineStage, string> = {
  routing: 'Route',
  safety_check: 'Safety',
  context_assembly: 'Context',
  agent: 'Agent',
  composer: 'Composer',
  publish: 'Publish',
};

const STATUS_COLORS: Record<PipelineRunStatus, string> = {
  running: '#d29922',
  success: '#58a6ff',
  failure: '#f85149',
};

function StatusDot({ status }: { status: PipelineRunStatus }) {
  return (
    <span
      className="inline-block h-2 w-2 rounded-full"
      style={{ backgroundColor: STATUS_COLORS[status] }}
    />
  );
}

function LiveDuration({ startedAt, completedAt }: { startedAt: string; completedAt?: string }) {
  const [, setTick] = useState(0);

  // Re-render every second for running durations
  if (!completedAt) {
    setTimeout(() => setTick(t => t + 1), 1000);
  }

  const ms = (completedAt ? new Date(completedAt).getTime() : Date.now()) - new Date(startedAt).getTime();
  return <span className="font-mono text-xs">{fmtMs(ms)}</span>;
}

function StageBar({ run }: { run: PipelineRun }) {
  return (
    <div className="flex gap-0.5">
      {STAGES.map((stage) => {
        const record = run.stages.find(s => s.stage === stage);
        let bg = '#2d333b'; // not reached
        if (record) {
          bg = STATUS_COLORS[record.status];
        }
        const isCurrent = run.currentStage === stage;
        return (
          <div
            key={stage}
            className="h-1.5 flex-1 rounded-sm"
            style={{
              backgroundColor: bg,
              opacity: isCurrent ? 1 : 0.7,
              animation: isCurrent ? 'pulse 1.5s ease-in-out infinite' : undefined,
            }}
            title={`${STAGE_LABELS[stage]}${record ? `: ${record.status}` : ''}`}
          />
        );
      })}
    </div>
  );
}

function OutputBlock({ label, text, color }: { label: string; text: string; color: string }) {
  return (
    <div className="mt-2 rounded border border-border/50 bg-muted/20 p-2">
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide" style={{ color }}>
        {label}
      </div>
      <div className="whitespace-pre-wrap text-[11px] leading-relaxed text-foreground">
        {text}
      </div>
    </div>
  );
}

function RunDetail({ run }: { run: PipelineRun }) {
  return (
    <div className="mt-2 border-t border-border pt-2">
      <div className="space-y-1">
        {run.stages.map((stage, i) => (
          <div key={i} className="flex items-center gap-2 text-[11px]">
            <StatusDot status={stage.status} />
            <span className="w-16 text-muted-foreground">{STAGE_LABELS[stage.stage]}</span>
            <span className="font-mono">{fmtMs(stage.durationMs)}</span>
            {stage.detail && (
              <span className="text-muted-foreground">{stage.detail}</span>
            )}
            {stage.error && (
              <span className="text-destructive">{stage.error}</span>
            )}
          </div>
        ))}
        {run.error && (
          <div className="text-[11px] text-destructive">
            {run.error}
          </div>
        )}
      </div>
      {run.agentOutput && (
        <OutputBlock label="Agent" text={run.agentOutput} color="#58a6ff" />
      )}
      {run.composerOutput && run.composerOutput !== run.agentOutput && (
        <OutputBlock label="Composed" text={run.composerOutput} color="#d29922" />
      )}
    </div>
  );
}

function RunRow({ run }: { run: PipelineRun }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      className="cursor-pointer rounded px-2 py-1.5 hover:bg-muted/50"
      onClick={() => setExpanded(!expanded)}
    >
      <div className="flex items-center gap-2">
        <StatusDot status={run.status} />
        <span className="flex-1 truncate text-xs">{run.contentPreview}</span>
        <span className="text-[11px] text-muted-foreground">{run.senderName}</span>
        <LiveDuration startedAt={run.startedAt} completedAt={run.completedAt} />
        {run.attachedJobId && (
          <Badge variant="outline" className="text-[10px] border-blue-600 text-blue-400">
            Attached
          </Badge>
        )}
        {run.recoveredJobId && (
          <Badge variant="outline" className="text-[10px] border-yellow-600 text-yellow-500">
            Recovered
          </Badge>
        )}
        {run.currentStage && (
          <Badge variant="warning" className="text-[10px]">
            {STAGE_LABELS[run.currentStage]}
          </Badge>
        )}
      </div>
      <div className="mt-1">
        <StageBar run={run} />
      </div>
      {expanded && <RunDetail run={run} />}
    </div>
  );
}

function RecoverySummary({ report }: { report: RecoveryReport }) {
  const hasActivity = report.totalStale > 0;
  const timeLabel = toPacific(report.checkedAt);

  return (
    <div
      className="mb-3 rounded border px-3 py-2 text-[11px]"
      style={{ borderColor: hasActivity ? '#d29922' : '#2d333b', backgroundColor: hasActivity ? 'rgba(210,153,34,0.07)' : 'transparent' }}
    >
      <div className="flex items-center gap-2 mb-1">
        <span className="font-semibold" style={{ color: hasActivity ? '#d29922' : '#768390' }}>
          Last Restart Recovery
        </span>
        <span className="text-muted-foreground">{timeLabel}</span>
      </div>
      {!hasActivity ? (
        <div className="text-muted-foreground">No stale jobs found — clean restart.</div>
      ) : (
        <div className="flex flex-wrap gap-3">
          {report.alive.length > 0 && (
            <span>
              <span style={{ color: '#58a6ff' }} className="font-semibold">{report.alive.length}</span>
              <span className="text-muted-foreground ml-1">wrapper{report.alive.length > 1 ? 's' : ''} still running (attached)</span>
            </span>
          )}
          {report.requeued.length > 0 && (
            <span>
              <span style={{ color: '#d29922' }} className="font-semibold">{report.requeued.length}</span>
              <span className="text-muted-foreground ml-1">job{report.requeued.length > 1 ? 's' : ''} re-queued</span>
            </span>
          )}
          {report.deadLettered.length > 0 && (
            <span>
              <span style={{ color: '#f85149' }} className="font-semibold">{report.deadLettered.length}</span>
              <span className="text-muted-foreground ml-1">dead-lettered</span>
            </span>
          )}
        </div>
      )}
    </div>
  );
}

interface PipelineRunsPanelProps {
  pipelineRuns: PipelineRun[];
  recoveryReport?: RecoveryReport | null;
}

export function PipelineRunsPanel({ pipelineRuns, recoveryReport }: PipelineRunsPanelProps) {
  const activeCount = pipelineRuns.filter(r => r.status === 'running').length;

  // Show running first, then most recent
  const sorted = [...pipelineRuns].sort((a, b) => {
    if (a.status === 'running' && b.status !== 'running') return -1;
    if (a.status !== 'running' && b.status === 'running') return 1;
    return new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime();
  });

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <CardTitle>Pipeline Runs</CardTitle>
          {activeCount > 0 && (
            <Badge variant="warning">{activeCount} active</Badge>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {recoveryReport && <RecoverySummary report={recoveryReport} />}
        {sorted.length === 0 ? (
          <div className="text-center text-xs text-muted-foreground py-4">
            No pipeline runs yet
          </div>
        ) : (
          <div className="max-h-80 space-y-1 overflow-y-auto">
            {sorted.slice(0, 20).map((run) => (
              <RunRow key={run.runId} run={run} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
