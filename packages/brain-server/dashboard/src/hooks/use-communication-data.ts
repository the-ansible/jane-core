import { useState, useEffect, useRef, useCallback } from 'react';
import { apiUrl } from '@/lib/utils';
import type { CommMetrics, CommEvent, CommSession, PipelineRun } from '@/types';

export function useCommunicationData() {
  const [metrics, setMetrics] = useState<CommMetrics | null>(null);
  const [metricsHistory, setMetricsHistory] = useState<CommMetrics[]>([]);
  const [events, setEvents] = useState<CommEvent[]>([]);
  const [sessions, setSessions] = useState<CommSession[]>([]);
  const [pipelineRuns, setPipelineRuns] = useState<PipelineRun[]>([]);
  const [sseConnected, setSseConnected] = useState(false);
  const sseRef = useRef(false);

  const fetchMetrics = useCallback(() => {
    fetch(apiUrl('/api/communication/metrics'))
      .then((r) => r.json())
      .then((d) => {
        setMetrics(d);
        setMetricsHistory((prev) => {
          const next = [...prev, d];
          return next.length > 60 ? next.slice(-60) : next;
        });
      })
      .catch(() => {});
  }, []);

  const fetchEvents = useCallback(() => {
    fetch(apiUrl('/api/communication/events/recent?limit=30'))
      .then((r) => r.json())
      .then((d) => { if (d.events) setEvents(d.events); })
      .catch(() => {});
  }, []);

  const fetchSessions = useCallback(() => {
    fetch(apiUrl('/api/communication/sessions'))
      .then((r) => r.json())
      .then((d) => { if (d.sessions) setSessions(d.sessions); })
      .catch(() => {});
  }, []);

  const fetchRuns = useCallback(() => {
    fetch(apiUrl('/api/communication/pipeline/runs?limit=20'))
      .then((r) => r.json())
      .then((d) => {
        const all = [...(d.active || []), ...(d.recent || [])];
        const byId = new Map<string, PipelineRun>();
        for (const r of all) byId.set(r.runId, r);
        setPipelineRuns(
          Array.from(byId.values()).sort(
            (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
          )
        );
      })
      .catch(() => {});
  }, []);

  // SSE connection for real-time events + pipeline run updates
  useEffect(() => {
    let es: EventSource | null = null;

    function connect() {
      es = new EventSource(apiUrl('/api/communication/events/stream'));

      es.addEventListener('event', (e) => {
        try {
          const ev = JSON.parse((e as MessageEvent).data);
          setEvents((prev) => {
            const next = [ev, ...prev];
            return next.length > 50 ? next.slice(0, 50) : next;
          });
        } catch {}
      });

      es.addEventListener('pipeline-run', (e) => {
        try {
          const run = JSON.parse((e as MessageEvent).data) as PipelineRun;
          setPipelineRuns((prev) => {
            const idx = prev.findIndex((r) => r.runId === run.runId);
            if (idx >= 0) {
              const next = [...prev];
              next[idx] = run;
              return next;
            }
            return [run, ...prev].slice(0, 30);
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
    return () => { es?.close(); };
  }, []);

  // Initial fetch + polling
  useEffect(() => {
    fetchMetrics();
    fetchEvents();
    fetchSessions();
    fetchRuns();

    const timer = setInterval(() => {
      fetchMetrics();
      fetchSessions();
      if (!sseRef.current) {
        fetchEvents();
        fetchRuns();
      }
    }, 5_000);

    return () => clearInterval(timer);
  }, [fetchMetrics, fetchEvents, fetchSessions, fetchRuns]);

  return {
    metrics,
    metricsHistory,
    events,
    sessions,
    pipelineRuns,
    sseConnected,
  };
}
