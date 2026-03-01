import { useRef, useEffect } from 'react';
import { Card } from '@/components/ui/card';
import type { Metrics } from '@/types';

interface CounterCardsProps {
  metrics: Metrics | null;
}

interface CounterDef {
  key: keyof Pick<Metrics, 'received' | 'validated' | 'classified' | 'pipelineProcessed' | 'errors' | 'deduplicated'>;
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

export function CounterCards({ metrics }: CounterCardsProps) {
  const prevRef = useRef<{ metrics: Metrics; time: number } | null>(null);
  const ratesRef = useRef<Record<string, string>>({});

  useEffect(() => {
    if (!metrics) return;
    const now = Date.now();
    if (prevRef.current) {
      const dt = (now - prevRef.current.time) / 60000;
      if (dt > 0.01) {
        for (const c of COUNTERS) {
          const cur = metrics[c.key] ?? 0;
          const prev = prevRef.current.metrics[c.key] ?? 0;
          ratesRef.current[c.key] = `${(((cur as number) - (prev as number)) / dt).toFixed(1)}/min`;
        }
      }
    }
    prevRef.current = { metrics, time: now };
  }, [metrics]);

  return (
    <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
      {COUNTERS.map((c) => {
        const value = metrics?.[c.key] ?? 0;
        return (
          <Card key={c.key} className="p-3.5 text-center">
            <div className="font-mono text-2xl font-bold text-card-foreground">{String(value)}</div>
            <div className="mt-1 text-[11px] uppercase tracking-wide text-muted-foreground">{c.label}</div>
            <div className="mt-0.5 font-mono text-[11px] text-primary">
              {ratesRef.current[c.key] ?? '--/min'}
            </div>
          </Card>
        );
      })}
    </div>
  );
}
