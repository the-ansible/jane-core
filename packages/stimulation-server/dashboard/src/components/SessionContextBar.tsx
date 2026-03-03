import { useState, useEffect } from 'react';
import { apiUrl } from '@/lib/utils';
import type { SessionSummary, SessionAssembly } from '@/types';

function useSessionContext(sessionId: string) {
  const [summaries, setSummaries] = useState<SessionSummary[] | null>(null);
  const [assembly, setAssembly] = useState<SessionAssembly | null>(null);

  useEffect(() => {
    Promise.all([
      fetch(apiUrl(`/api/context/sessions/${sessionId}/summaries`)).then((r) => r.json()),
      fetch(apiUrl(`/api/context/sessions/${sessionId}/assembly`)).then((r) => r.json()),
    ])
      .then(([summaryData, assemblyData]) => {
        setSummaries(summaryData.summaries || []);
        setAssembly(assemblyData.assembly || null);
      })
      .catch(() => {
        setSummaries([]);
        setAssembly(null);
      });
  }, [sessionId]);

  return { summaries, assembly };
}

/** Determine the context status of a message at an absolute index.
 *  absIdx is relative to the in-memory messageCount (0 = oldest in memory).
 *  diskOffset = diskMessageCount - messageCount (how many messages are disk-only before memory starts).
 */
export function getMessageContextStatus(
  absIdx: number,
  messageCount: number,
  assembly: SessionAssembly | null,
  summaries: SessionSummary[] | null,
  diskOffset: number = 0
): 'disk' | 'excluded' | 'summarized' | 'raw' {
  // Negative absIdx means the message is only on disk (evicted from in-memory)
  if (diskOffset > 0 && absIdx < 0) return 'disk';

  if (!assembly) return 'raw';

  const excluded = Math.max(0, messageCount - assembly.total_msg_coverage);
  const rawStart = messageCount - assembly.raw_msg_count;

  if (absIdx < excluded) return 'excluded';
  if (absIdx >= rawStart) return 'raw';

  // Check if it falls within any summary chunk
  if (summaries) {
    for (const s of summaries) {
      if (absIdx >= s.msg_start_idx && absIdx <= s.msg_end_idx) return 'summarized';
    }
  }

  return 'summarized'; // Default for covered-but-not-yet-assigned range
}

interface SessionContextBarProps {
  sessionId: string;
  messageCount: number;
}

export function SessionContextBar({ sessionId, messageCount }: SessionContextBarProps) {
  const { summaries, assembly } = useSessionContext(sessionId);

  const total = messageCount;
  if (total === 0) return null;

  // No assembly yet — all in memory, no summarization
  if (!assembly) {
    return (
      <div style={{ position: 'relative', height: 22, borderRadius: 4, overflow: 'hidden', background: '#58a6ff' }}>
        <span
          style={{
            position: 'absolute',
            right: 8,
            top: '50%',
            transform: 'translateY(-50%)',
            fontSize: 11,
            color: 'white',
            fontWeight: 600,
            letterSpacing: '0.02em',
            textShadow: '0 1px 2px rgba(0,0,0,0.4)',
            pointerEvents: 'none',
          }}
        >
          {total}
        </span>
      </div>
    );
  }

  const excluded = Math.max(0, total - assembly.total_msg_coverage);
  const summarized = Math.max(0, assembly.total_msg_coverage - assembly.raw_msg_count);
  const raw = assembly.raw_msg_count;

  const excludedPct = (excluded / total) * 100;
  const summarizedPct = (summarized / total) * 100;
  const rawPct = (raw / total) * 100;

  const excludedTitle = `${excluded} message${excluded !== 1 ? 's' : ''} excluded from context (too old for budget)`;
  const summarizedTitle = `${summarized} message${summarized !== 1 ? 's' : ''} in ${assembly.summary_count} summary chunk${assembly.summary_count !== 1 ? 's' : ''} · ${Math.round(assembly.budget_utilization * 100)}% budget`;
  const rawTitle = `${raw} raw message${raw !== 1 ? 's' : ''} in memory · ${assembly.raw_tokens} tokens`;

  return (
    <div
      style={{
        position: 'relative',
        height: 22,
        borderRadius: 4,
        overflow: 'hidden',
        display: 'flex',
        gap: 0,
        background: '#1a1a2e', // fallback
      }}
    >
      {/* Excluded zone — far left, oldest messages not in context; fades from nothing on the left edge */}
      {excluded > 0 && (
        <div
          title={excludedTitle}
          style={{
            width: `${excludedPct}%`,
            background: 'linear-gradient(to right, rgba(100,100,100,0.05), rgba(100,100,100,0.45))',
            flexShrink: 0,
            cursor: 'help',
          }}
        />
      )}

      {/* Summarized zone */}
      {summarized > 0 && (
        <div
          title={summarizedTitle}
          style={{
            width: `${summarizedPct}%`,
            background: '#d29922',
            flexShrink: 0,
            cursor: 'help',
          }}
        />
      )}

      {/* Raw / in-memory zone — far right, newest messages */}
      {raw > 0 && (
        <div
          title={rawTitle}
          style={{
            width: `${rawPct}%`,
            background: '#58a6ff',
            flexShrink: 0,
            cursor: 'help',
          }}
        />
      )}

      {/* Summary chunk block overlays */}
      {summaries &&
        summaries.map((s, i) => {
          const leftPct = (s.msg_start_idx / total) * 100;
          const widthPct = ((s.msg_end_idx - s.msg_start_idx + 1) / total) * 100;
          const preview = s.summary.replace(/^\[summarization_failed\]\s*/i, '').slice(0, 300);

          return (
            <div
              key={i}
              title={`Chunk ${i + 1}: msgs ${s.msg_start_idx}–${s.msg_end_idx}\n${preview}…`}
              style={{
                position: 'absolute',
                left: `${leftPct}%`,
                width: `${Math.max(widthPct, 0.5)}%`,
                top: 2,
                bottom: 2,
                border: '1.5px solid rgba(255,255,255,0.35)',
                borderRadius: 3,
                pointerEvents: 'auto',
                cursor: 'help',
              }}
            />
          );
        })}

      {/* Message count label */}
      <span
        style={{
          position: 'absolute',
          right: 7,
          top: '50%',
          transform: 'translateY(-50%)',
          fontSize: 11,
          color: 'white',
          fontWeight: 600,
          letterSpacing: '0.02em',
          textShadow: '0 1px 2px rgba(0,0,0,0.5)',
          pointerEvents: 'none',
        }}
      >
        {total}
      </span>
    </div>
  );
}

const STATUS_META = {
  raw:        { color: '#58a6ff', label: 'in memory',    tag: 'mem' },
  summarized: { color: '#d29922', label: 'summarized',   tag: 'sum' },
  excluded:   { color: 'rgba(150,150,150,0.7)', label: 'falling off', tag: 'off' },
  disk:       { color: 'rgba(100,100,100,0.5)', label: 'disk only',   tag: 'dsk' },
} as const;

export { STATUS_META };

/** Small colored dot indicator for individual messages */
export function MessageContextDot({
  absIdx,
  messageCount,
  assembly,
  summaries,
  diskOffset,
}: {
  absIdx: number;
  messageCount: number;
  assembly: SessionAssembly | null;
  summaries: SessionSummary[] | null;
  diskOffset?: number;
}) {
  const status = getMessageContextStatus(absIdx, messageCount, assembly, summaries, diskOffset);
  const { color, label } = STATUS_META[status];

  return (
    <span
      title={label}
      style={{
        display: 'inline-block',
        width: 7,
        height: 7,
        borderRadius: '50%',
        background: color,
        marginRight: 5,
        flexShrink: 0,
        cursor: 'help',
        verticalAlign: 'middle',
      }}
    />
  );
}

export { useSessionContext };
