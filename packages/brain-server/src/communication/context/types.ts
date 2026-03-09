/**
 * Types for the dynamic context system.
 */

import type { SessionMessage } from '../sessions/store.js';

export interface ContextPlanConfig {
  summaryChunkSize: number;
  summaryModel: string;
  summaryPromptTemplate: string;
  rawSummarizationThreshold: number;
  maxSummaries: number;
  modelContextSize: number;
  tokenBudgetPct: number;
  agent?: Partial<{
    maxSummaries: number;
    tokenBudgetPct: number;
  }>;
  composer?: Partial<{
    maxSummaries: number;
    tokenBudgetPct: number;
  }>;
  topicTrackingEnabled: boolean;
  associativeRetrievalEnabled: boolean;
}

export interface SummaryRecord {
  id: string;
  sessionId: string;
  summary: string;
  topics: string[];
  entities: string[];
  msgStartIdx: number;
  msgEndIdx: number;
  msgCount: number;
  tsStart: string;
  tsEnd: string;
  model: string;
  promptTokens: number | null;
  outputTokens: number | null;
  latencyMs: number | null;
  planName: string;
  createdAt: string;
}

export interface AssembledContextSummary {
  text: string;
  topics: string[];
  timeRange: string;
  messageCount: number;
}

export interface AssembledContextMeta {
  assemblyLogId: string;
  planName: string;
  summaryCount: number;
  rawMessageCount: number;
  totalMessageCoverage: number;
  estimatedTokens: number;
  rawTokens: number;
  summaryTokens: number;
  summaryBudget: number;
  budgetUtilization: number;
  rawOverBudget: boolean;
  assemblyMs: number;
  summarizationMs: number | null;
  newSummariesCreated: number;
}

export interface AssembledContext {
  summaries: AssembledContextSummary[];
  recentMessages: SessionMessage[];
  meta: AssembledContextMeta;
}
