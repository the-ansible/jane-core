/**
 * Candidate generation and scoring for the Goal Engine.
 *
 * - Generation: given goals + context, produce actionable next steps
 * - Scoring: rate each candidate against the full goal set
 *
 * Primary: Claude CLI via claude-launcher (subprocess).
 * Fallback: Mercury API (instant reasoning) when CLI subprocess fails.
 */

import { invokeAdapter } from '../executor/index.js';
import type { Goal, CandidateAction } from './types.js';

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

## CRITICAL RULE — Do Not Re-Propose Recent Work
The context above contains a "RECENT COMPLETED WORK" section listing actions completed in the last 24 hours with timestamps (e.g. "2.3h ago"). You MUST NOT propose any action that is substantially similar to work completed within the last 24 hours. Duplicating recent work wastes resources and money. If you are tempted to propose something that resembles a recent completed action, choose a different next step instead.

## Instructions
Generate 5-8 concrete actions. Each action should:
- Be completable in a single work session (minutes to hours)
- Directly advance one or more of the listed goals
- Be specific enough that an AI agent can execute it without further clarification
- NOT duplicate any action listed in the "RECENT COMPLETED WORK" section above (last 24 hours)
- NOT duplicate work already described in the "Recent progress" notes above

Respond ONLY with a JSON array, no markdown, no explanation:
[
  {
    "goalTitle": "exact title of the primary goal this advances",
    "description": "specific action to take",
    "rationale": "why this action advances the goal",
    "needsWorkspace": false,
    "projectPaths": []
  }
]

Set "needsWorkspace": true if this action involves code changes, file edits to source projects, or any work that should happen in an isolated git worktree. Set "projectPaths" to the project directories needing worktrees (e.g. ["/agent/projects/jane-core"]). For research, analysis, documentation-only, or system admin tasks, set both to false/[].`;

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
        needsWorkspace: item.needsWorkspace === true,
        projectPaths: Array.isArray(item.projectPaths) ? item.projectPaths.filter((p: unknown) => typeof p === 'string') : [],
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

/**
 * Generate LLM output for goal cycle use-cases (candidate generation, scoring).
 *
 * Uses invokeAdapter() to route through the executor's adapter registry:
 *   Primary:  Mercury (fast HTTP call, no subprocess overhead)
 *   Fallback: Ollama (local, free, acceptable for structured JSON output)
 *
 * This replaces the previous launchClaude subprocess + manual Mercury fallback
 * pattern. Both of those are now unified behind the executor's adapter system.
 */
async function claudeGenerate(prompt: string): Promise<string> {
  // Primary: Mercury — fast HTTP call, no subprocess, consistent reliability
  try {
    const result = await invokeAdapter({
      runtime: 'mercury',
      model: 'mercury-2',
      prompt,
      maxTokens: 4096,
    });
    if (result.success && result.resultText) return result.resultText;
    throw new Error(result.error ?? 'Mercury returned no result');
  } catch (primaryErr) {
    log('warn', 'Mercury failed — falling back to Ollama', { error: String(primaryErr) });
  }

  // Fallback: Ollama — local, free, no external dependency
  const result = await invokeAdapter({
    runtime: 'ollama',
    model: 'gemma3:12b',
    prompt,
  });
  if (result.success && result.resultText) return result.resultText;
  throw new Error(`Both Mercury and Ollama failed: ${result.error ?? 'unknown'}`);
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
  console.log(JSON.stringify({ level, msg, component: 'goal-candidates', ts: new Date().toISOString(), ...extra }));
}
