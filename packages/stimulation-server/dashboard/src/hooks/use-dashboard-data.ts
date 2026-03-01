import { useState, useEffect, useRef, useCallback } from 'react';
import { apiUrl } from '@/lib/utils';
import type { Metrics, StoredEvent, SessionInfo } from '@/types';

const MAX_EVENTS = 50;

export function useDashboardData() {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [events, setEvents] = useState<StoredEvent[]>([]);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [natsConnected, setNatsConnected] = useState(false);
  const [sseConnected, setSseConnected] = useState(false);

  const sseRef = useRef(false);

  const fetchSessions = useCallback(() => {
    fetch(apiUrl('/api/sessions'))
      .then((r) => r.json())
      .then((data) => {
        if (data.sessions) setSessions(data.sessions);
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
          setMetrics(data);
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
        .then(setMetrics)
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

    // Initial fetches
    fetch(apiUrl('/metrics'))
      .then((r) => r.json())
      .then(setMetrics)
      .catch(() => {});

    return () => {
      es?.close();
      clearInterval(metricsTimer);
      clearInterval(eventsTimer);
    };
  }, []);

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

  return { metrics, events, sessions, natsConnected, sseConnected };
}
