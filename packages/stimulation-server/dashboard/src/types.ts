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
  } | null;
  sessions: {
    active: number;
    totalMessages: number;
  } | null;
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
