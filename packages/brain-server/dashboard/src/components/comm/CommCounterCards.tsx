import { useRef, useEffect } from 'react';
import type { CommMetrics } from '@/types';

interface Props {
  metrics: CommMetrics | null;
  history: CommMetrics[];
}

const CARDS: { key: keyof CommMetrics; label: string; color: string }[] = [
  { key: 'received', label: 'Received', color: '#58a6ff' },
  { key: 'validated', label: 'Validated', color: '#58a6ff' },
  { key: 'routed', label: 'Routed', color: '#58a6ff' },
  { key: 'pipelineProcessed', label: 'Processed', color: '#58a6ff' },
  { key: 'errors', label: 'Errors', color: '#f85149' },
  { key: 'deduplicated', label: 'Deduped', color: '#8b949e' },
];

function Sparkline({ data, color }: { data: number[]; color: string }) {
  if (data.length < 2) return null;
  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const range = max - min || 1;
  const w = 64;
  const h = 20;
  const points = data
    .map((v, i) => `${(i / (data.length - 1)) * w},${h - ((v - min) / range) * h}`)
    .join(' ');
  return (
    <svg width={w} height={h} className="mt-1">
      <polyline points={points} fill="none" stroke={color} strokeWidth="1.5" />
    </svg>
  );
}

export function CommCounterCards({ metrics, history }: Props) {
  const rateRef = useRef<{ ts: number; vals: Record<string, number> }>({ ts: Date.now(), vals: {} });
  const rates = useRef<Record<string, number>>({});

  useEffect(() => {
    if (!metrics) return;
    const now = Date.now();
    const elapsed = (now - rateRef.current.ts) / 60_000;
    if (elapsed > 0.05) {
      for (const c of CARDS) {
        const cur = (metrics[c.key] as number) ?? 0;
        const prev = rateRef.current.vals[c.key] ?? cur;
        rates.current[c.key] = Math.round((cur - prev) / elapsed);
      }
      rateRef.current = { ts: now, vals: Object.fromEntries(CARDS.map(c => [c.key, (metrics[c.key] as number) ?? 0])) };
    }
  }, [metrics]);

  return (
    <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
      {CARDS.map((c) => {
        const val = (metrics?.[c.key] as number) ?? 0;
        const rate = rates.current[c.key] ?? 0;
        const sparkData = history.map((m) => (m[c.key] as number) ?? 0);
        return (
          <div key={c.key} className="rounded-md border border-border bg-card p-3">
            <div className="text-2xl font-semibold font-mono" style={{ color: c.color }}>{val}</div>
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{c.label}</div>
            {rate > 0 && <div className="text-[10px] text-muted-foreground">{rate}/min</div>}
            <Sparkline data={sparkData} color={c.color} />
          </div>
        );
      })}
    </div>
  );
}
