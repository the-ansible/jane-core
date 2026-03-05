/**
 * Classification types shared across all classifier tiers.
 */

export type Urgency = 'immediate' | 'normal' | 'low' | 'ignore';
export type Category = 'question' | 'task_request' | 'social' | 'alert' | 'informational';
export type Routing = 'reflexive_reply' | 'deliberate_thought' | 'log_only' | 'escalate';
export type Confidence = 'high' | 'medium' | 'low';
export type Tier = 'rules' | 'local_consensus' | 'mercury' | 'claude_escalation' | 'fallback';

export interface Classification {
  urgency: Urgency;
  category: Category;
  routing: Routing;
}

export interface ClassificationResult extends Classification {
  confidence: Confidence;
  tier: Tier;
  agreement?: { votes: number; agreeing: number };
  latencyMs: number;
  /** The specific model used (e.g. 'gemma3:12b', 'haiku'). Absent for rules tier. */
  model?: string;
}

/** Valid values for schema validation of LLM responses */
export const VALID_URGENCY: Urgency[] = ['immediate', 'normal', 'low', 'ignore'];
export const VALID_CATEGORY: Category[] = ['question', 'task_request', 'social', 'alert', 'informational'];
export const VALID_ROUTING: Routing[] = ['reflexive_reply', 'deliberate_thought', 'log_only', 'escalate'];

export interface ClassificationContext {
  content: string;
  channelType: string;
  hints?: { category?: string; urgency?: string; routing?: string };
  sender?: { id: string; displayName?: string; type: string };
  sessionState: 'cold_start' | 'active_conversation';
}

export function isValidClassification(obj: unknown): obj is Classification {
  if (typeof obj !== 'object' || obj === null) return false;
  const c = obj as Record<string, unknown>;
  return (
    VALID_URGENCY.includes(c.urgency as Urgency) &&
    VALID_CATEGORY.includes(c.category as Category) &&
    VALID_ROUTING.includes(c.routing as Routing)
  );
}

/** Result returned by any LLM classifier implementation */
export interface LlmClassifyResult {
  classification: Classification;
  confidence: Confidence;
  latencyMs: number;
  model: string;
  /** Optional metadata (e.g. consensus agreement info) */
  metadata?: Record<string, unknown>;
}

/** Common interface for all LLM-based classifiers */
export interface LlmClassifier {
  /** Human-readable name for logging (e.g. 'mercury', 'ollama', 'claude-cli') */
  readonly name: string;
  /** Tier label used in ClassificationResult */
  readonly tier: Tier;
  classify(ctx: ClassificationContext): Promise<LlmClassifyResult | null>;
}
