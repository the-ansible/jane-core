/**
 * Conversation context module — session message history with continuous compaction.
 *
 * Provides gap-free coverage of a session's message history:
 * - Raw messages from the most recent boundary are always included verbatim
 * - Older messages are summarized into compressed chunks
 * - Summaries are collected newest-first within token budget
 *
 * This module reads from the context.summaries table and session JSONL files.
 * It does NOT perform eager summarization (that's the compactor's job).
 * It assembles what's available into a coherent context window.
 */

import { readFileSync, existsSync } from 'node:fs';
import pg from 'pg';
import type { ContextModule, ContextModuleParams, ContextFragment, ContextMessage } from '../types.js';
import { estimateTokens } from '../tokens.js';

const { Pool } = pg;

let pool: pg.Pool | null = null;
const SESSION_DIR = '/agent/data/sessions';

function getPool(): pg.Pool {
  if (pool) return pool;
  const connectionString = process.env.JANE_DATABASE_URL;
  if (!connectionString) throw new Error('JANE_DATABASE_URL is required');
  pool = new Pool({ connectionString });
  return pool;
}

interface DbSummaryRow {
  summary: string;
  topics: string[];
  msg_start_idx: number;
  msg_end_idx: number;
  msg_count: number;
  ts_start: string;
  ts_end: string;
}

function formatTimeRange(tsStart: string, tsEnd: string): string {
  const start = new Date(tsStart);
  const end = new Date(tsEnd);
  const opts: Intl.DateTimeFormatOptions = {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    timeZone: 'America/Los_Angeles',
  };
  const startStr = start.toLocaleString('en-US', opts);
  const endStr = end.toLocaleString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles' });
  return `${startStr} – ${endStr} Pacific`;
}

/**
 * Load messages from a session JSONL file.
 * Returns most recent messages (capped to avoid memory issues).
 */
function loadSessionMessages(sessionId: string, maxMessages = 100): ContextMessage[] {
  const filePath = `${SESSION_DIR}/${sessionId}.jsonl`;
  if (!existsSync(filePath)) return [];

  try {
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);

    const messages: ContextMessage[] = [];
    for (const line of lines.slice(-maxMessages)) {
      try {
        const parsed = JSON.parse(line);
        // Skip metadata lines (first line often has session metadata)
        if (parsed.role && parsed.content) {
          messages.push({
            role: parsed.role,
            content: parsed.content,
            timestamp: parsed.timestamp || parsed.ts || new Date().toISOString(),
            sender: parsed.sender,
          });
        }
      } catch {
        // Skip unparseable lines
      }
    }

    return messages;
  } catch {
    return [];
  }
}

const conversationModule: ContextModule = {
  name: 'conversation',

  async assemble(params: ContextModuleParams): Promise<ContextFragment | null> {
    if (!params.sessionId) return null;

    try {
      const plan = params.plan;

      // 1. Load session messages
      const allMessages = loadSessionMessages(params.sessionId);
      if (allMessages.length === 0) return null;

      // 2. Get existing summaries from DB
      const { rows: summaries } = await getPool().query<DbSummaryRow>(
        `SELECT summary, topics, msg_start_idx, msg_end_idx, msg_count, ts_start, ts_end
         FROM context.summaries
         WHERE session_id = $1
         ORDER BY msg_end_idx DESC`,
        [params.sessionId]
      );

      // 3. Find summary boundary
      const boundary = summaries.length > 0
        ? Math.max(...summaries.map(s => s.msg_end_idx))
        : -1;

      // 4. Raw section: everything after the boundary
      const rawMessages = boundary + 1 < allMessages.length
        ? allMessages.slice(boundary + 1)
        : allMessages;

      // 5. Collect summaries newest-first within budget
      const summaryBudget = plan.tokenBudget;
      const collectedSummaries: Array<{ text: string; topics: string[]; timeRange: string; messageCount: number }> = [];
      let summaryTokens = 0;
      let summariesIncluded = 0;

      for (const s of summaries) {
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
        summariesIncluded++;
      }

      // Reverse to chronological order
      collectedSummaries.reverse();

      // 6. Build text output
      const parts: string[] = ['CONVERSATION CONTEXT:'];

      if (collectedSummaries.length > 0) {
        parts.push('\n[Earlier conversation summaries]');
        for (const s of collectedSummaries) {
          parts.push(`--- Summary (${s.timeRange}, ${s.messageCount} messages) ---`);
          if (s.topics.length > 0) {
            parts.push(`Topics: ${s.topics.join(', ')}`);
          }
          parts.push(s.text);
          parts.push('');
        }
      }

      if (rawMessages.length > 0) {
        if (collectedSummaries.length > 0) {
          parts.push('[Recent messages]');
        }
        for (const msg of rawMessages) {
          const role = msg.role === 'user'
            ? (msg.sender?.displayName || 'User')
            : msg.role === 'assistant' ? 'Jane' : 'System';
          parts.push(`${role}: ${msg.content}`);
        }
      }

      const text = parts.join('\n');

      return {
        source: 'conversation',
        text,
        tokenEstimate: estimateTokens(text),
        meta: {
          summaryCount: summariesIncluded,
          rawMessageCount: rawMessages.length,
          totalCoverage: (summaries.reduce((sum, s) => sum + s.msg_count, 0)) + rawMessages.length,
          summaryTokens,
        },
      };
    } catch (err) {
      log('warn', 'Conversation module failed', { error: String(err), sessionId: params.sessionId });
      return null;
    }
  },
};

export default conversationModule;

function log(level: string, msg: string, extra?: Record<string, unknown>): void {
  console.log(JSON.stringify({ level, msg, component: 'context.conversation', ts: new Date().toISOString(), ...extra }));
}

export function _resetPool(): void { pool = null; }
