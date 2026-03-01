import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import type { Metrics } from '@/types';

interface ClassificationPanelProps {
  metrics: Metrics | null;
}

const TIER_SEGMENTS = [
  { key: 'rules', color: '#1f6feb', label: 'rules' },
  { key: 'local_consensus', color: '#1f6feb', label: 'consensus' },
  { key: 'claude_escalation', color: '#d29922', label: 'escalation' },
  { key: 'fallback', color: '#6e7681', label: 'fallback' },
] as const;

function DistGroup({ title, dist }: { title: string; dist?: Record<string, number> }) {
  if (!dist) return null;
  return (
    <div className="min-w-[120px] flex-1">
      <h4 className="mb-1 text-[11px] uppercase text-muted-foreground">{title}</h4>
      {Object.entries(dist).map(([k, v]) => (
        <div key={k} className="flex justify-between py-px text-xs">
          <span>{k}</span>
          <span className="font-mono text-primary">{v}</span>
        </div>
      ))}
    </div>
  );
}

export function ClassificationPanel({ metrics }: ClassificationPanelProps) {
  const cl = metrics?.classification;
  const total = cl?.totalClassified || 1;
  const tiers = cl?.byTier || {};
  const cons = cl?.consensus;

  let consensusText = '--';
  if (cons && cons.totalVotes > 0) {
    const perfect = cons.perfectAgreement || 0;
    const majority = cons.majorityAgreement || 0;
    const totalRounds = perfect + majority;
    if (totalRounds > 0) {
      consensusText = `${((perfect / totalRounds) * 100).toFixed(0)}% perfect, avg ${(cons.avgAgreement || 0).toFixed(1)}/3`;
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Classification</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="mb-1 text-[11px] text-muted-foreground">Tier Distribution</div>
        <div className="mb-2 flex h-6 overflow-hidden rounded">
          {TIER_SEGMENTS.map((s) => {
            const count = tiers[s.key] || 0;
            const pct = total > 0 ? (count / total) * 100 : 0;
            if (pct <= 0) return null;
            return (
              <div
                key={s.key}
                className="flex items-center justify-center text-[10px] font-semibold text-white"
                style={{ background: s.color, width: `${pct}%`, minWidth: '2px' }}
                title={`${s.label}: ${count}`}
              >
                {pct > 10 ? s.label : ''}
              </div>
            );
          })}
        </div>

        <div className="mb-2 text-[11px] text-muted-foreground">
          Consensus agreement: <span className="font-mono">{consensusText}</span>
        </div>

        <div className="flex flex-wrap gap-4">
          <DistGroup title="Urgency" dist={cl?.distribution?.urgency} />
          <DistGroup title="Category" dist={cl?.distribution?.category} />
          <DistGroup title="Routing" dist={cl?.distribution?.routing} />
          <DistGroup title="Confidence" dist={cl?.distribution?.confidence} />
        </div>
      </CardContent>
    </Card>
  );
}
