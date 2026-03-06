import { useState } from 'react';
import { useBrainData } from '@/hooks/use-brain-data';
import { Header } from '@/components/Header';
import { StatsRow } from '@/components/StatsRow';
import { LayersPanel } from '@/components/LayersPanel';
import { JobsPanel } from '@/components/JobsPanel';
import { GoalsPanel } from '@/components/GoalsPanel';
import { CyclesPanel } from '@/components/CyclesPanel';
import { ActionsPanel } from '@/components/ActionsPanel';
import { MemoryPanel } from '@/components/MemoryPanel';
import { apiUrl } from '@/lib/utils';

export default function App() {
  const {
    goals, cycles, cycleRunning, metrics, natsConnected, sseConnected,
    jobs, layers, monitors, memoryStats, consolidation, memories, refetch,
  } = useBrainData();
  const [triggering, setTriggering] = useState(false);

  async function handleTriggerCycle() {
    if (triggering || cycleRunning) return;
    setTriggering(true);
    try {
      await fetch(apiUrl('/api/goals/cycles/trigger'), { method: 'POST' });
      setTimeout(refetch, 2000);
    } catch {
      // ignore
    } finally {
      setTimeout(() => setTriggering(false), 2000);
    }
  }

  return (
    <div className="min-h-screen">
      <Header
        metrics={metrics}
        natsConnected={natsConnected}
        sseConnected={sseConnected}
        cycleRunning={cycleRunning}
        onTriggerCycle={handleTriggerCycle}
        triggering={triggering}
      />

      <div className="mx-auto max-w-[1400px] px-6 py-4">
        {/* Overview counters */}
        <div className="mb-2 text-[13px] font-semibold uppercase tracking-wide text-muted-foreground">
          Overview
        </div>
        <StatsRow goals={goals} cycles={cycles} cycleRunning={cycleRunning} metrics={metrics} />

        {/* Hierarchical layers */}
        {layers.length > 0 && (
          <div className="mt-4">
            <div className="mb-2 text-[13px] font-semibold uppercase tracking-wide text-muted-foreground">
              Layers
            </div>
            <LayersPanel layers={layers} monitors={monitors} />
          </div>
        )}

        {/* Agent jobs */}
        <div className="mt-4">
          <JobsPanel jobs={jobs} />
        </div>

        {/* Goals */}
        <div className="mt-4">
          <GoalsPanel goals={goals} />
        </div>

        {/* Cycles + Actions */}
        <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
          <CyclesPanel cycles={cycles} cycleRunning={cycleRunning} />
          <ActionsPanel goals={goals} />
        </div>

        {/* Memory */}
        <div className="mt-4">
          <MemoryPanel memoryStats={memoryStats} consolidation={consolidation} memories={memories} />
        </div>
      </div>
    </div>
  );
}
