import { useRef, useEffect } from 'react';
import { Card } from '@/components/ui/card';
import type { Goal, GoalCycle, BrainMetrics } from '@/types';

interface StatsRowProps {
  goals: Goal[];
  cycles: GoalCycle[];
  cycleRunning: boolean;
  metrics: BrainMetrics | null;
}

interface StatSnapshot {
  active: number;
  achieved: number;
  total: number;
  cyclesRun: number;
  runningJobs: number;
}

function Sparkline({ values, color = '#58a6ff' }: { values: number[]; color?: string }) {
  if (values.length < 2) return null;

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const w = 64;
  const h = 20;
  const step = w / (values.length - 1);

  const points = values
    .map((v, i) => `${i * step},${h - ((v - min) / range) * h}`)
    .join(' ');

  return (
    <svg width={w} height={h} className="mx-auto mt-1.5" viewBox={`0 0 ${w} ${h}`}>
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.6"
      />
    </svg>
  );
}

export function StatsRow({ goals, cycles, cycleRunning, metrics }: StatsRowProps) {
  const historyRef = useRef<StatSnapshot[]>([]);

  const active = goals.filter((g) => g.status === 'active').length;
  const achieved = goals.filter((g) => g.status === 'achieved').length;
  const runningJobs = metrics?.runningJobs ?? 0;

  const lastCycle = cycles[0];
  const lastCycleLabel = lastCycle
    ? new Date(lastCycle.completed_at ?? lastCycle.started_at).toLocaleString('en-US', {
        timeZone: 'America/Los_Angeles',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      })
    : '--';

  useEffect(() => {
    const snap: StatSnapshot = {
      active,
      achieved,
      total: goals.length,
      cyclesRun: cycles.length,
      runningJobs,
    };
    historyRef.current = [...historyRef.current.slice(-29), snap];
  }, [active, achieved, goals.length, cycles.length, runningJobs]);

  const history = historyRef.current;

  const stats: Array<{
    key: keyof StatSnapshot | null;
    label: string;
    value: string;
    color: string;
    small?: boolean;
  }> = [
    { key: 'active', label: 'Active Goals', value: String(active), color: '#58a6ff' },
    { key: 'achieved', label: 'Achieved', value: String(achieved), color: '#58a6ff' },
    { key: 'total', label: 'Total Goals', value: String(goals.length), color: '#58a6ff' },
    { key: 'cyclesRun', label: 'Cycles Run', value: String(cycles.length), color: '#58a6ff' },
    {
      key: 'runningJobs',
      label: 'Running Jobs',
      value: String(runningJobs),
      color: runningJobs > 0 ? '#d29922' : '#58a6ff',
    },
    {
      key: null,
      label: 'Last Cycle',
      value: cycleRunning ? 'Running…' : lastCycleLabel,
      color: cycleRunning ? '#d29922' : '#8b949e',
      small: true,
    },
  ];

  return (
    <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
      {stats.map((s) => (
        <Card key={s.label} className="p-3.5 text-center">
          <div
            className={`font-mono font-bold text-card-foreground ${s.small ? 'text-sm' : 'text-2xl'}`}
            style={{ color: s.color }}
          >
            {s.value}
          </div>
          <div className="mt-1 text-[11px] uppercase tracking-wide text-muted-foreground">
            {s.label}
          </div>
          {s.key && !s.small && (
            <Sparkline
              values={history.map((h) => h[s.key as keyof StatSnapshot])}
              color={s.color}
            />
          )}
        </Card>
      ))}
    </div>
  );
}
