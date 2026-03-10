/**
 * Types for the Goal/Desire System — Phase 3b
 */

export type GoalLevel = 'asymptotic' | 'strategic' | 'tactical' | 'operational';
export type GoalStatus = 'active' | 'paused' | 'achieved' | 'abandoned';
export type ActionStatus = 'proposed' | 'selected' | 'executing' | 'reviewing' | 'done' | 'failed' | 'rejected';
export type CycleStatus = 'running' | 'done' | 'failed';

export interface Goal {
  id: string;
  title: string;
  description: string;
  motivation: string | null;
  level: GoalLevel;
  priority: number;           // 1-100, higher = more important
  status: GoalStatus;
  parent_id: string | null;
  success_criteria: string | null;
  progress_notes: string | null;
  last_evaluated_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface GoalAction {
  id: string;
  goal_id: string;
  cycle_id: string | null;
  description: string;
  rationale: string | null;
  status: ActionStatus;
  score: number | null;       // 0-10 from LLM scoring
  job_id: string | null;      // brain.agent_jobs FK if executed
  outcome_text: string | null;
  review_text: string | null;
  review_job_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface GoalCycle {
  id: string;
  status: CycleStatus;
  goals_assessed: number;
  candidates_generated: number;
  action_selected_id: string | null;
  cycle_notes: string | null;
  started_at: Date;
  completed_at: Date | null;
}

/**
 * Multi-dimensional score breakdown for a candidate action.
 * Each dimension is 1-10. The composite score is a weighted average:
 *   relevance * 0.35 + impact * 0.25 + urgency * 0.20 + novelty * 0.10 + feasibility * 0.10
 */
export interface ScoreBreakdown {
  /** How directly does this advance the goal? (1-10) */
  relevance: number;
  /** What is the expected magnitude of improvement? (1-10) */
  impact: number;
  /** How time-sensitive / critical is this right now? (1-10) */
  urgency: number;
  /** How different is this from recent work? (1-10; 1 = near-duplicate) */
  novelty: number;
  /** How achievable is this in a single session? (1-10) */
  feasibility: number;
}

/** A candidate action from LLM generation — not yet persisted */
export interface CandidateAction {
  goalId: string;
  goalTitle: string;
  description: string;
  rationale: string;
  score?: number;
  /** Structured score breakdown (filled in by scoreCandidates) */
  scoreBreakdown?: ScoreBreakdown;
  /** Whether this action requires an isolated session workspace (code changes, file edits) */
  needsWorkspace?: boolean;
  /** Project paths to checkout as git worktrees in the workspace */
  projectPaths?: string[];
}

/** Weights for each scoring dimension (must sum to 1.0) */
export const SCORE_WEIGHTS: Record<keyof ScoreBreakdown, number> = {
  relevance: 0.35,
  impact: 0.25,
  urgency: 0.20,
  novelty: 0.10,
  feasibility: 0.10,
};

/** Compute a single composite score from a breakdown using SCORE_WEIGHTS */
export function computeCompositeScore(b: ScoreBreakdown): number {
  return (
    b.relevance * SCORE_WEIGHTS.relevance +
    b.impact * SCORE_WEIGHTS.impact +
    b.urgency * SCORE_WEIGHTS.urgency +
    b.novelty * SCORE_WEIGHTS.novelty +
    b.feasibility * SCORE_WEIGHTS.feasibility
  );
}
