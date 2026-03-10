/**
 * Candidate generation and scoring for the Goal Engine.
 *
 * - Generation: given goals + context, produce actionable next steps
 * - Scoring: rate each candidate against the full goal set
 * - Selection: pick the highest-scoring candidate; break ties by goal priority
 */

import { invokeAdapter } from '../executor/index.js';
import type { Goal, CandidateAction, ScoreBreakdown } from './types.js';
import { computeCompositeScore } from './types.js';

// Candidates within this score band are considered tied; goal priority breaks the tie.
const TIE_THRESHOLD = 0.5;

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
 * Score each candidate using multi-dimensional rubric against the full goal set.
 *
 * Each candidate is scored on five dimensions (1-10 each):
 *   relevance   (35%) — how directly does this advance the goal?
 *   impact      (25%) — expected magnitude of improvement?
 *   urgency     (20%) — how time-sensitive / critical right now?
 *   novelty     (10%) — how different is this from recent completed work?
 *   feasibility (10%) — achievable in a single session?
 *
 * The composite score is computed as a weighted average and stored on .score.
 * The breakdown is stored on .scoreBreakdown.
 * Returns candidates sorted descending by composite score.
 * Falls back to flat score=5 if LLM scoring fails.
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
    ? `\n## Recent Action History (assign novelty=1 for near-duplicates)\n${context}\n`
    : '';

  const prompt = `You are evaluating candidate actions for an AI assistant named Jane.

## Jane's Goals (higher priority = more important)
${goalSummary}
${recentActionsSection}
## Candidates to Score
${candidateList}

Score each candidate on FIVE dimensions, each 1-10:
- relevance:   How directly does this advance the stated goal? (10 = perfectly aligned, 1 = tangential)
- impact:      How much improvement will this produce? (10 = major breakthrough, 1 = trivial)
- urgency:     How time-sensitive / critical is this right now? (10 = must do now, 1 = can wait indefinitely)
- novelty:     How different is this from recent completed work above? (10 = entirely new direction, 1 = near-duplicate of recent work)
- feasibility: How achievable is this in a single work session? (10 = clearly doable, 1 = highly uncertain/risky)

Weights: relevance=35%, impact=25%, urgency=20%, novelty=10%, feasibility=10%.

Respond ONLY with a JSON array, one object per candidate, in the same order:
[{"relevance":N,"impact":N,"urgency":N,"novelty":N,"feasibility":N}, ...]`;

  try {
    const raw = await claudeGenerate(prompt);
    const parsed = extractJson(raw);
    if (!Array.isArray(parsed)) return applyDefaultScores(candidates);

    candidates.forEach((c, i) => {
      const entry = parsed[i];
      if (entry && typeof entry === 'object') {
        const breakdown: ScoreBreakdown = {
          relevance:   clamp(parseFloat(String(entry.relevance   ?? 5))),
          impact:      clamp(parseFloat(String(entry.impact      ?? 5))),
          urgency:     clamp(parseFloat(String(entry.urgency     ?? 5))),
          novelty:     clamp(parseFloat(String(entry.novelty     ?? 5))),
          feasibility: clamp(parseFloat(String(entry.feasibility ?? 5))),
        };
        c.scoreBreakdown = breakdown;
        c.score = Math.round(computeCompositeScore(breakdown) * 10) / 10;
      } else {
        c.score = 5;
      }
    });

    return [...candidates].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  } catch (err) {
    log('warn', 'Candidate scoring failed', { error: String(err) });
    return applyDefaultScores(candidates);
  }
}

/**
 * Select the best candidate from a scored, sorted array.
 *
 * Candidates within TIE_THRESHOLD score points of the leader are considered
 * tied. Within a tie group, the candidate targeting the highest-priority goal
 * wins. Falls back to the raw sort order when priorities are equal.
 *
 * @param scored - Candidates sorted descending by composite score (output of scoreCandidates)
 * @param goals  - Active goals (used to resolve goal priorities for tiebreaking)
 */
export function selectBestCandidate(
  scored: CandidateAction[],
  goals: Goal[],
): CandidateAction | null {
  if (scored.length === 0) return null;

  const best = scored[0];
  const bestScore = best.score ?? 0;

  // Collect all candidates tied with the best
  const tied = scored.filter((c) => bestScore - (c.score ?? 0) <= TIE_THRESHOLD);
  if (tied.length === 1) return tied[0];

  // Break ties by goal priority (higher = more important)
  const priorityMap = new Map(goals.map((g) => [g.id, g.priority]));
  return tied.reduce((winner, c) => {
    const wPriority = priorityMap.get(winner.goalId) ?? 50;
    const cPriority = priorityMap.get(c.goalId) ?? 50;
    return cPriority > wPriority ? c : winner;
  }, tied[0]);
}

function clamp(n: number): number {
  return isNaN(n) ? 5 : Math.max(1, Math.min(10, n));
}

function applyDefaultScores(candidates: CandidateAction[]): CandidateAction[] {
  candidates.forEach((c) => { c.score = 5; });
  return candidates;
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
