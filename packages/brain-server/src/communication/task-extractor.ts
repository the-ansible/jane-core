/**
 * Task extractor -- analyzes Jane's composed reply to determine if a real task needs dispatching.
 * Runs as a Mercury API call after composition. Catches cases where the agent's
 * raw intent didn't include a task field but Jane's reply commits to performing work.
 *
 * Fire-and-forget: caller should not await. All errors are swallowed internally.
 * Since we're in the brain server, tasks are dispatched via launchAgent directly.
 */

import { readFileSync } from 'node:fs';
import { invokeAdapter } from '../executor/index.js';

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

/**
 * Extract a task from Jane's composed reply and dispatch if needed.
 * Uses invokeAdapter with Mercury directly (same process).
 * Must be called fire-and-forget (no await). All errors are caught internally.
 */
export async function extractAndDispatchTask(
  input: TaskExtractorInput,
  dispatchFn: (jobRequest: Record<string, unknown>) => void
): Promise<void> {
  const start = Date.now();

  try {
    const prompt = buildPrompt(input);
    const result = await invokeAdapter({
      runtime: 'mercury',
      model: 'mercury-2',
      prompt,
      maxTokens: 512,
      reasoningEffort: 'instant',
    });

    const latencyMs = Date.now() - start;

    if (!result.success || !result.resultText) {
      log('warn', 'Task extractor adapter returned no result', { latencyMs, error: result.error });
      return;
    }

    const text = result.resultText.trim();
    const raw = text.startsWith('{') ? text : (text.match(/\{[\s\S]*\}/)?.[0] ?? '');
    if (!raw) {
      log('warn', 'Task extractor returned no JSON', { latencyMs });
      return;
    }

    let decision: TaskDecision;
    try {
      decision = JSON.parse(raw) as TaskDecision;
      if (typeof decision.needed !== 'boolean') {
        log('warn', 'Task extractor returned invalid decision', { latencyMs });
        return;
      }
    } catch {
      log('warn', 'Task extractor JSON parse failed', { latencyMs });
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

    dispatchFn(jobRequest);

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
    component: 'comm.task-extractor',
    ts: new Date().toISOString(),
    ...extra,
  }));
}
