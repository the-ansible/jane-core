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
  score: number | null;       // 0-10 from Ollama scoring
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

/** A candidate action from Ollama generation — not yet persisted */
export interface CandidateAction {
  goalId: string;
  goalTitle: string;
  description: string;
  rationale: string;
  score?: number;
}
