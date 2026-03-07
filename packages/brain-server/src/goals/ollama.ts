/**
 * Claude launcher helpers for the Goal Engine.
 *
 * - Candidate generation: given goals + context, produce actionable next steps
 * - Scoring: rate each candidate against the full goal set
 *
 * Uses the shared claude-launcher instead of Ollama.
 */

import { launchClaude } from '@jane-core/claude-launcher';
import type { Goal, CandidateAction } from './types.js';

const CLAUDE_MODEL = process.env.GOAL_CLAUDE_MODEL || 'claude-sonnet-4-6';
const LAUNCH_TIMEOUT_MS = 120_000; // 2 min

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate 5-8 candidate actions across the provided goals.
 * Returns [] if Claude returns no parseable candidates or none match active goals.
 */
export async function generateCandidates(
  goals: Goal[],
  context: string
): Promise<CandidateAction[]> {
  const goalSummary = goals
    .map((g) => {
      const notes = g.progress_notes ? `\n  Recent progress: ${g.progress_notes.slice(0, 400)}` : '';
      return `[${g.level.toUpperCase()} P${g.priority}] ${g.title}: ${g.description}${notes}`;
    })
    .join('\n\n');

  const prompt = `You are Jane's strategic planning assistant. Based on Jane's current goals and context, generate 5-8 specific, actionable next steps Jane could take right now.

## Jane's Active Goals
${goalSummary}

## Current Context
${context}

## Instructions
Generate 5-8 concrete actions. Each action should:
- Be completable in a single work session (minutes to hours)
- Directly advance one or more of the listed goals
- Be specific enough that an AI agent can execute it without further clarification
- NOT duplicate work already described in the "Recent progress" notes above

Respond ONLY with a JSON array, no markdown, no explanation:
[
  {
    "goalTitle": "exact title of the primary goal this advances",
    "description": "specific action to take",
    "rationale": "why this action advances the goal"
  }
]`;

  try {
    const raw = await claudeGenerate(prompt);
    const parsed = extractJson(raw);
    if (!Array.isArray(parsed)) return [];

    return parsed.flatMap((item): CandidateAction[] => {
      const titleLower = String(item.goalTitle ?? '').toLowerCase();
      // Exact match first, then case-insensitive, then substring
      const goal = goals.find((g) => g.title === item.goalTitle)
        ?? goals.find((g) => g.title.toLowerCase() === titleLower)
        ?? goals.find((g) => g.title.toLowerCase().includes(titleLower) || titleLower.includes(g.title.toLowerCase()));
      if (!goal || !item.description) return [];
      return [{
        goalId: goal.id,
        goalTitle: goal.title,
        description: String(item.description),
        rationale: String(item.rationale ?? ''),
      }];
    });
  } catch (err) {
    log('warn', 'Candidate generation failed', { error: String(err) });
    return [];
  }
}

/**
 * Score each candidate 1-10 against the full goal set.
 * Mutates candidates in-place with a .score, returns sorted desc.
 * Pass context (from buildContext) to penalize already-completed work.
 */
export async function scoreCandidates(
  candidates: CandidateAction[],
  goals: Goal[],
  context?: string
): Promise<CandidateAction[]> {
  if (candidates.length === 0) return [];

  const goalSummary = goals
    .map((g) => `[${g.level} P${g.priority}] ${g.title}`)
    .join('\n');

  const candidateList = candidates
    .map((c, i) => `${i}: ${c.description} (for goal: ${c.goalTitle})`)
    .join('\n');

  const recentActionsSection = context
    ? `\n## Recent Action History (penalize duplicates heavily)\n${context}\n`
    : '';

  const prompt = `You are scoring candidate actions for an AI assistant named Jane.

## Jane's Goals (higher priority = more important)
${goalSummary}
${recentActionsSection}
## Candidates to Score
${candidateList}

Score each candidate 1-10 where:
- 10 = directly advances a high-priority goal, high feasibility, concrete outcome
- 5  = moderate impact or indirect benefit
- 1  = low impact, tangential, or impractical
- 1  = ALSO assign 1 if this duplicates a recently completed or failed action above

Consider: goal alignment, priority weighting, feasibility, expected outcome clarity, and whether the action was already attempted recently.

Respond ONLY with a JSON array of scores in order, no markdown:
[score0, score1, score2, ...]`;

  try {
    const raw = await claudeGenerate(prompt);
    const scores = extractJson(raw);
    if (!Array.isArray(scores)) return candidates;

    candidates.forEach((c, i) => {
      const s = parseFloat(String(scores[i]));
      c.score = isNaN(s) ? 5 : Math.max(1, Math.min(10, s));
    });

    return [...candidates].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  } catch (err) {
    log('warn', 'Candidate scoring failed', { error: String(err) });
    // Return candidates with default score so cycle can still proceed
    candidates.forEach((c) => { c.score = 5; });
    return candidates;
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function claudeGenerate(prompt: string): Promise<string> {
  const result = await launchClaude({
    prompt,
    model: CLAUDE_MODEL,
    outputFormat: 'json',
    maxTurns: 1,
    timeout: LAUNCH_TIMEOUT_MS,
  });

  if (result.timedOut) throw new Error('Claude launcher timed out');
  if (result.exitCode !== 0) throw new Error(`Claude launcher exited with code ${result.exitCode}`);
  const text = result.resultText ?? result.stdout.trim();
  if (!text) throw new Error('Claude launcher returned empty response');
  return text;
}

function extractJson(text: string): unknown {
  // Try direct parse first (ideal case: Claude returned pure JSON)
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch { /* fall through to extraction */ }

  // Find the first [ or { and try to parse from there
  const start = text.search(/[\[{]/);
  if (start === -1) throw new Error('No JSON found in response');
  const startChar = text[start];
  const endChar = startChar === '[' ? ']' : '}';
  const end = text.lastIndexOf(endChar);
  if (end === -1) throw new Error('Unclosed JSON in response');
  return JSON.parse(text.slice(start, end + 1));
}

function log(level: string, msg: string, extra?: Record<string, unknown>): void {
  console.log(JSON.stringify({ level, msg, component: 'goal-ollama', ts: new Date().toISOString(), ...extra }));
}
