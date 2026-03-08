/**
 * Task extractor - analyzes Jane's composed reply to determine if a real task needs dispatching.
 *
 * Runs as a Mercury API call after composition. Catches cases where the agent's
 * raw intent didn't include a task field but Jane's reply commits to performing real work.
 *
 * Uses Mercury (instant reasoning) instead of Anthropic API to avoid per-token costs.
 *
 * Fire-and-forget: caller should not await. All errors are swallowed internally.
 */

import { readFileSync } from 'node:fs';
import { StringCodec } from 'nats';
import type { NatsClient } from '@jane-core/nats-client';

const sc = StringCodec();

const MERCURY_BASE_URL = 'https://api.inceptionlabs.ai/v1';
const MERCURY_MODEL = 'mercury-2';
const TIMEOUT_MS = 15_000;

export interface TaskExtractorInput {
  composedMessage: string;
  inboundMessage: string;
  senderName: string;
  sessionId: string;
  eventId: string;
}

interface TaskDecision {
  needed: boolean;
  description?: string;
  type?: 'task' | 'research' | 'maintenance';
}

function getMercuryApiKey(): string | undefined {
  if (process.env.MERCURY_API_KEY) return process.env.MERCURY_API_KEY;

  try {
    const environ = readFileSync('/proc/1/environ');
    const vars = environ.toString().split('\0');
    for (const v of vars) {
      if (v.startsWith('MERCURY_API_KEY=')) {
        const val = v.slice('MERCURY_API_KEY='.length);
        if (val) return val;
      }
    }
  } catch {
    // Not on Linux or no permission
  }

  return undefined;
}

function buildPrompt(input: TaskExtractorInput): string {
  return `You are a task extraction engine for Jane, a personal AI assistant.

Analyze this conversation turn to determine if Jane's reply commits to performing a real, actionable task requiring code changes, file edits, research, system work, or implementing something.

IMPORTANT: Only extract a task if Jane is actively committing to DO something concrete. Do NOT extract tasks for:
- Conversational replies (greetings, acknowledgments, casual chat)
- Explaining or discussing things without committing to action
- Vague future intentions without specific deliverables
- Asking clarifying questions

INBOUND MESSAGE from ${input.senderName}:
${input.inboundMessage}

JANE'S REPLY:
${input.composedMessage}

If Jane commits to performing a real task, respond with this JSON:
{"needed":true,"description":"<complete self-contained prompt for a Claude Code agent, with all file paths and context needed to execute without this conversation>","type":"task"}

task type options: "task" (code/file work), "research" (information gathering), "maintenance" (system upkeep)

If no task is needed, respond with:
{"needed":false}

Respond with ONLY the JSON. No other text.`;
}

async function callMercury(prompt: string): Promise<TaskDecision | null> {
  const apiKey = getMercuryApiKey();
  if (!apiKey) {
    log('warn', 'MERCURY_API_KEY not set, task extraction skipped');
    return null;
  }

  const response = await fetch(`${MERCURY_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MERCURY_MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 512,
      reasoning_effort: 'instant',
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    log('error', 'Mercury API error', { status: response.status, body: text.slice(0, 200) });
    return null;
  }

  const data = await response.json() as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  const text = data?.choices?.[0]?.message?.content?.trim();
  if (!text) return null;

  // Try direct parse, then fall back to extracting JSON from text
  const raw = text.startsWith('{') ? text : (text.match(/\{[\s\S]*\}/)?.[0] ?? '');
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as TaskDecision;
    if (typeof parsed.needed !== 'boolean') return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Extract a task from Jane's composed reply and dispatch to the brain server if needed.
 * Must be called fire-and-forget (no await). All errors are caught internally.
 */
export async function extractAndDispatchTask(
  input: TaskExtractorInput,
  nats: NatsClient
): Promise<void> {
  const start = Date.now();

  try {
    const prompt = buildPrompt(input);
    const decision = await callMercury(prompt);
    const latencyMs = Date.now() - start;

    if (!decision) {
      log('warn', 'Task extractor returned no decision', { latencyMs });
      return;
    }

    if (!decision.needed || !decision.description) {
      log('info', 'No task needed', { latencyMs });
      return;
    }

    const jobType = (['task', 'research', 'maintenance'].includes(decision.type ?? '')
      ? decision.type
      : 'task') as 'task' | 'research' | 'maintenance';

    const jobRequest = {
      type: jobType,
      prompt: decision.description,
      role: 'executor',
      runtime: { tool: 'claude-code', model: 'sonnet' },
      context: {
        triggeredBy: 'conversation',
        eventId: input.eventId,
        sessionId: input.sessionId,
        senderName: input.senderName,
        extractedFrom: 'mercury_task_extractor',
      },
    };

    // Use nc.publish() (plain NATS, not JetStream) to match brain-server's nats.subscribe()
    nats.nc.publish('agent.jobs.request', sc.encode(JSON.stringify(jobRequest)));

    log('info', 'Task dispatched via extractor', {
      jobType,
      latencyMs,
      descriptionPreview: decision.description.slice(0, 120),
    });
  } catch (err) {
    log('error', 'Task extractor failed', {
      error: String(err),
      latencyMs: Date.now() - start,
    });
  }
}

function log(level: string, msg: string, extra?: Record<string, unknown>): void {
  console.log(JSON.stringify({
    level,
    msg,
    component: 'task-extractor',
    ts: new Date().toISOString(),
    ...extra,
  }));
}
