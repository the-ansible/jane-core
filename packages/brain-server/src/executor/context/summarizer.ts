/**
 * Shared summarization logic for the executor's context system.
 *
 * Provides generic summarization over text entries and ContextMessage arrays.
 * Used by:
 *   - communication/context/summarizer.ts (conversation compaction)
 *   - executor/goal-compaction.ts (goal session auto-compaction)
 *
 * Calls invokeAdapter directly — no HTTP round-trip, no job tracking.
 */

import type { ContextMessage } from '../types.js';
import { estimateTokens } from './tokens.js';
import { invokeAdapter } from '../index.js';

// ---------------------------------------------------------------------------
// Prompt templates
// ---------------------------------------------------------------------------

const PROMPT_TEMPLATES: Record<string, string> = {
  default_v1: `Summarize the following entries concisely. Preserve:
- Key decisions made
- Important facts stated
- Questions asked and answers given
- Action items or commitments
- Outcomes and results

Also extract:
- TOPICS: comma-separated list of topics discussed
- ENTITIES: comma-separated list of people, projects, systems mentioned

Entries:
{content}

Respond in this format:
SUMMARY: <your summary>
TOPICS: <topic1, topic2, ...>
ENTITIES: <entity1, entity2, ...>`,
};

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface SummarizationResult {
  summary: string;
  topics: string[];
  entities: string[];
  latencyMs: number;
  model: string;
  promptTokens: number;
  outputTokens: number;
}

export interface SummarizerOptions {
  /** Which LLM to use (default: haiku) */
  model?: string;
  /** Which prompt template to use (default: default_v1) */
  promptTemplate?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function parseStructuredResponse(response: string): {
  summary: string;
  topics: string[];
  entities: string[];
} {
  const summaryMatch = response.match(/SUMMARY:\s*([\s\S]*?)(?=\nTOPICS:|$)/i);
  const topicsMatch = response.match(/TOPICS:\s*(.*?)(?=\nENTITIES:|$)/i);
  const entitiesMatch = response.match(/ENTITIES:\s*(.*?)$/im);

  const summary = summaryMatch?.[1]?.trim() || response.trim();
  const topics = topicsMatch?.[1]
    ? topicsMatch[1].split(',').map((t) => t.trim()).filter(Boolean)
    : [];
  const entities = entitiesMatch?.[1]
    ? entitiesMatch[1].split(',').map((e) => e.trim()).filter(Boolean)
    : [];

  return { summary, topics, entities };
}

async function invokeWithFallback(
  prompt: string,
  model: string,
  context: string,
): Promise<{ summary: string; topics: string[]; entities: string[] }> {
  try {
    const result = await invokeAdapter({
      runtime: 'claude-code',
      model,
      prompt,
    });

    if (!result.success || !result.resultText) {
      throw new Error(`Adapter returned: ${result.error ?? 'no result'}`);
    }

    return parseStructuredResponse(result.resultText);
  } catch (err) {
    log('warn', 'Summarization failed, using naive fallback', {
      error: String(err),
      context,
    });
    return {
      summary: `[summarization_failed] ${prompt.slice(0, 500)}`,
      topics: [],
      entities: [],
    };
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Summarize an array of arbitrary text strings.
 * Used by goal compaction to condense multiple goal-action snapshots.
 */
export async function summarizeTexts(
  texts: string[],
  opts?: SummarizerOptions,
): Promise<SummarizationResult> {
  const start = Date.now();
  const model = opts?.model || 'haiku';
  const templateKey = opts?.promptTemplate || 'default_v1';
  const template = PROMPT_TEMPLATES[templateKey] || PROMPT_TEMPLATES.default_v1;

  const content = texts.map((t, i) => `[${i + 1}] ${t}`).join('\n\n---\n\n');
  const prompt = template.replace('{content}', content);

  const { summary, topics, entities } = await invokeWithFallback(prompt, model, `texts[${texts.length}]`);

  return {
    summary,
    topics,
    entities,
    latencyMs: Date.now() - start,
    model,
    promptTokens: estimateTokens(prompt),
    outputTokens: estimateTokens(summary),
  };
}

/**
 * Summarize an array of ContextMessage objects (conversation history).
 * Suitable for conversation compaction in the executor context system.
 */
export async function summarizeMessages(
  messages: ContextMessage[],
  opts?: SummarizerOptions & { sessionId?: string },
): Promise<SummarizationResult> {
  const start = Date.now();
  const model = opts?.model || 'haiku';
  const templateKey = opts?.promptTemplate || 'default_v1';
  const template = PROMPT_TEMPLATES[templateKey] || PROMPT_TEMPLATES.default_v1;

  const content = messages
    .map((m) => {
      const speaker = m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Jane' : 'System';
      return `${speaker}: ${m.content}`;
    })
    .join('\n');

  const prompt = template.replace('{content}', content);
  const context = opts?.sessionId ? `session:${opts.sessionId}` : `messages[${messages.length}]`;

  const { summary, topics, entities } = await invokeWithFallback(prompt, model, context);

  return {
    summary,
    topics,
    entities,
    latencyMs: Date.now() - start,
    model,
    promptTokens: estimateTokens(prompt),
    outputTokens: estimateTokens(summary),
  };
}

function log(level: string, msg: string, extra?: Record<string, unknown>): void {
  console.log(JSON.stringify({ level, msg, component: 'executor.summarizer', ts: new Date().toISOString(), ...extra }));
}
