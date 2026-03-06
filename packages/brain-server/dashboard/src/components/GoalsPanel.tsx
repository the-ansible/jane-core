import { useState } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { relTime } from '@/lib/utils';
import type { Goal, GoalStatus } from '@/types';

interface GoalsPanelProps {
  goals: Goal[];
}

const STATUS_ORDER: GoalStatus[] = ['active', 'paused', 'achieved', 'abandoned'];

function statusVariant(s: GoalStatus) {
  if (s === 'active') return 'default';
  if (s === 'paused') return 'warning';
  if (s === 'achieved') return 'muted';
  return 'destructive';
}

function levelColor(l: string) {
  if (l === 'asymptotic') return '#58a6ff';
  if (l === 'strategic') return '#d29922';
  if (l === 'tactical') return '#8b949e';
  return '#8b949e';
}

function GoalRow({ goal }: { goal: Goal }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      className="cursor-pointer rounded-md border border-border bg-muted px-3 py-2.5 transition-colors hover:border-primary/30"
      onClick={() => setExpanded((v) => !v)}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span
            className="shrink-0 text-[11px] font-medium uppercase"
            style={{ color: levelColor(goal.level) }}
          >
            {goal.level}
          </span>
          <span className="truncate text-sm font-medium text-card-foreground">{goal.title}</span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="font-mono text-[11px] text-muted-foreground">p{goal.priority}</span>
          <Badge variant={statusVariant(goal.status)}>{goal.status}</Badge>
        </div>
      </div>

      {expanded && (
        <div className="mt-2 space-y-1 text-xs text-muted-foreground">
          <p>{goal.description}</p>
          {goal.motivation && <p className="italic">Motivation: {goal.motivation}</p>}
          {goal.success_criteria && (
            <p>
              <span className="text-primary">Success criteria:</span> {goal.success_criteria}
            </p>
          )}
          {goal.progress_notes && (
            <p>
              <span className="text-primary">Progress:</span> {goal.progress_notes}
            </p>
          )}
          <p className="text-[11px]">Last evaluated: {relTime(goal.last_evaluated_at ?? undefined)}</p>
          <p className="text-[11px]">Created: {relTime(goal.created_at)}</p>
        </div>
      )}
    </div>
  );
}

export function GoalsPanel({ goals }: GoalsPanelProps) {
  const [filter, setFilter] = useState<GoalStatus | 'all'>('all');

  const grouped = STATUS_ORDER.reduce<Record<GoalStatus, Goal[]>>(
    (acc, s) => {
      acc[s] = goals.filter((g) => g.status === s);
      return acc;
    },
    { active: [], paused: [], achieved: [], abandoned: [] }
  );

  const filtered = filter === 'all' ? goals : grouped[filter];
  const sorted = [...filtered].sort((a, b) => b.priority - a.priority);

  const tabs: Array<{ key: GoalStatus | 'all'; label: string; count: number }> = [
    { key: 'all', label: 'All', count: goals.length },
    { key: 'active', label: 'Active', count: grouped.active.length },
    { key: 'paused', label: 'Paused', count: grouped.paused.length },
    { key: 'achieved', label: 'Achieved', count: grouped.achieved.length },
    { key: 'abandoned', label: 'Abandoned', count: grouped.abandoned.length },
  ];

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>Goals</CardTitle>
          <div className="flex gap-1">
            {tabs.map((t) => (
              <button
                key={t.key}
                onClick={() => setFilter(t.key)}
                className="rounded px-2 py-0.5 text-xs transition-colors"
                style={{
                  background: filter === t.key ? '#1f6feb' : 'transparent',
                  color: filter === t.key ? '#ffffff' : '#8b949e',
                  border: '1px solid',
                  borderColor: filter === t.key ? '#1f6feb' : 'transparent',
                }}
              >
                {t.label} {t.count > 0 && <span className="opacity-70">({t.count})</span>}
              </button>
            ))}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {sorted.length === 0 ? (
          <p className="text-center text-xs text-muted-foreground">No goals</p>
        ) : (
          <div className="space-y-2">
            {sorted.map((g) => (
              <GoalRow key={g.id} goal={g} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
