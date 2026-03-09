import { useState } from 'react';
import { useBrainData } from '@/hooks/use-brain-data';
import { useCommunicationData } from '@/hooks/use-communication-data';
import { Header } from '@/components/Header';
import type { DashboardTab } from '@/components/Header';
import { StatsRow } from '@/components/StatsRow';
import { LayersPanel } from '@/components/LayersPanel';
import { JobsPanel } from '@/components/JobsPanel';
import { GoalsPanel } from '@/components/GoalsPanel';
import { CyclesPanel } from '@/components/CyclesPanel';
import { ActionsPanel } from '@/components/ActionsPanel';
import { MemoryPanel } from '@/components/MemoryPanel';
import { CommCounterCards } from '@/components/comm/CommCounterCards';
import { CommPipelinePanel } from '@/components/comm/CommPipelinePanel';
import { CommSafetyPanel } from '@/components/comm/CommSafetyPanel';
import { CommRunsPanel } from '@/components/comm/CommRunsPanel';
import { CommEventsPanel } from '@/components/comm/CommEventsPanel';
import { CommSessionsPanel } from '@/components/comm/CommSessionsPanel';
import { CommTestSender } from '@/components/comm/CommTestSender';
import { apiUrl } from '@/lib/utils';

export default function App() {
  const {
    goals, cycles, cycleRunning, metrics, natsConnected, sseConnected,
    jobs, layers, monitors, memoryStats, consolidation, memories, refetch,
  } = useBrainData();
  const comm = useCommunicationData();
  const [triggering, setTriggering] = useState(false);
  const [activeTab, setActiveTab] = useState<DashboardTab>('autonomy');

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
        sseConnected={activeTab === 'autonomy' ? sseConnected : comm.sseConnected}
        cycleRunning={cycleRunning}
        onTriggerCycle={handleTriggerCycle}
        triggering={triggering}
        activeTab={activeTab}
        onTabChange={setActiveTab}
      />

      <div className="mx-auto max-w-[1400px] px-6 py-4">
        {activeTab === 'autonomy' ? (
          <>
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
          </>
        ) : (
          <>
            {/* Counter cards */}
            <div className="mb-2 text-[13px] font-semibold uppercase tracking-wide text-muted-foreground">
              Communication
            </div>
            <CommCounterCards metrics={comm.metrics} history={comm.metricsHistory} />

            {/* Pipeline + Safety */}
            <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
              <CommPipelinePanel metrics={comm.metrics} />
              <CommSafetyPanel metrics={comm.metrics} />
            </div>

            {/* Pipeline Runs */}
            <div className="mt-4">
              <CommRunsPanel runs={comm.pipelineRuns} />
            </div>

            {/* Events */}
            <div className="mt-4">
              <CommEventsPanel events={comm.events} />
            </div>

            {/* Sessions + Test Sender */}
            <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
              <CommSessionsPanel sessions={comm.sessions} />
              <CommTestSender />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
