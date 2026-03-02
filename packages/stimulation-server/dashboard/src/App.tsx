import { useDashboardData } from '@/hooks/use-dashboard-data';
import { Header } from '@/components/Header';
import { CounterCards } from '@/components/CounterCards';
import { PipelinePanel } from '@/components/PipelinePanel';
import { ClassificationPanel } from '@/components/ClassificationPanel';
import { SafetyPanel } from '@/components/SafetyPanel';
import { OutboundQueuePanel } from '@/components/OutboundQueuePanel';
import { TestSender } from '@/components/TestSender';
import { EventsFeed } from '@/components/EventsFeed';
import { SessionsPanel } from '@/components/SessionsPanel';

export default function App() {
  const { metrics, events, sessions, natsConnected, sseConnected } = useDashboardData();

  return (
    <div className="min-h-screen">
      <Header metrics={metrics} natsConnected={natsConnected} sseConnected={sseConnected} />

      <div className="mx-auto max-w-[1400px] px-6 py-4">
        <div className="mb-2 text-[13px] font-semibold uppercase tracking-wide text-muted-foreground">
          Pipeline Counters
        </div>
        <CounterCards metrics={metrics} />

        <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
          <PipelinePanel metrics={metrics} />
          <ClassificationPanel metrics={metrics} />
          <SafetyPanel metrics={metrics} />
          <OutboundQueuePanel metrics={metrics} />
        </div>

        <div className="mt-4">
          <TestSender />
        </div>

        <div className="mt-4">
          <EventsFeed events={events} />
        </div>

        <div className="mt-4">
          <SessionsPanel sessions={sessions} />
        </div>
      </div>
    </div>
  );
}
