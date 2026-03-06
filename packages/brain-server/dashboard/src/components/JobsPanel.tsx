import { useState } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { fmtMs, relTime } from '@/lib/utils';
import type { AgentJob, JobStatus } from '@/types';

interface JobsPanelProps {
  jobs: AgentJob[];
}

const STATUS_COLORS: Record<JobStatus, string> = {
  running: '#d29922',
  queued: '#58a6ff',
  done: '#58a6ff',
  failed: '#f85149',
  dead_letter: '#f85149',
  unresponsive: '#f85149',
};

function statusVariant(status: JobStatus): 'default' | 'warning' | 'destructive' | 'muted' {
  if (status === 'running') return 'warning';
  if (status === 'done') return 'default';
  if (status === 'queued') return 'muted';
  return 'destructive';
}

function StatusDot({ status }: { status: JobStatus }) {
  return (
    <span
      className="inline-block h-2 w-2 shrink-0 rounded-full"
      style={{ backgroundColor: STATUS_COLORS[status] }}
    />
  );
}

function LiveDuration({ startedAt, completedAt }: { startedAt: string | null; completedAt: string | null }) {
  const [, setTick] = useState(0);

  if (!startedAt) return <span className="font-mono text-xs text-muted-foreground">—</span>;

  if (!completedAt) {
    setTimeout(() => setTick((t) => t + 1), 1000);
  }

  const ms = (completedAt ? new Date(completedAt).getTime() : Date.now()) - new Date(startedAt).getTime();
  return <span className="font-mono text-xs">{fmtMs(ms)}</span>;
}

function JobDetail({ job }: { job: AgentJob }) {
  return (
    <div className="mt-2 border-t border-border pt-2 text-[11px]">
      <div className="space-y-1">
        <div className="text-muted-foreground">
          <span className="text-primary">Prompt:</span>{' '}
          <span className="whitespace-pre-wrap leading-relaxed">{job.prompt}</span>
        </div>
        {job.pid && (
          <div className="text-muted-foreground">
            <span className="text-primary">PID:</span> {job.pid}
          </div>
        )}
        {job.retry_count > 0 && (
          <div style={{ color: '#d29922' }}>Retry #{job.retry_count}</div>
        )}
        {job.error_message && (
          <div className="text-destructive">{job.error_message}</div>
        )}
        {job.result_text && (
          <div className="mt-1.5 rounded border border-border/50 bg-muted/20 p-2">
            <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
              Result
            </div>
            <div className="whitespace-pre-wrap leading-relaxed text-foreground">
              {job.result_text.slice(0, 500)}
              {job.result_text.length > 500 && '…'}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const STAGE_PROGRESS: Record<JobStatus, number> = {
  queued: 0, running: 1, done: 2, failed: 2, dead_letter: 2, unresponsive: 1,
};

function StageBar({ job }: { job: AgentJob }) {
  const isFailed = job.status === 'failed' || job.status === 'dead_letter';
  const reached = STAGE_PROGRESS[job.status];
  const stages = [
    { label: 'Queued', idx: 0 },
    { label: 'Running', idx: 1 },
    { label: 'Done', idx: 2 },
  ];
  return (
    <div className="mt-1 flex gap-0.5">
      {stages.map((s) => {
        const isReached = reached >= s.idx;
        const isFailedStage = isFailed && s.idx === reached;
        return (
          <div
            key={s.label}
            className="h-1.5 flex-1 rounded-sm"
            style={{
              backgroundColor: isFailedStage ? '#f85149' : isReached ? STATUS_COLORS[job.status] : '#2d333b',
              opacity: isReached ? 0.85 : 0.35,
            }}
            title={s.label}
          />
        );
      })}
    </div>
  );
}

function JobRow({ job }: { job: AgentJob }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      className="cursor-pointer rounded px-2 py-1.5 hover:bg-muted/50"
      onClick={() => setExpanded(!expanded)}
    >
      <div className="flex items-center gap-2">
        <StatusDot status={job.status} />
        <span className="flex-1 truncate text-xs text-card-foreground">{job.prompt}</span>
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{job.job_type}</span>
        <LiveDuration startedAt={job.started_at} completedAt={job.completed_at} />
        <Badge variant={statusVariant(job.status)}>{job.status}</Badge>
      </div>
      <StageBar job={job} />
      <div className="mt-0.5 ml-4 text-[10px] text-muted-foreground">
        {relTime(job.created_at)}
        {job.status === 'running' && job.last_heartbeat_at && (
          <span className="ml-2">heartbeat {relTime(job.last_heartbeat_at)}</span>
        )}
      </div>
      {expanded && <JobDetail job={job} />}
    </div>
  );
}

export function JobsPanel({ jobs }: JobsPanelProps) {
  const runningCount = jobs.filter((j) => j.status === 'running').length;
  const queuedCount = jobs.filter((j) => j.status === 'queued').length;

  // Running first, then queued, then most recent
  const sorted = [...jobs].sort((a, b) => {
    const order: Record<JobStatus, number> = {
      running: 0, queued: 1, done: 2, failed: 3, unresponsive: 4, dead_letter: 5,
    };
    if (order[a.status] !== order[b.status]) return order[a.status] - order[b.status];
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <CardTitle>Agent Jobs</CardTitle>
          {runningCount > 0 && <Badge variant="warning">{runningCount} running</Badge>}
          {queuedCount > 0 && <Badge variant="muted">{queuedCount} queued</Badge>}
        </div>
      </CardHeader>
      <CardContent>
        {sorted.length === 0 ? (
          <div className="py-4 text-center text-xs text-muted-foreground">No jobs</div>
        ) : (
          <div className="max-h-80 space-y-1 overflow-y-auto">
            {sorted.slice(0, 20).map((job) => (
              <JobRow key={job.id} job={job} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
