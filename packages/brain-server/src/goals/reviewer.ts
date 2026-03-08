/**
 * Goal Action Reviewer — evaluates whether a completed action achieved its goal.
 *
 * The reviewer is a Sonnet agent with a narrow job: compare the action's output
 * against the goal's description and success criteria, considering prior attempts.
 *
 * It returns a structured verdict that the brain interprets to drive state transitions.
 * The reviewer never sets any state itself.
 */

import type { Goal, GoalAction } from './types.js';

export interface ReviewVerdict {
  achieved: boolean;
  assessment: string;
  recommendation: string;
}

/**
 * Build the prompt for the reviewer agent.
 */
export function buildReviewPrompt(
  goal: Goal,
  currentAction: GoalAction,
  priorActions: GoalAction[],
): string {
  const successCriteria = goal.success_criteria
    ? `\n## Success Criteria\n${goal.success_criteria}`
    : '';

  const isAsymptotic = goal.level === 'asymptotic';

  const priorContext = priorActions.length > 0
    ? priorActions.map((a) => {
        const review = a.review_text ? `\n    Review: ${a.review_text}` : '';
        return `  - [${a.status}] ${a.description}\n    Outcome: ${a.outcome_text ?? 'no outcome recorded'}${review}`;
      }).join('\n')
    : 'No prior attempts.';

  return `You are reviewing whether a completed action achieved its goal.

## Goal
**Title:** ${goal.title}
**Description:** ${goal.description}
**Level:** ${goal.level} (priority ${goal.priority})${successCriteria}

## Prior Actions for This Goal
${priorContext}

## Current Action
**Description:** ${currentAction.description}
**Rationale:** ${currentAction.rationale ?? 'none provided'}
**Outcome:** ${currentAction.outcome_text ?? 'no outcome recorded'}

## Instructions
${isAsymptotic
    ? `This is an asymptotic goal, meaning it is never fully "achieved." Evaluate whether this action made meaningful progress toward the goal's intent. Set "achieved" to false (asymptotic goals are never achieved), but provide a thorough assessment of what was accomplished.`
    : `Evaluate whether this action, combined with any prior completed actions, has fully satisfied the goal described above. Consider the success criteria if provided, otherwise use the goal description as the benchmark.`
}

Be rigorous. Do not give credit for partial work unless the goal is genuinely met. If the action made progress but the goal is not fully satisfied, explain specifically what remains.

Respond ONLY with JSON, no markdown fences:
{
  "achieved": true or false,
  "assessment": "what was accomplished and whether it meets the goal",
  "recommendation": "if not achieved, specific guidance for the next attempt; if achieved, empty string"
}`;
}

/**
 * Parse the reviewer's output into a structured verdict.
 * Falls back to "not achieved" with the raw text as assessment if parsing fails.
 */
export function parseReviewVerdict(raw: string): ReviewVerdict {
  try {
    const trimmed = raw.trim();

    // Try direct parse
    try {
      const parsed = JSON.parse(trimmed);
      return validateVerdict(parsed);
    } catch { /* fall through */ }

    // Extract JSON from surrounding text
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start !== -1 && end > start) {
      const parsed = JSON.parse(trimmed.slice(start, end + 1));
      return validateVerdict(parsed);
    }

    throw new Error('No JSON object found');
  } catch {
    // Fallback: treat as not achieved with raw output as assessment
    return {
      achieved: false,
      assessment: `Review parsing failed. Raw output: ${raw.slice(0, 500)}`,
      recommendation: 'Review agent returned unparseable output. Retry review.',
    };
  }
}

function validateVerdict(parsed: unknown): ReviewVerdict {
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Not an object');
  }
  const obj = parsed as Record<string, unknown>;
  return {
    achieved: Boolean(obj.achieved),
    assessment: String(obj.assessment ?? ''),
    recommendation: String(obj.recommendation ?? ''),
  };
}
