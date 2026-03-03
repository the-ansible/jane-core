import { useState, useEffect, useRef, useCallback } from 'react';
import { apiUrl } from '@/lib/utils';
import type { Metrics, StoredEvent, SessionInfo, PipelineRun, RecoveryReport } from '@/types';

const MAX_EVENTS = 50;
const MAX_HISTORY = 60; // 60 snapshots * 5s = 5 minutes

export type MetricsSnapshot = Pick<Metrics, 'received' | 'validated' | 'classified' | 'pipelineProcessed' | 'errors' | 'deduplicated'>;

export function useDashboardData() {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [metricsHistory, setMetricsHistory] = useState<MetricsSnapshot[]>([]);
  const [events, setEvents] = useState<StoredEvent[]>([]);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [natsConnected, setNatsConnected] = useState(false);
  const [sseConnected, setSseConnected] = useState(false);
  const [pipelineRuns, setPipelineRuns] = useState<PipelineRun[]>([]);
  const [recoveryReport, setRecoveryReport] = useState<RecoveryReport | null>(null);

  const sseRef = useRef(false);

  const handleMetrics = useCallback((data: Metrics) => {
    setMetrics(data);
    setMetricsHistory((prev) => {
      const snap: MetricsSnapshot = {
        received: data.received,
        validated: data.validated,
        classified: data.classified,
        pipelineProcessed: data.pipelineProcessed,
        errors: data.errors,
        deduplicated: data.deduplicated,
      };
      const next = [...prev, snap];
      return next.length > MAX_HISTORY ? next.slice(-MAX_HISTORY) : next;
    });
    // Sync active pipeline runs from metrics snapshot
    if (data.pipelineRuns?.active) {
      setPipelineRuns((prev) => {
        const activeIds = new Set(data.pipelineRuns!.active.map(r => r.runId));
        // Keep completed runs that haven't expired yet, replace active ones
        const completed = prev.filter(r => r.status !== 'running' && !activeIds.has(r.runId));
        return [...completed, ...data.pipelineRuns!.active];
      });
    }
  }, []);

  const fetchSessions = useCallback(() => {
    fetch(apiUrl('/api/sessions'))
      .then((r) => r.json())
      .then((data) => {
        if (data.sessions) {
          const sorted = [...data.sessions].sort(
            (a: SessionInfo, b: SessionInfo) =>
              new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime()
          );
          setSessions(sorted);
        }
      })
      .catch(() => {});
  }, []);

  const fetchHealth = useCallback(() => {
    fetch(apiUrl('/health'))
      .then((r) => r.json())
      .then((h) => setNatsConnected(h.nats?.connected ?? false))
      .catch(() => setNatsConnected(false));
  }, []);

  // SSE connection
  useEffect(() => {
    let es: EventSource | null = null;
    let metricsTimer: ReturnType<typeof setInterval>;
    let eventsTimer: ReturnType<typeof setInterval>;

    function connect() {
      es = new EventSource(apiUrl('/api/events/stream'));

      es.addEventListener('event', (e) => {
        try {
          const data = JSON.parse((e as MessageEvent).data) as StoredEvent;
          setEvents((prev) => {
            const next = [...prev, data];
            return next.length > MAX_EVENTS ? next.slice(-MAX_EVENTS) : next;
          });
        } catch {}
      });

      es.addEventListener('metrics', (e) => {
        try {
          const data = JSON.parse((e as MessageEvent).data) as Metrics;
          handleMetrics(data);
        } catch {}
      });

      es.addEventListener('recovery-status', (e) => {
        try {
          const report = JSON.parse((e as MessageEvent).data) as RecoveryReport;
          setRecoveryReport(report);
        } catch {}
      });

      es.addEventListener('pipeline-run', (e) => {
        try {
          const run = JSON.parse((e as MessageEvent).data) as PipelineRun;
          setPipelineRuns((prev) => {
            const idx = prev.findIndex(r => r.runId === run.runId);
            const next = idx >= 0
              ? [...prev.slice(0, idx), run, ...prev.slice(idx + 1)]
              : [...prev, run];
            // Auto-remove completed runs after 60s
            const cutoff = Date.now() - 60_000;
            return next.filter(r =>
              r.status === 'running' || !r.completedAt || new Date(r.completedAt).getTime() > cutoff
            );
          });
        } catch {}
      });

      es.onopen = () => {
        sseRef.current = true;
        setSseConnected(true);
      };

      es.onerror = () => {
        sseRef.current = false;
        setSseConnected(false);
        es?.close();
        setTimeout(connect, 5000);
      };
    }

    connect();

    // Fallback polling
    metricsTimer = setInterval(() => {
      if (sseRef.current) return;
      fetch(apiUrl('/metrics'))
        .then((r) => r.json())
        .then(handleMetrics)
        .catch(() => {});
    }, 5000);

    eventsTimer = setInterval(() => {
      if (sseRef.current) return;
      fetch(apiUrl('/api/events/recent?limit=20'))
        .then((r) => r.json())
        .then((data) => {
          if (!data.events) return;
          setEvents((prev) => {
            const existing = new Set(prev.map((e) => e.event.id));
            const newOnes = data.events.filter(
              (ev: StoredEvent) => !existing.has(ev.event.id)
            );
            if (newOnes.length === 0) return prev;
            const next = [...prev, ...newOnes];
            return next.length > MAX_EVENTS ? next.slice(-MAX_EVENTS) : next;
          });
        })
        .catch(() => {});
    }, 5000);

    // Initial fetch
    fetch(apiUrl('/metrics'))
      .then((r) => r.json())
      .then(handleMetrics)
      .catch(() => {});

    fetch(apiUrl('/api/recovery'))
      .then((r) => r.json())
      .then((data) => { if (data.recovery) setRecoveryReport(data.recovery); })
      .catch(() => {});

    // Load full pipeline run history (active + recent) on startup
    fetch(apiUrl('/api/pipeline/runs'))
      .then((r) => r.json())
      .then((data) => {
        const recent: PipelineRun[] = data.recent || [];
        const active: PipelineRun[] = data.active || [];
        if (recent.length === 0 && active.length === 0) return;
        setPipelineRuns((prev) => {
          const existingIds = new Set(prev.map(r => r.runId));
          // Deduplicate: active wins over recent for same runId
          const byId = new Map<string, PipelineRun>();
          for (const run of [...recent, ...active]) byId.set(run.runId, run);
          // Don't overwrite runs already tracked via SSE (they're more current)
          const newOnes = Array.from(byId.values()).filter(r => !existingIds.has(r.runId));
          if (newOnes.length === 0) return prev;
          return [...prev, ...newOnes];
        });
      })
      .catch(() => {});

    return () => {
      es?.close();
      clearInterval(metricsTimer);
      clearInterval(eventsTimer);
    };
  }, [handleMetrics]);

  // Periodic session + health polling
  useEffect(() => {
    fetchSessions();
    fetchHealth();
    const timer = setInterval(() => {
      fetchSessions();
      fetchHealth();
    }, 5000);
    return () => clearInterval(timer);
  }, [fetchSessions, fetchHealth]);

  return { metrics, metricsHistory, events, sessions, natsConnected, sseConnected, pipelineRuns, recoveryReport };
}
