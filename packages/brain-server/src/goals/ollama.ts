/**
 * Ollama HTTP helpers for the Goal Engine.
 *
 * - Candidate generation: given goals + context, produce actionable next steps
 * - Scoring: rate each candidate against the full goal set
 *
 * Model: gemma3:12b (default). Falls back gracefully if Ollama unavailable.
 */

import type { Goal, CandidateAction } from './types.js';

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://host.docker.internal:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'gemma3:12b';
const FETCH_TIMEOUT_MS = 120_000; // 2 min — LLM can be slow

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate 5-8 candidate actions across the provided goals.
 * Returns [] if Ollama is unavailable.
 */
export async function generateCandidates(
  goals: Goal[],
  context: string
): Promise<CandidateAction[]> {
  const goalSummary = goals
    .map((g) => `[${g.level.toUpperCase()} P${g.priority}] ${g.title}: ${g.description}`)
    .join('\n');

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

Respond ONLY with a JSON array, no markdown, no explanation:
[
  {
    "goalTitle": "exact title of the primary goal this advances",
    "description": "specific action to take",
    "rationale": "why this action advances the goal"
  }
]`;

  try {
    const raw = await ollamaGenerate(prompt);
    const parsed = extractJson(raw);
    if (!Array.isArray(parsed)) return [];

    return parsed.flatMap((item): CandidateAction[] => {
      const goal = goals.find((g) => g.title === item.goalTitle);
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
 */
export async function scoreCandidates(
  candidates: CandidateAction[],
  goals: Goal[]
): Promise<CandidateAction[]> {
  if (candidates.length === 0) return [];

  const goalSummary = goals
    .map((g) => `[${g.level} P${g.priority}] ${g.title}`)
    .join('\n');

  const candidateList = candidates
    .map((c, i) => `${i}: ${c.description} (for goal: ${c.goalTitle})`)
    .join('\n');

  const prompt = `You are scoring candidate actions for an AI assistant named Jane.

## Jane's Goals (higher priority = more important)
${goalSummary}

## Candidates to Score
${candidateList}

Score each candidate 1-10 where:
- 10 = directly advances a high-priority goal, high feasibility, concrete outcome
- 5  = moderate impact or indirect benefit
- 1  = low impact, tangential, or impractical

Consider: goal alignment, priority weighting, feasibility, expected outcome clarity.

Respond ONLY with a JSON array of scores in order, no markdown:
[score0, score1, score2, ...]`;

  try {
    const raw = await ollamaGenerate(prompt);
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

async function ollamaGenerate(prompt: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt,
        stream: false,
        options: { temperature: 0.7, num_predict: 1024 },
      }),
      signal: controller.signal,
    });

    if (!res.ok) throw new Error(`Ollama HTTP ${res.status}: ${await res.text()}`);

    const data = await res.json() as { response?: string };
    if (!data.response) throw new Error('Ollama returned empty response');
    return data.response;
  } finally {
    clearTimeout(timer);
  }
}

function extractJson(text: string): unknown {
  // Find the first [ or { and try to parse from there
  const start = text.search(/[\[{]/);
  if (start === -1) throw new Error('No JSON found in response');
  const end = text.lastIndexOf(text[start] === '[' ? ']' : '}');
  if (end === -1) throw new Error('Unclosed JSON in response');
  return JSON.parse(text.slice(start, end + 1));
}

function log(level: string, msg: string, extra?: Record<string, unknown>): void {
  console.log(JSON.stringify({ level, msg, component: 'goal-ollama', ts: new Date().toISOString(), ...extra }));
}
