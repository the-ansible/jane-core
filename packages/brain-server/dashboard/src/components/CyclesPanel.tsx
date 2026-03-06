import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { toPacific, fmtMs } from '@/lib/utils';
import type { GoalCycle } from '@/types';

interface CyclesPanelProps {
  cycles: GoalCycle[];
  cycleRunning: boolean;
}

function cycleVariant(status: GoalCycle['status']) {
  if (status === 'done') return 'default';
  if (status === 'running') return 'warning';
  return 'destructive';
}

function cycleIcon(status: GoalCycle['status']) {
  if (status === 'done') return '✓';
  if (status === 'running') return '⟳';
  return '✗';
}

export function CyclesPanel({ cycles, cycleRunning }: CyclesPanelProps) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>Cycle History</CardTitle>
          {cycleRunning && (
            <span className="font-mono text-xs" style={{ color: '#d29922' }}>
              cycle in progress…
            </span>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {cycles.length === 0 ? (
          <p className="text-center text-xs text-muted-foreground">No cycles yet</p>
        ) : (
          <div className="space-y-1.5">
            {cycles.map((c) => {
              const durationMs =
                c.completed_at
                  ? new Date(c.completed_at).getTime() - new Date(c.started_at).getTime()
                  : null;

              return (
                <div
                  key={c.id}
                  className="flex items-start justify-between gap-2 rounded-md border border-border bg-muted px-3 py-2"
                >
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-sm" style={{ color: c.status === 'done' ? '#58a6ff' : c.status === 'running' ? '#d29922' : '#f85149' }}>
                        {cycleIcon(c.status)}
                      </span>
                      <span className="text-xs text-card-foreground">{toPacific(c.started_at)}</span>
                      {durationMs != null && (
                        <span className="font-mono text-[11px] text-muted-foreground">{fmtMs(durationMs)}</span>
                      )}
                    </div>
                    <div className="flex gap-3 text-[11px] text-muted-foreground">
                      <span>{c.goals_assessed} assessed</span>
                      <span>{c.candidates_generated} candidates</span>
                      {c.action_selected_id && <span className="text-primary">action selected</span>}
                    </div>
                    {c.cycle_notes && (
                      <p className="mt-0.5 text-[11px] text-muted-foreground">{c.cycle_notes}</p>
                    )}
                  </div>
                  <Badge variant={cycleVariant(c.status)}>{c.status}</Badge>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
