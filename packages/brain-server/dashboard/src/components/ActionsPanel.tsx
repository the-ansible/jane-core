import { useState, useEffect } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { relTime, apiUrl } from '@/lib/utils';
import type { Goal, GoalAction, ActionStatus } from '@/types';

interface ActionsPanelProps {
  goals: Goal[];
}

function actionVariant(status: ActionStatus) {
  if (status === 'done') return 'default';
  if (status === 'executing') return 'warning';
  if (status === 'failed') return 'destructive';
  if (status === 'rejected') return 'muted';
  return 'muted';
}

function actionIcon(status: ActionStatus) {
  if (status === 'done') return '✓';
  if (status === 'executing') return '⟳';
  if (status === 'failed') return '✗';
  if (status === 'rejected') return '—';
  if (status === 'selected') return '→';
  return '·';
}

interface GoalWithActions {
  goal: Goal;
  actions: GoalAction[];
}

export function ActionsPanel({ goals }: ActionsPanelProps) {
  const [data, setData] = useState<GoalWithActions[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (goals.length === 0) return;
    setLoading(true);

    // Fetch actions for all active/recent goals in parallel
    const targetGoals = goals.filter((g) => g.status === 'active' || g.status === 'paused');
    Promise.all(
      targetGoals.map((g) =>
        fetch(apiUrl(`/api/goals/${g.id}`))
          .then((r) => r.json())
          .then((d) => ({ goal: g, actions: (d.actions ?? []) as GoalAction[] }))
          .catch(() => ({ goal: g, actions: [] }))
      )
    )
      .then((results) => setData(results.filter((r) => r.actions.length > 0)))
      .finally(() => setLoading(false));
  }, [goals]);

  const allActions = data.flatMap((d) =>
    d.actions.map((a) => ({ ...a, goalTitle: d.goal.title }))
  ).sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>Recent Actions</CardTitle>
          {loading && <span className="text-xs text-muted-foreground">loading…</span>}
        </div>
      </CardHeader>
      <CardContent>
        {allActions.length === 0 ? (
          <p className="text-center text-xs text-muted-foreground">
            {loading ? 'Loading…' : 'No actions yet'}
          </p>
        ) : (
          <div className="space-y-1.5">
            {allActions.slice(0, 30).map((a) => (
              <div
                key={a.id}
                className="rounded-md border border-border bg-muted px-3 py-2"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <div className="flex items-center gap-1.5">
                      <span
                        className="font-mono text-xs"
                        style={{
                          color: a.status === 'done' ? '#58a6ff'
                            : a.status === 'executing' ? '#d29922'
                            : a.status === 'failed' ? '#f85149'
                            : '#8b949e',
                        }}
                      >
                        {actionIcon(a.status as ActionStatus)}
                      </span>
                      <span className="text-xs text-card-foreground">{a.description}</span>
                    </div>
                    <div className="flex gap-2 text-[11px] text-muted-foreground">
                      <span className="truncate" style={{ color: '#58a6ff', opacity: 0.7 }}>{a.goalTitle}</span>
                      {a.score != null && <span>score: {a.score}/10</span>}
                      <span>{relTime(a.created_at)}</span>
                    </div>
                    {a.outcome_text && (
                      <p className="mt-0.5 text-[11px] text-muted-foreground">{a.outcome_text}</p>
                    )}
                  </div>
                  <Badge variant={actionVariant(a.status as ActionStatus)}>{a.status}</Badge>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
