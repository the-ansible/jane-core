/**
 * Memory System Types
 *
 * Three memory types:
 *   episodic   — specific events that happened (goal cycles, job completions, conversations)
 *   semantic   — synthesized facts/knowledge distilled from episodes (by Ollama consolidator)
 *   procedural — how to do things: patterns, strategies, directives (from layers, lessons learned)
 *
 * Working memories expire automatically (short-lived scratch notes).
 */

export type MemoryType = 'episodic' | 'semantic' | 'procedural' | 'working';

export type MemorySource =
  | 'goal_cycle'
  | 'job_completion'
  | 'layer_event'
  | 'consolidation'
  | 'manual'
  | 'reflection';

export interface Memory {
  id: string;
  type: MemoryType;
  source: MemorySource;
  title: string;
  content: string;
  tags: string[];
  importance: number; // 0.0 – 1.0
  metadata: Record<string, unknown>;
  created_at: Date;
  last_accessed_at: Date;
  access_count: number;
  expires_at: Date | null;
}

export interface MemoryPattern {
  id: string;
  pattern_type: string;
  description: string;
  evidence_count: number;
  confidence: number;       // 0.0 – 1.0
  example_memory_ids: string[];
  created_at: Date;
  last_reinforced_at: Date;
}

/** Input to the recorder — caller provides what it knows */
export interface MemoryInput {
  type: MemoryType;
  source: MemorySource;
  title: string;
  content: string;
  tags?: string[];
  importance?: number;
  metadata?: Record<string, unknown>;
  expiresInMs?: number; // for working memories
}
