import { useState, useEffect, useRef, useCallback } from 'react';
import { apiUrl } from '@/lib/utils';
import type { Metrics, StoredEvent, SessionInfo } from '@/types';

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

  return { metrics, metricsHistory, events, sessions, natsConnected, sseConnected };
}
