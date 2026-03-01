import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import type { Metrics } from '@/types';

interface SafetyPanelProps {
  metrics: Metrics | null;
}

export function SafetyPanel({ metrics }: SafetyPanelProps) {
  const safety = metrics?.safety;
  const rl = safety?.rateLimits || {};
  const breakers = safety?.circuitBreakers || {};

  return (
    <Card>
      <CardHeader>
        <CardTitle>Safety Gate</CardTitle>
      </CardHeader>
      <CardContent>
        {/* Rate limits */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {Object.keys(rl).length > 0 ? (
            Object.entries(rl).map(([name, info]) => {
              const pct = info.limit > 0 ? Math.min((info.current / info.limit) * 100, 100) : 0;
              const color = pct > 90 ? 'bg-destructive' : pct > 70 ? 'bg-warning' : 'bg-primary';
              return (
                <div key={name} className="rounded-md border border-border bg-background p-2.5">
                  <div className="mb-1 text-[11px] uppercase text-muted-foreground">
                    {name}
                    {info.alertOnly && ' (alert)'}
                  </div>
                  <Progress value={info.current} max={info.limit} color={color} className="my-1" />
                  <div className="font-mono text-[11px] text-muted-foreground">
                    {info.current} / {info.limit}
                  </div>
                </div>
              );
            })
          ) : (
            <div className="text-xs text-muted-foreground">Waiting for data...</div>
          )}
        </div>

        {/* Circuit breakers */}
        <div className="mt-3">
          <div className="mb-1 text-[11px] text-muted-foreground">Circuit Breakers</div>
          <div className="flex flex-wrap gap-3 text-xs">
            {Object.keys(breakers).length > 0 ? (
              Object.entries(breakers).map(([name, info]) => {
                const dotColor =
                  info.state === 'closed'
                    ? 'bg-primary'
                    : info.state === 'open'
                      ? 'bg-destructive'
                      : 'bg-warning';
                return (
                  <span key={name} className="flex items-center gap-1.5">
                    <span className={`inline-block h-2 w-2 rounded-full ${dotColor}`} />
                    {name} ({info.state})
                  </span>
                );
              })
            ) : (
              <span className="text-muted-foreground">--</span>
            )}
          </div>
          {safety?.llmLoop?.blockedTypes && safety.llmLoop.blockedTypes.length > 0 && (
            <div className="mt-1 text-[11px] text-destructive">
              LLM loop blocked: {safety.llmLoop.blockedTypes.join(', ')}
            </div>
          )}
        </div>

        {/* Memory */}
        <div className="mt-3">
          <div className="mb-1 text-[11px] text-muted-foreground">Memory</div>
          {safety?.memory ? (
            <span
              className={`font-mono text-xs ${safety.memory.underPressure ? 'text-destructive' : 'text-primary'}`}
            >
              {(safety.memory.rssBytes / 1048576).toFixed(1)} MB
              {safety.memory.underPressure && ' (pressure!)'}
            </span>
          ) : (
            <span className="font-mono text-xs text-muted-foreground">--</span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
