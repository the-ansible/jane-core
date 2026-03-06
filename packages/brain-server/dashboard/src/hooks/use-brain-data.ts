import { useState, useEffect, useRef, useCallback } from 'react';
import { apiUrl } from '@/lib/utils';
import type { Goal, GoalCycle, BrainMetrics, AgentJob, LayerStatus, MonitorResult, Memory, MemoryStats, ConsolidationState } from '@/types';

export function useBrainData() {
  const [goals, setGoals] = useState<Goal[]>([]);
  const [cycles, setCycles] = useState<GoalCycle[]>([]);
  const [cycleRunning, setCycleRunning] = useState(false);
  const [metrics, setMetrics] = useState<BrainMetrics | null>(null);
  const [natsConnected, setNatsConnected] = useState(false);
  const [sseConnected, setSseConnected] = useState(false);
  const [jobs, setJobs] = useState<AgentJob[]>([]);
  const [layers, setLayers] = useState<LayerStatus[]>([]);
  const [monitors, setMonitors] = useState<MonitorResult[]>([]);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [memoryStats, setMemoryStats] = useState<MemoryStats | null>(null);
  const [consolidation, setConsolidation] = useState<ConsolidationState | null>(null);
  const sseRef = useRef(false);

  const fetchGoals = useCallback(() => {
    fetch(apiUrl('/api/goals'))
      .then((r) => r.json())
      .then((d) => { if (d.goals) setGoals(d.goals); })
      .catch(() => {});
  }, []);

  const fetchCycles = useCallback(() => {
    fetch(apiUrl('/api/goals/cycles?limit=20'))
      .then((r) => r.json())
      .then((d) => {
        if (d.cycles) setCycles(d.cycles);
        if (typeof d.cycleRunning === 'boolean') setCycleRunning(d.cycleRunning);
      })
      .catch(() => {});
  }, []);

  const fetchMetrics = useCallback(() => {
    fetch(apiUrl('/metrics'))
      .then((r) => r.json())
      .then((d) => setMetrics(d))
      .catch(() => {});
  }, []);

  const fetchHealth = useCallback(() => {
    fetch(apiUrl('/health'))
      .then((r) => r.json())
      .then((d) => setNatsConnected(d.natsConnected ?? false))
      .catch(() => setNatsConnected(false));
  }, []);

  const fetchJobs = useCallback(() => {
    fetch(apiUrl('/api/jobs?limit=30'))
      .then((r) => r.json())
      .then((d) => { if (d.jobs) setJobs(d.jobs); })
      .catch(() => {});
  }, []);

  const fetchLayers = useCallback(() => {
    fetch(apiUrl('/api/layers'))
      .then((r) => r.json())
      .then((d) => {
        if (d.layers) setLayers(d.layers);
        if (d.monitors) setMonitors(d.monitors);
      })
      .catch(() => {});
  }, []);

  const fetchMemories = useCallback(() => {
    fetch(apiUrl('/api/memories?limit=30'))
      .then((r) => r.json())
      .then((d) => { if (d.memories) setMemories(d.memories); })
      .catch(() => {});
  }, []);

  const fetchMemoryStats = useCallback(() => {
    fetch(apiUrl('/api/memories/stats'))
      .then((r) => r.json())
      .then((d) => setMemoryStats(d))
      .catch(() => {});
  }, []);

  const fetchConsolidation = useCallback(() => {
    fetch(apiUrl('/api/memories/consolidation'))
      .then((r) => r.json())
      .then((d) => setConsolidation(d))
      .catch(() => {});
  }, []);

  // SSE connection for real-time goal/cycle/metrics pushes
  useEffect(() => {
    let es: EventSource | null = null;
    let pollTimer: ReturnType<typeof setInterval>;

    function connect() {
      es = new EventSource(apiUrl('/api/events/stream'));

      es.addEventListener('snapshot', (e) => {
        try {
          const d = JSON.parse((e as MessageEvent).data);
          if (d.goals) setGoals(d.goals);
          if (d.cycles) setCycles(d.cycles);
          if (typeof d.cycleRunning === 'boolean') setCycleRunning(d.cycleRunning);
          if (d.metrics) setMetrics(d.metrics);
          if (typeof d.natsConnected === 'boolean') setNatsConnected(d.natsConnected);
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

    // Fallback polling when SSE is down
    pollTimer = setInterval(() => {
      if (sseRef.current) return;
      fetchGoals();
      fetchCycles();
      fetchMetrics();
      fetchHealth();
    }, 10_000);

    // Initial load
    fetchGoals();
    fetchCycles();
    fetchMetrics();
    fetchHealth();

    return () => {
      es?.close();
      clearInterval(pollTimer);
    };
  }, [fetchGoals, fetchCycles, fetchMetrics, fetchHealth]);

  // Jobs/Layers/Memory: polled separately (not in SSE snapshot)
  useEffect(() => {
    fetchJobs();
    fetchLayers();
    fetchMemories();
    fetchMemoryStats();
    fetchConsolidation();

    const timer = setInterval(() => {
      fetchJobs();
      fetchLayers();
      fetchMemories();
      fetchMemoryStats();
      fetchConsolidation();
    }, 15_000);

    return () => clearInterval(timer);
  }, [fetchJobs, fetchLayers, fetchMemories, fetchMemoryStats, fetchConsolidation]);

  // Periodic refresh even with SSE (goals/cycles don't push on every change)
  useEffect(() => {
    const timer = setInterval(() => {
      fetchGoals();
      fetchCycles();
      fetchMetrics();
      fetchHealth();
    }, 30_000);
    return () => clearInterval(timer);
  }, [fetchGoals, fetchCycles, fetchMetrics, fetchHealth]);

  return {
    goals,
    cycles,
    cycleRunning,
    metrics,
    natsConnected,
    sseConnected,
    jobs,
    layers,
    monitors,
    memories,
    memoryStats,
    consolidation,
    refetch: () => {
      fetchGoals();
      fetchCycles();
      fetchJobs();
      fetchLayers();
      fetchMemories();
    },
  };
}
