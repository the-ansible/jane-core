/**
 * Shared types for the Brain Server job system.
 */

export type JobType = 'task' | 'research' | 'maintenance' | 'reflection' | 'review';
export type JobStatus =
  | 'queued'
  | 'running'
  | 'done'
  | 'failed'
  | 'dead_letter'
  | 'unresponsive'; // flagged but not killed

export interface AgentJob {
  id: string;
  job_type: JobType;
  status: JobStatus;
  prompt: string;
  context_json: Record<string, unknown>;
  session_id: string | null;
  pid: number | null;
  worktree_path: string | null;
  scratch_dir: string | null;
  output_file: string | null;
  result_text: string | null;
  nats_reply_subject: string | null;
  created_at: Date;
  updated_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
  last_heartbeat_at: Date | null;
  last_activity_at: Date | null;
  retry_count: number;
  error_message: string | null;
}

/** Payload received on `agent.jobs.request` */
export interface JobRequest {
  /** Optional client-supplied ID (used as NATS reply correlation) */
  clientId?: string;
  type: JobType;
  prompt: string;
  context?: Record<string, unknown>;
  /** NATS subject to publish results to when done */
  replySubject?: string;
  /** Working directory for the spawned agent (defaults to /agent) */
  workdir?: string;
  /** Project path for worktree isolation (if set, creates a git worktree) */
  projectPath?: string;
  /** Session this job belongs to (executor integration) */
  sessionId?: string;
  /** Role for the agent (executor integration) */
  role?: string;
  /** Runtime config override (executor integration) */
  runtime?: { tool: string; model: string; [key: string]: unknown };
}

/** Published on completion to the replySubject */
export interface JobResult {
  jobId: string;
  clientId?: string;
  status: 'done' | 'failed';
  result?: string;
  error?: string;
  durationMs: number;
  /** Path to the captured output log file */
  logPath?: string;
}

/** Published on `agent.jobs.alert.<jobId>` */
export interface JobAlert {
  jobId: string;
  alertType: 'unresponsive' | 'anomaly';
  message: string;
  lastActivityAt: string | null;
  pid: number | null;
}
