export type GoalLevel = 'asymptotic' | 'strategic' | 'tactical' | 'operational';
export type GoalStatus = 'active' | 'paused' | 'achieved' | 'abandoned';
export type ActionStatus = 'proposed' | 'selected' | 'executing' | 'done' | 'failed' | 'rejected';
export type CycleStatus = 'running' | 'done' | 'failed';

export interface Goal {
  id: string;
  title: string;
  description: string;
  motivation: string | null;
  level: GoalLevel;
  priority: number;
  status: GoalStatus;
  parent_id: string | null;
  success_criteria: string | null;
  progress_notes: string | null;
  last_evaluated_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface GoalAction {
  id: string;
  goal_id: string;
  cycle_id: string | null;
  description: string;
  rationale: string | null;
  status: ActionStatus;
  score: number | null;
  job_id: string | null;
  outcome_text: string | null;
  created_at: string;
  updated_at: string;
}

export interface GoalCycle {
  id: string;
  status: CycleStatus;
  goals_assessed: number;
  candidates_generated: number;
  action_selected_id: string | null;
  cycle_notes: string | null;
  started_at: string;
  completed_at: string | null;
}

export interface BrainMetrics {
  runningJobs: number;
  runningJobIds: string[];
  uptimeMs: number;
  ts: string;
}

export interface BrainSnapshot {
  goals: Goal[];
  cycles: GoalCycle[];
  cycleRunning: boolean;
  metrics: BrainMetrics | null;
  natsConnected: boolean;
}

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'dead_letter' | 'unresponsive';

export interface AgentJob {
  id: string;
  job_type: string;
  status: JobStatus;
  prompt: string;
  context_json: Record<string, unknown>;
  pid: number | null;
  error_message: string | null;
  result_text: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  last_heartbeat_at: string | null;
  last_activity_at: string | null;
  retry_count: number;
}

export interface MonitorResult {
  name: string;
  status: 'ok' | 'warning' | 'critical';
  message: string;
  durationMs?: number;
}

export interface LayerStatus {
  layer: string;
  running: boolean;
  lastActivity: string | null;
  metadata: Record<string, unknown>;
}

export type MemoryType = 'episodic' | 'semantic' | 'procedural' | 'working';

export interface Memory {
  id: string;
  type: MemoryType;
  source: string;
  title: string;
  content: string;
  tags: string[];
  importance: number;
  metadata: Record<string, unknown>;
  created_at: string;
  last_accessed_at: string;
  access_count: number;
  expires_at: string | null;
}

export interface MemoryStats {
  total: number;
  ts: string;
}

export interface ConsolidationState {
  consolidating: boolean;
  lastRunAt: string | null;
  result: {
    stored: number;
    errors: number;
    durationMs: number;
    error?: string;
  } | null;
}
