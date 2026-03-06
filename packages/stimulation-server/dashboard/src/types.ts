export interface Metrics {
  uptimeSeconds: number;
  received: number;
  validated: number;
  classified: number;
  pipelineProcessed: number;
  errors: number;
  deduplicated: number;
  safety: {
    paused: boolean;
    rateLimits: Record<string, { current: number; limit: number; alertOnly?: boolean }>;
    circuitBreakers: Record<string, { state: string }>;
    memory?: { rssBytes: number; underPressure: boolean };
    llmLoop?: { blockedTypes: string[] };
  } | null;
  classification: {
    totalClassified: number;
    byTier: Record<string, number>;
    consensus?: { totalVotes: number; perfectAgreement: number; majorityAgreement: number; avgAgreement: number };
    distribution?: {
      urgency: Record<string, number>;
      category: Record<string, number>;
      routing: Record<string, number>;
      confidence: Record<string, number>;
    };
  } | null;
  pipeline: {
    total: number;
    responded: number;
    responseRate: number;
    latency?: {
      agent?: { p50: number; p95: number; p99: number };
      composer?: { p50: number; p95: number; p99: number };
      total?: { p50: number; p95: number; p99: number };
    };
    recentErrors?: string[];
  } | null;
  outboundQueue: {
    size: number;
    oldest?: string;
    messages?: Array<{
      subject: string;
      eventId: string;
      sessionId: string;
      queuedAt: string;
      attempts: number;
    }>;
  } | null;
  sessions: {
    active: number;
    totalMessages: number;
  } | null;
  pipelineRuns?: {
    active: PipelineRun[];
    activeCount: number;
  } | null;
  timeline?: TimelineBucket[];
}

export type PipelineRunStatus = 'running' | 'success' | 'failure';
export type PipelineStage = 'routing' | 'safety_check' | 'context_assembly' | 'agent' | 'composer' | 'publish';

export interface StageRecord {
  stage: PipelineStage;
  status: PipelineRunStatus;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  error?: string;
  detail?: string;
}

export interface PipelineRun {
  runId: string;
  sessionId: string;
  channelType: string;
  senderName: string;
  contentPreview: string;
  status: PipelineRunStatus;
  currentStage: PipelineStage | null;
  stages: StageRecord[];
  startedAt: string;
  completedAt?: string;
  totalMs?: number;
  error?: string;
  routeAction?: string;
  classification?: string;
  agentOutput?: string;
  composerOutput?: string;
  recoveredJobId?: string;
  /** Set when this run was attached to an alive wrapper process after server restart */
  attachedJobId?: string;
}

export interface RecoveryJobEntry {
  jobId: string;
  sessionId: string;
  decision: 'alive' | 'agent_done' | 'requeue' | 'dead_letter';
  pid?: number | null;
}

export interface RecoveryReport {
  checkedAt: string;
  totalStale: number;
  alive: RecoveryJobEntry[];
  requeued: RecoveryJobEntry[];
  deadLettered: RecoveryJobEntry[];
}

export interface TimelineBucket {
  startMs: number;
  total: number;
  byChannel: Record<string, number>;
  byTier: Record<string, number>;
  byDirection: Record<string, number>;
  byUrgency: Record<string, number>;
  byCategory: Record<string, number>;
  byRouting: Record<string, number>;
  deduplicated: number;
  classified: number;
  errors: number;
}

export interface StoredEvent {
  event: {
    id: string;
    direction: string;
    channelType?: string;
    content?: string;
    sender?: { displayName?: string };
  };
  receivedAt: string;
  classification?: {
    urgency: string;
    category: string;
    routing: string;
    confidence: string;
    tier: string;
  };
}

export interface SessionInfo {
  sessionId: string;
  messageCount: number;
  createdAt: string;
  lastActivityAt: string;
}

export interface SessionMessage {
  role: string;
  content: string;
  timestamp: string;
  eventId?: string;
}

export interface SessionSummary {
  id: string;
  summary: string;
  topics: string[];
  entities: string[];
  msg_start_idx: number;
  msg_end_idx: number;
  msg_count: number;
  ts_start: string;
  ts_end: string;
  model: string;
  plan_name: string;
  created_at: string;
}

export interface SessionAssembly {
  id: string;
  session_id: string;
  event_id: string;
  plan_name: string;
  summary_count: number;
  raw_msg_count: number;
  total_msg_coverage: number;
  estimated_tokens: number;
  raw_tokens: number;
  summary_tokens: number;
  summary_budget: number;
  budget_utilization: number;
  raw_over_budget: boolean;
  assembly_ms: number;
  summarization_ms: number | null;
  pipeline_succeeded: boolean | null;
  assembled_at: string;
}
