/**
 * Goal Scoring Metrics — append-only NDJSON log.
 *
 * Emits one JSON line per scoring run to logs/goal-scoring-metrics.json.
 * The log records all candidate scores so scoring behavior can be analyzed
 * and the engine refined over time.
 *
 * File location: resolved relative to the compiled file so it works in both
 * development (src/) and production (dist/) without __dirname hacks.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { CandidateAction } from './types.js';

// Resolve logs/ relative to this compiled file.
// In production: dist/goals/metrics.js → ../../logs/ = <app-root>/logs/
// In dev tests:  src/goals/metrics.ts  → ../../logs/ = packages/brain-server/src/logs/ (fine for tests)
const LOGS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'logs');
const METRICS_FILE = path.join(LOGS_DIR, 'goal-scoring-metrics.json');

export interface ScoringMetricsEntry {
  ts: string;
  cycleId: string;
  candidateCount: number;
  selectedGoalId: string | null;
  candidates: Array<{
    goalId: string;
    goalTitle: string;
    description: string;
    score: number;
    selected: boolean;
    breakdown: {
      relevance: number;
      impact: number;
      urgency: number;
      novelty: number;
      feasibility: number;
    } | null;
  }>;
}

/**
 * Append a scoring metrics entry to the NDJSON log file.
 * One JSON object per line — easy to tail, grep, or parse programmatically.
 *
 * Errors are swallowed and logged to stderr so they never interrupt the goal cycle.
 */
export function emitScoringMetrics(
  cycleId: string,
  scored: CandidateAction[],
  selected: CandidateAction | null,
): void {
  try {
    ensureLogsDir();

    const entry: ScoringMetricsEntry = {
      ts: new Date().toISOString(),
      cycleId,
      candidateCount: scored.length,
      selectedGoalId: selected?.goalId ?? null,
      candidates: scored.map((c) => ({
        goalId: c.goalId,
        goalTitle: c.goalTitle,
        description: c.description.slice(0, 200),
        score: c.score ?? 0,
        selected: c === selected,
        breakdown: c.scoreBreakdown
          ? {
              relevance:   c.scoreBreakdown.relevance,
              impact:      c.scoreBreakdown.impact,
              urgency:     c.scoreBreakdown.urgency,
              novelty:     c.scoreBreakdown.novelty,
              feasibility: c.scoreBreakdown.feasibility,
            }
          : null,
      })),
    };

    fs.appendFileSync(METRICS_FILE, JSON.stringify(entry) + '\n', 'utf8');
  } catch (err) {
    // Never let metrics logging break the goal cycle
    console.error(JSON.stringify({
      level: 'warn',
      msg: 'Failed to write scoring metrics',
      component: 'goal-metrics',
      error: String(err),
      ts: new Date().toISOString(),
    }));
  }
}

function ensureLogsDir(): void {
  if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
  }
}
