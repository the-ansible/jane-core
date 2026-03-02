import { useRef, useEffect } from 'react';
import { Card } from '@/components/ui/card';
import type { Metrics } from '@/types';
import type { MetricsSnapshot } from '@/hooks/use-dashboard-data';

interface CounterCardsProps {
  metrics: Metrics | null;
  history: MetricsSnapshot[];
}

interface CounterDef {
  key: keyof MetricsSnapshot;
  label: string;
}

const COUNTERS: CounterDef[] = [
  { key: 'received', label: 'Received' },
  { key: 'validated', label: 'Validated' },
  { key: 'classified', label: 'Classified' },
  { key: 'pipelineProcessed', label: 'Processed' },
  { key: 'errors', label: 'Errors' },
  { key: 'deduplicated', label: 'Deduped' },
];

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

export function CounterCards({ metrics, history }: CounterCardsProps) {
  const prevRef = useRef<{ metrics: Metrics; time: number } | null>(null);
  const ratesRef = useRef<Record<string, string>>({});

  useEffect(() => {
    if (!metrics) return;
    const now = Date.now();
    if (prevRef.current) {
      const dt = (now - prevRef.current.time) / 60000;
      if (dt > 0.01) {
        for (const c of COUNTERS) {
          const cur = (metrics as any)[c.key] ?? 0;
          const prev = (prevRef.current.metrics as any)[c.key] ?? 0;
          ratesRef.current[c.key] = `${((cur - prev) / dt).toFixed(1)}/min`;
        }
      }
    }
    prevRef.current = { metrics, time: now };
  }, [metrics]);

  return (
    <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
      {COUNTERS.map((c) => {
        const value = metrics?.[c.key] ?? 0;
        const sparkValues = history.map((h) => h[c.key]);
        const color = c.key === 'errors' ? '#f85149' : '#58a6ff';

        return (
          <Card key={c.key} className="p-3.5 text-center">
            <div className="font-mono text-2xl font-bold text-card-foreground">{String(value)}</div>
            <div className="mt-1 text-[11px] uppercase tracking-wide text-muted-foreground">{c.label}</div>
            <div className="mt-0.5 font-mono text-[11px] text-primary">
              {ratesRef.current[c.key] ?? '--/min'}
            </div>
            <Sparkline values={sparkValues} color={color} />
          </Card>
        );
      })}
    </div>
  );
}
