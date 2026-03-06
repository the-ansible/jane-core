import { useState, useMemo, useCallback } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import type { TimelineBucket } from '@/types';

type GroupBy = 'tier' | 'channel' | 'direction' | 'urgency' | 'category' | 'routing';
type TimeRange = 15 | 30 | 60;

const COLOR_MAPS: Record<GroupBy, Record<string, string>> = {
  tier: {
    rules: '#1f6feb',
    local_consensus: '#58a6ff',
    mercury: '#388bfd',
    claude_escalation: '#d29922',
    fallback: '#6e7681',
    unclassified: '#484f58',
  },
  direction: {
    inbound: '#58a6ff',
    outbound: '#d29922',
  },
  urgency: {
    immediate: '#f85149',
    normal: '#58a6ff',
    low: '#6e7681',
    ignore: '#484f58',
  },
  channel: {},
  category: {},
  routing: {},
};

const AUTO_COLORS = ['#58a6ff', '#d29922', '#1f6feb', '#f85149', '#6e7681', '#388bfd', '#484f58'];

function getColor(groupBy: GroupBy, key: string, idx: number): string {
  return COLOR_MAPS[groupBy]?.[key] ?? AUTO_COLORS[idx % AUTO_COLORS.length];
}

function dimensionKey(groupBy: GroupBy): keyof TimelineBucket {
  switch (groupBy) {
    case 'tier': return 'byTier';
    case 'channel': return 'byChannel';
    case 'direction': return 'byDirection';
    case 'urgency': return 'byUrgency';
    case 'category': return 'byCategory';
    case 'routing': return 'byRouting';
  }
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

interface TimelinePanelProps {
  timeline: TimelineBucket[] | null;
}

export function TimelinePanel({ timeline }: TimelinePanelProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [groupBy, setGroupBy] = useState<GroupBy>('tier');
  const [timeRange, setTimeRange] = useState<TimeRange>(30);
  const [showDedup, setShowDedup] = useState(true);
  const [showErrors, setShowErrors] = useState(true);
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null);

  const filteredBuckets = useMemo(() => {
    if (!timeline || timeline.length === 0) return [];
    const cutoff = Date.now() - timeRange * 60_000;
    return timeline.filter(b => b.startMs >= cutoff);
  }, [timeline, timeRange]);

  // Collect all keys across filtered buckets for legend
  const allKeys = useMemo(() => {
    const keys = new Set<string>();
    const dim = dimensionKey(groupBy);
    for (const b of filteredBuckets) {
      for (const k of Object.keys(b[dim] as Record<string, number>)) {
        keys.add(k);
      }
    }
    return Array.from(keys);
  }, [filteredBuckets, groupBy]);

  const maxCount = useMemo(() => {
    let max = 0;
    for (const b of filteredBuckets) {
      let count = b.classified;
      if (showDedup) count += b.deduplicated;
      if (count > max) max = count;
    }
    return Math.max(max, 1);
  }, [filteredBuckets, showDedup]);

  const totalClassified = useMemo(
    () => filteredBuckets.reduce((s, b) => s + b.classified, 0),
    [filteredBuckets]
  );
  const totalAll = useMemo(
    () => filteredBuckets.reduce((s, b) => s + b.total, 0),
    [filteredBuckets]
  );

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    setTooltipPos({ x: e.clientX, y: e.clientY });
  }, []);

  if (!timeline) return null;

  const numBuckets = filteredBuckets.length || 1;
  const svgW = 800;
  const svgH = 200;
  const padLeft = 40;
  const padBottom = 20;
  const padTop = 10;
  const chartW = svgW - padLeft - 4;
  const chartH = svgH - padBottom - padTop;
  const barW = Math.max(2, (chartW / numBuckets) - 1);
  const gap = 1;

  // Gridlines
  const gridLines = [];
  const steps = 4;
  for (let i = 0; i <= steps; i++) {
    const val = Math.round((maxCount / steps) * i);
    const y = padTop + chartH - (val / maxCount) * chartH;
    gridLines.push({ y, label: String(val) });
  }

  return (
    <Card>
      <CardHeader
        className="cursor-pointer select-none"
        onClick={() => setCollapsed(!collapsed)}
      >
        <CardTitle className="flex items-center gap-2">
          <span className="text-xs">{collapsed ? '\u25b6' : '\u25bc'}</span>
          Event Timeline
          <span className="ml-auto text-xs font-normal text-muted-foreground">
            {filteredBuckets.length} buckets
          </span>
        </CardTitle>
      </CardHeader>

      {!collapsed && (
        <CardContent>
          {/* Filter bar */}
          <div className="mb-3 flex flex-wrap items-center gap-3 text-xs">
            <label className="flex items-center gap-1">
              <span className="text-muted-foreground">Group:</span>
              <select
                className="rounded border border-border bg-background px-1.5 py-0.5 text-xs"
                value={groupBy}
                onChange={(e) => setGroupBy(e.target.value as GroupBy)}
              >
                <option value="tier">Tier</option>
                <option value="channel">Channel</option>
                <option value="direction">Direction</option>
                <option value="urgency">Urgency</option>
                <option value="category">Category</option>
                <option value="routing">Routing</option>
              </select>
            </label>

            <div className="flex gap-1">
              {([15, 30, 60] as TimeRange[]).map((r) => (
                <button
                  key={r}
                  className={`rounded px-2 py-0.5 ${
                    timeRange === r
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted text-muted-foreground hover:bg-muted/80'
                  }`}
                  onClick={() => setTimeRange(r)}
                >
                  {r}m
                </button>
              ))}
            </div>

            <label className="flex items-center gap-1 cursor-pointer">
              <input
                type="checkbox"
                checked={showDedup}
                onChange={(e) => setShowDedup(e.target.checked)}
                className="rounded"
              />
              <span className="text-muted-foreground">Dedup</span>
            </label>

            <label className="flex items-center gap-1 cursor-pointer">
              <input
                type="checkbox"
                checked={showErrors}
                onChange={(e) => setShowErrors(e.target.checked)}
                className="rounded"
              />
              <span className="text-muted-foreground">Errors</span>
            </label>
          </div>

          {/* SVG Histogram */}
          <div className="relative" onMouseMove={handleMouseMove}>
            <svg
              viewBox={`0 0 ${svgW} ${svgH}`}
              className="w-full"
              style={{ maxHeight: 250 }}
            >
              {/* Hatched pattern for dedup */}
              <defs>
                <pattern id="hatch" patternUnits="userSpaceOnUse" width="4" height="4">
                  <path d="M-1,1 l2,-2 M0,4 l4,-4 M3,5 l2,-2" stroke="#fff" strokeWidth="0.5" opacity="0.4" />
                </pattern>
              </defs>

              {/* Grid lines */}
              {gridLines.map((g, i) => (
                <g key={i}>
                  <line
                    x1={padLeft}
                    y1={g.y}
                    x2={svgW}
                    y2={g.y}
                    stroke="currentColor"
                    strokeOpacity={0.1}
                    strokeDasharray="2,2"
                  />
                  <text
                    x={padLeft - 4}
                    y={g.y + 3}
                    textAnchor="end"
                    className="fill-muted-foreground"
                    fontSize="9"
                  >
                    {g.label}
                  </text>
                </g>
              ))}

              {/* Bars */}
              {filteredBuckets.map((bucket, i) => {
                const x = padLeft + i * (barW + gap);
                const dim = bucket[dimensionKey(groupBy)] as Record<string, number>;
                const isHovered = hoveredIdx === i;

                // Stacked segments
                let yOffset = 0;
                const segments: { key: string; count: number; color: string; y: number; h: number }[] = [];

                for (let ki = 0; ki < allKeys.length; ki++) {
                  const k = allKeys[ki];
                  const count = dim[k] || 0;
                  if (count === 0) continue;
                  const h = (count / maxCount) * chartH;
                  segments.push({
                    key: k,
                    count,
                    color: getColor(groupBy, k, ki),
                    y: padTop + chartH - yOffset - h,
                    h,
                  });
                  yOffset += h;
                }

                // Dedup overlay
                let dedupH = 0;
                if (showDedup && bucket.deduplicated > 0) {
                  dedupH = (bucket.deduplicated / maxCount) * chartH;
                }

                // Time labels (every ~5th bucket)
                const showLabel = i % Math.max(1, Math.floor(numBuckets / 8)) === 0;

                return (
                  <g
                    key={bucket.startMs}
                    onMouseEnter={() => setHoveredIdx(i)}
                    onMouseLeave={() => setHoveredIdx(null)}
                    opacity={hoveredIdx !== null && !isHovered ? 0.5 : 1}
                  >
                    {/* Background hit area */}
                    <rect
                      x={x}
                      y={padTop}
                      width={barW}
                      height={chartH}
                      fill="transparent"
                    />

                    {/* Stacked segments */}
                    {segments.map((seg) => (
                      <rect
                        key={seg.key}
                        x={x}
                        y={seg.y}
                        width={barW}
                        height={Math.max(seg.h, 0.5)}
                        fill={seg.color}
                        rx={1}
                      />
                    ))}

                    {/* Dedup hatched overlay */}
                    {showDedup && dedupH > 0 && (
                      <rect
                        x={x}
                        y={padTop + chartH - yOffset - dedupH}
                        width={barW}
                        height={dedupH}
                        fill="url(#hatch)"
                        rx={1}
                      />
                    )}

                    {/* Error dot */}
                    {showErrors && bucket.errors > 0 && (
                      <circle
                        cx={x + barW / 2}
                        cy={padTop + 4}
                        r={Math.min(3, Math.max(1.5, bucket.errors))}
                        fill="#f85149"
                      />
                    )}

                    {/* Time label */}
                    {showLabel && (
                      <text
                        x={x + barW / 2}
                        y={svgH - 2}
                        textAnchor="middle"
                        className="fill-muted-foreground"
                        fontSize="8"
                      >
                        {formatTime(bucket.startMs)}
                      </text>
                    )}
                  </g>
                );
              })}
            </svg>

            {/* Hover tooltip */}
            {hoveredIdx !== null && tooltipPos && filteredBuckets[hoveredIdx] && (
              <div
                className="pointer-events-none fixed z-50 rounded border border-border bg-popover px-3 py-2 text-xs shadow-lg"
                style={{ left: tooltipPos.x + 12, top: tooltipPos.y - 10 }}
              >
                <BucketTooltip bucket={filteredBuckets[hoveredIdx]} groupBy={groupBy} allKeys={allKeys} />
              </div>
            )}
          </div>

          {/* Legend + summary */}
          <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
            {allKeys.map((k, i) => (
              <span key={k} className="flex items-center gap-1">
                <span
                  className="inline-block h-2.5 w-2.5 rounded-sm"
                  style={{ background: getColor(groupBy, k, i) }}
                />
                {k}
              </span>
            ))}
            {showDedup && (
              <span className="flex items-center gap-1 text-muted-foreground">
                <svg width="10" height="10">
                  <defs>
                    <pattern id="hatch-legend" patternUnits="userSpaceOnUse" width="4" height="4">
                      <path d="M-1,1 l2,-2 M0,4 l4,-4 M3,5 l2,-2" stroke="currentColor" strokeWidth="0.5" />
                    </pattern>
                  </defs>
                  <rect width="10" height="10" fill="url(#hatch-legend)" rx="1" />
                </svg>
                dedup
              </span>
            )}
            {showErrors && (
              <span className="flex items-center gap-1 text-muted-foreground">
                <span className="inline-block h-2 w-2 rounded-full" style={{ background: '#f85149' }} />
                errors
              </span>
            )}
            <span className="ml-auto text-muted-foreground">
              classified: <span className="font-mono text-primary">{totalClassified}</span>
              {' / '}
              total: <span className="font-mono text-primary">{totalAll}</span>
            </span>
          </div>
        </CardContent>
      )}
    </Card>
  );
}

function BucketTooltip({
  bucket,
  groupBy,
  allKeys,
}: {
  bucket: TimelineBucket;
  groupBy: GroupBy;
  allKeys: string[];
}) {
  const dim = bucket[dimensionKey(groupBy)] as Record<string, number>;
  return (
    <div>
      <div className="mb-1 font-semibold">{formatTime(bucket.startMs)}</div>
      {allKeys.map((k, i) => {
        const val = dim[k] || 0;
        if (val === 0) return null;
        return (
          <div key={k} className="flex items-center gap-2">
            <span
              className="inline-block h-2 w-2 rounded-sm"
              style={{ background: getColor(groupBy, k, i) }}
            />
            <span>{k}: <span className="font-mono">{val}</span></span>
          </div>
        );
      })}
      {bucket.deduplicated > 0 && (
        <div className="text-muted-foreground">dedup: {bucket.deduplicated}</div>
      )}
      {bucket.errors > 0 && (
        <div style={{ color: '#f85149' }}>errors: {bucket.errors}</div>
      )}
      <div className="mt-1 border-t border-border pt-1 text-muted-foreground">
        total: {bucket.total} / classified: {bucket.classified}
      </div>
    </div>
  );
}
