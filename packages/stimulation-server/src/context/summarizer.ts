/**
 * Summarizer — Ollama-based conversation summarization with structured output.
 * Extracts summary text, topics, and entities from a chunk of messages.
 */

import type { SessionMessage } from '../sessions/store.js';
import type { ContextPlanConfig, SummaryRecord } from './types.js';
import { estimateTokens } from './tokens.js';
import { uuidv7 } from '@the-ansible/life-system-shared';

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://host.docker.internal:11434';
const SUMMARIZATION_TIMEOUT_MS = 10_000; // 10 seconds

const PROMPT_TEMPLATES: Record<string, string> = {
  default_v1: `Summarize this conversation segment concisely. Preserve:
- Key decisions made
- Important facts stated
- Questions asked and answers given
- Action items or commitments
- Emotional tone and relationship dynamics

Also extract:
- TOPICS: comma-separated list of topics discussed
- ENTITIES: comma-separated list of people, projects, systems mentioned

Conversation:
{messages}

Respond in this format:
SUMMARY: <your summary>
TOPICS: <topic1, topic2, ...>
ENTITIES: <entity1, entity2, ...>`,
};

function formatMessages(messages: SessionMessage[]): string {
  return messages
    .map((m) => `${m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Jane' : 'System'}: ${m.content}`)
    .join('\n');
}

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

export async function summarizeChunk(
  messages: SessionMessage[],
  plan: ContextPlanConfig,
  sessionId: string,
  msgStartIdx: number,
  msgEndIdx: number
): Promise<SummaryRecord> {
  const start = Date.now();
  const templateKey = plan.summaryPromptTemplate || 'default_v1';
  const template = PROMPT_TEMPLATES[templateKey] || PROMPT_TEMPLATES.default_v1;
  const formattedMessages = formatMessages(messages);
  const prompt = template.replace('{messages}', formattedMessages);

  let summary: string;
  let topics: string[];
  let entities: string[];

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SUMMARIZATION_TIMEOUT_MS);

    const response = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: plan.summaryModel || 'gemma3:12b',
        prompt,
        stream: false,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error(`Ollama returned ${response.status}`);
    }

    const data = (await response.json()) as { response: string };
    const parsed = parseStructuredResponse(data.response);
    summary = parsed.summary;
    topics = parsed.topics;
    entities = parsed.entities;
  } catch (err) {
    console.log(JSON.stringify({
      level: 'warn',
      msg: 'Summarization failed, using naive fallback',
      component: 'context.summarizer',
      error: String(err),
      sessionId,
      msgRange: `${msgStartIdx}-${msgEndIdx}`,
      ts: new Date().toISOString(),
    }));

    // Fallback: naive concatenation
    summary = `[summarization_failed] ${formattedMessages.slice(0, 500)}`;
    topics = [];
    entities = [];
  }

  const latencyMs = Date.now() - start;
  const tsStart = messages[0]?.timestamp || new Date().toISOString();
  const tsEnd = messages[messages.length - 1]?.timestamp || new Date().toISOString();

  return {
    id: uuidv7(),
    sessionId,
    summary,
    topics,
    entities,
    msgStartIdx,
    msgEndIdx,
    msgCount: messages.length,
    tsStart,
    tsEnd,
    model: plan.summaryModel || 'gemma3:12b',
    promptTokens: estimateTokens(prompt),
    outputTokens: estimateTokens(summary),
    latencyMs,
    planName: plan.summaryPromptTemplate || 'default_v1',
    createdAt: new Date().toISOString(),
  };
}
