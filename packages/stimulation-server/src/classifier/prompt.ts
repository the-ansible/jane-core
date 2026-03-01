/**
 * Shared classification prompt builder.
 * Produces an enriched prompt from ClassificationContext for both Ollama and Claude tiers.
 */

import type { ClassificationContext } from './types.js';

export function buildClassificationPrompt(ctx: ClassificationContext): string {
  const parts: string[] = [];

  parts.push(`You are a message classifier for a personal assistant named Jane. Classify the following message into exactly three dimensions.

URGENCY (how soon does this need attention):
- "immediate" — needs response right now (emergencies, time-sensitive requests)
- "normal" — should be handled soon but not urgent (questions, task requests)
- "low" — can wait, no time pressure (FYI, social, informational)
- "ignore" — noise, empty, or not actionable

CATEGORY (what kind of message is this):
- "question" — asking for information or an answer
- "task_request" — asking to do something, perform an action
- "social" — greeting, thanks, small talk, emotional expression
- "alert" — system alert, error report, warning
- "informational" — sharing info, FYI, status update, link sharing

ROUTING (how should the assistant respond):
- "reflexive_reply" — quick, simple response (greetings, thanks, acknowledgments)
- "deliberate_thought" — needs reasoning, research, or complex action
- "log_only" — just record it, no response needed
- "escalate" — needs human attention or is beyond assistant capabilities`);

  // Channel type context
  parts.push(`\nCHANNEL: ${ctx.channelType}`);

  // Session state
  parts.push(`SESSION: ${ctx.sessionState === 'active_conversation' ? 'Active conversation (recent messages exchanged)' : 'Cold start (no recent activity)'}`);

  // Sender context
  if (ctx.sender) {
    const senderDesc = ctx.sender.displayName
      ? `${ctx.sender.displayName} (${ctx.sender.type})`
      : `${ctx.sender.id} (${ctx.sender.type})`;
    parts.push(`SENDER: ${senderDesc}`);
  }

  // Sender hints as suggestions (not mandates)
  if (ctx.hints) {
    const hintParts: string[] = [];
    if (ctx.hints.category) hintParts.push(`category="${ctx.hints.category}"`);
    if (ctx.hints.urgency) hintParts.push(`urgency="${ctx.hints.urgency}"`);
    if (ctx.hints.routing) hintParts.push(`routing="${ctx.hints.routing}"`);
    if (hintParts.length > 0) {
      parts.push(`SENDER HINTS (suggestions from the sender — consider but verify): ${hintParts.join(', ')}`);
    }
  }

  parts.push(`\nRespond with ONLY a JSON object, no other text:
{"urgency":"...","category":"...","routing":"..."}`);

  parts.push(`\nMESSAGE:\n${ctx.content}`);

  return parts.join('\n');
}
