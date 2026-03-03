/**
 * Context Assembler — builds a contiguous, gap-free context window.
 *
 * Raw messages from the summary boundary to now are always included (non-negotiable).
 * Summaries are prepended newest-first until the token budget is full.
 * If the raw section exceeds the threshold, eagerly summarize oldest chunks.
 */

import { uuidv7 } from '@the-ansible/life-system-shared';
import { db } from './db.js';
import { getActivePlan, resolvePlan } from './plans.js';
import { summarizeChunk } from './summarizer.js';
import { estimateTokens } from './tokens.js';
import { getSession, getMessagesSince } from '../sessions/store.js';
import type { SessionMessage } from '../sessions/store.js';
import type { AssembledContext, AssembledContextSummary, SummaryRecord, ContextPlanConfig } from './types.js';

// Per-session mutex to prevent duplicate summarizations
const sessionMutexes = new Map<string, Promise<void>>();

interface DbSummaryRow {
  id: string;
  session_id: string;
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
}

function formatTimeRange(tsStart: string, tsEnd: string): string {
  const start = new Date(tsStart);
  const end = new Date(tsEnd);
  const opts: Intl.DateTimeFormatOptions = {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/Los_Angeles',
  };
  const startStr = start.toLocaleString('en-US', opts);
  const endStr = end.toLocaleString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles' });
  return `${startStr} – ${endStr} Pacific`;
}

async function getSummariesForSession(sessionId: string): Promise<DbSummaryRow[]> {
  const { rows } = await db.query<DbSummaryRow>(
    `SELECT id, session_id, summary, topics, entities, msg_start_idx, msg_end_idx,
            msg_count, ts_start, ts_end, model, plan_name
     FROM context.summaries
     WHERE session_id = $1
     ORDER BY msg_end_idx DESC`,
    [sessionId]
  );
  return rows;
}

async function storeSummary(record: SummaryRecord): Promise<void> {
  await db.query(
    `INSERT INTO context.summaries
       (id, session_id, summary, topics, entities, msg_start_idx, msg_end_idx,
        msg_count, ts_start, ts_end, model, prompt_tokens, output_tokens, latency_ms, plan_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     ON CONFLICT (session_id, ts_end) DO NOTHING`,
    [
      record.id, record.sessionId, record.summary, record.topics, record.entities,
      record.msgStartIdx, record.msgEndIdx, record.msgCount,
      record.tsStart, record.tsEnd, record.model,
      record.promptTokens, record.outputTokens, record.latencyMs, record.planName,
    ]
  );
}

async function logAssembly(params: {
  sessionId: string;
  eventId?: string;
  planName: string;
  summaryCount: number;
  rawMsgCount: number;
  totalMsgCoverage: number;
  estimatedTokens: number;
  rawTokens: number;
  summaryTokens: number;
  summaryBudget: number;
  budgetUtilization: number;
  rawOverBudget: boolean;
  assemblyMs: number;
  summarizationMs: number | null;
}): Promise<string> {
  const id = uuidv7();
  await db.query(
    `INSERT INTO context.assembly_log
       (id, session_id, event_id, plan_name, summary_count, raw_msg_count,
        total_msg_coverage, estimated_tokens, raw_tokens, summary_tokens,
        summary_budget, budget_utilization, raw_over_budget, assembly_ms, summarization_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
    [
      id, params.sessionId, params.eventId || null, params.planName,
      params.summaryCount, params.rawMsgCount, params.totalMsgCoverage,
      params.estimatedTokens, params.rawTokens, params.summaryTokens,
      params.summaryBudget, params.budgetUtilization, params.rawOverBudget,
      params.assemblyMs, params.summarizationMs,
    ]
  );
  return id;
}

async function eagerSummarize(
  sessionId: string,
  allMessages: SessionMessage[],
  boundary: number,
  plan: ContextPlanConfig,
  planName: string
): Promise<{ newBoundary: number; newSummariesCreated: number; summarizationMs: number }> {
  const start = Date.now();
  let newSummariesCreated = 0;
  let currentBoundary = boundary;

  // Get raw messages from boundary+1 to end
  let rawCount = allMessages.length - (currentBoundary + 1);

  while (rawCount > plan.rawSummarizationThreshold) {
    const chunkStart = currentBoundary + 1;
    const chunkEnd = chunkStart + plan.summaryChunkSize - 1;

    if (chunkEnd >= allMessages.length) break;

    const chunk = allMessages.slice(chunkStart, chunkEnd + 1);
    if (chunk.length === 0) break;

    try {
      const record = await summarizeChunk(chunk, plan, sessionId, chunkStart, chunkEnd);
      record.planName = planName;
      await storeSummary(record);
      newSummariesCreated++;
      currentBoundary = chunkEnd;
      rawCount = allMessages.length - (currentBoundary + 1);
    } catch (err) {
      console.log(JSON.stringify({
        level: 'warn',
        msg: 'Eager summarization chunk failed, stopping',
        component: 'context.assembler',
        sessionId,
        error: String(err),
        ts: new Date().toISOString(),
      }));
      break;
    }
  }

  return {
    newBoundary: currentBoundary,
    newSummariesCreated,
    summarizationMs: Date.now() - start,
  };
}

export async function assembleContext(
  sessionId: string,
  component: 'agent' | 'composer',
  eventId?: string
): Promise<AssembledContext> {
  const assemblyStart = Date.now();

  // 1. Load active plan, resolve per-component overrides
  const { name: planName, config: basePlan } = await getActivePlan();
  const plan = resolvePlan(basePlan, component);

  // 2. Get all session messages
  const session = getSession(sessionId);
  const allMessages = session.messages;

  // 3. Find summary boundary from DB
  const existingSummaries = await getSummariesForSession(sessionId);
  let boundary = existingSummaries.length > 0
    ? Math.max(...existingSummaries.map((s) => s.msg_end_idx))
    : -1;

  // 4. Raw section = messages from boundary+1 to end
  let rawMessages = boundary + 1 < allMessages.length
    ? allMessages.slice(boundary + 1)
    : allMessages;

  // 5. Eager summarization if raw exceeds threshold
  let newSummariesCreated = 0;
  let summarizationMs: number | null = null;

  if (rawMessages.length > plan.rawSummarizationThreshold && allMessages.length > plan.summaryChunkSize) {
    // Per-session mutex: don't duplicate summarizations
    const existingMutex = sessionMutexes.get(sessionId);
    if (existingMutex) {
      // Another call is already summarizing; await it then re-read
      await existingMutex;
      const refreshedSummaries = await getSummariesForSession(sessionId);
      boundary = refreshedSummaries.length > 0
        ? Math.max(...refreshedSummaries.map((s) => s.msg_end_idx))
        : -1;
      rawMessages = boundary + 1 < allMessages.length
        ? allMessages.slice(boundary + 1)
        : allMessages;
    } else {
      // We're the first — run summarization under mutex
      const mutexPromise = (async () => {
        const result = await eagerSummarize(sessionId, allMessages, boundary, basePlan, planName);
        boundary = result.newBoundary;
        newSummariesCreated = result.newSummariesCreated;
        summarizationMs = result.summarizationMs;
        rawMessages = boundary + 1 < allMessages.length
          ? allMessages.slice(boundary + 1)
          : allMessages;
      })();

      sessionMutexes.set(sessionId, mutexPromise);
      try {
        await mutexPromise;
      } finally {
        sessionMutexes.delete(sessionId);
      }
    }
  }

  // 6. Prepend summaries newest-first until budget full
  const summaryBudget = Math.floor(plan.modelContextSize * plan.tokenBudgetPct);
  const rawTokens = estimateTokens(rawMessages.map((m) => `${m.role}: ${m.content}`).join('\n'));
  const rawOverBudget = rawTokens > summaryBudget;

  // Re-fetch summaries after potential eager summarization
  const finalSummaries = newSummariesCreated > 0
    ? await getSummariesForSession(sessionId)
    : existingSummaries;

  // Walk newest-first, collecting summaries within budget
  const collectedSummaries: AssembledContextSummary[] = [];
  let summaryTokens = 0;
  let summaryMessageCoverage = 0;
  let summariesIncluded = 0;

  for (const s of finalSummaries) {
    if (summariesIncluded >= plan.maxSummaries) break;
    const sTokens = estimateTokens(s.summary);
    if (summaryTokens + sTokens > summaryBudget) break;

    collectedSummaries.push({
      text: s.summary,
      topics: s.topics,
      timeRange: formatTimeRange(s.ts_start, s.ts_end),
      messageCount: s.msg_count,
    });
    summaryTokens += sTokens;
    summaryMessageCoverage += s.msg_count;
    summariesIncluded++;
  }

  // 7. Reverse to chronological order
  collectedSummaries.reverse();

  // 8. Log assembly
  const assemblyMs = Date.now() - assemblyStart;
  const totalMsgCoverage = summaryMessageCoverage + rawMessages.length;
  const estimatedTotalTokens = rawTokens + summaryTokens;
  const budgetUtilization = summaryBudget > 0 ? summaryTokens / summaryBudget : 0;

  const assemblyLogId = await logAssembly({
    sessionId,
    eventId,
    planName,
    summaryCount: summariesIncluded,
    rawMsgCount: rawMessages.length,
    totalMsgCoverage,
    estimatedTokens: estimatedTotalTokens,
    rawTokens,
    summaryTokens,
    summaryBudget,
    budgetUtilization,
    rawOverBudget,
    assemblyMs,
    summarizationMs,
  });

  if (rawOverBudget) {
    console.log(JSON.stringify({
      level: 'warn',
      msg: 'Raw messages exceed summary budget — consider lowering rawSummarizationThreshold',
      component: 'context.assembler',
      sessionId,
      rawTokens,
      summaryBudget,
      rawMessageCount: rawMessages.length,
      ts: new Date().toISOString(),
    }));
  }

  console.log(JSON.stringify({
    level: 'info',
    msg: 'Context assembled',
    component: 'context.assembler',
    sessionId,
    for: component,
    summaryCount: summariesIncluded,
    rawMsgCount: rawMessages.length,
    totalCoverage: totalMsgCoverage,
    estimatedTokens: estimatedTotalTokens,
    budgetUtilization: Math.round(budgetUtilization * 100) + '%',
    newSummaries: newSummariesCreated,
    assemblyMs,
    ts: new Date().toISOString(),
  }));

  // 9. Return
  return {
    summaries: collectedSummaries,
    recentMessages: rawMessages,
    meta: {
      assemblyLogId,
      planName,
      summaryCount: summariesIncluded,
      rawMessageCount: rawMessages.length,
      totalMessageCoverage: totalMsgCoverage,
      estimatedTokens: estimatedTotalTokens,
      rawTokens,
      summaryTokens,
      summaryBudget,
      budgetUtilization,
      rawOverBudget,
      assemblyMs,
      summarizationMs,
      newSummariesCreated,
    },
  };
}
