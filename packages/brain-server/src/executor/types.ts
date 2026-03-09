/**
 * Agent Executor types — unified interfaces for the launcher, adapters, and context system.
 */

// ---------------------------------------------------------------------------
// Launch parameters
// ---------------------------------------------------------------------------

export interface LaunchParams {
  /** Session this agent operates within */
  sessionId?: string;
  /** Role determines system prompt framing, tool access, context scope */
  role: string;
  /** The specific task prompt */
  prompt: string;
  /** Which LLM runtime + model to use */
  runtime: RuntimeConfig;
  /** Additional context strings injected before the prompt */
  context?: string[];
  /** Which context modules to run (overrides role defaults) */
  contextModules?: string[];
  /** Create /agent/sessions/{sessionId}/ workspace */
  workspace?: boolean;
  /** Git repos to checkout as worktrees in the workspace */
  worktrees?: string[];
  /** Job type for brain.agent_jobs tracking */
  jobType?: JobType;
  /** NATS subject to publish results to */
  replySubject?: string;
  /** Optional client-supplied correlation ID */
  clientId?: string;
  /** Working directory override (defaults to /agent) */
  workdir?: string;
  /** Project path for worktree isolation (legacy, per-job) */
  projectPath?: string;
}

export interface RuntimeConfig {
  /** Runtime adapter to use */
  tool: RuntimeTool;
  /** Model identifier (runtime-specific) */
  model: string;
  /** Max agentic turns for runtimes that support it (claude-code) */
  maxTurns?: number;
  /** Max tokens to generate (default varies by adapter) */
  maxTokens?: number;
  /** Temperature for runtimes that support it */
  temperature?: number;
  /** Whether the agent gets tool use (file edit, bash, etc.) */
  toolAccess?: boolean;
  /** Reasoning effort level: instant, low, medium, high (Mercury) */
  reasoningEffort?: 'instant' | 'low' | 'medium' | 'high';
  /** Whether to return a summary of the model's reasoning (Mercury, default true) */
  reasoningSummary?: boolean;
  /** Whether to delay response until reasoning summary is ready (Mercury) */
  reasoningSummaryWait?: boolean;
  /** Up to 4 stop sequences (Mercury, OpenAI-compatible adapters) */
  stop?: string[];
  /** Tool definitions for models that support function calling (Mercury) */
  tools?: Record<string, unknown>[];
}

export type RuntimeTool = 'claude-code' | 'mercury' | 'ollama' | 'synthetic';

export type JobType = 'task' | 'research' | 'maintenance' | 'reflection' | 'review';

// ---------------------------------------------------------------------------
// Launch result
// ---------------------------------------------------------------------------

export interface LaunchResult {
  jobId: string;
  sessionId?: string;
  /** NATS subject where the result will be published */
  resultSubject: string;
}

// ---------------------------------------------------------------------------
// Adapter interface
// ---------------------------------------------------------------------------

/** Result returned by a runtime adapter after execution */
export interface AdapterResult {
  /** Whether the execution succeeded */
  success: boolean;
  /** Extracted text result */
  resultText: string | null;
  /** Raw stdout/response body */
  rawOutput: string;
  /** Duration in milliseconds */
  durationMs: number;
  /** Error message if failed */
  error?: string;
}

/** A runtime adapter executes a fully-built prompt against a specific LLM */
export interface RuntimeAdapter {
  readonly name: RuntimeTool;
  execute(params: AdapterExecuteParams): Promise<AdapterResult>;
}

export interface AdapterExecuteParams {
  /** Fully constructed prompt (role + context + task) */
  prompt: string;
  /** Runtime config from LaunchParams */
  runtime: RuntimeConfig;
  /** Job ID for tracking */
  jobId: string;
  /** Working directory */
  workdir: string;
  /** Additional environment variables */
  env?: Record<string, string>;
  /** Callback for stdout activity (heartbeat tracking) */
  onActivity?: (chunk: string) => void;
  /** NATS connection for heartbeat publishing */
  nats?: import('nats').NatsConnection;
}

// ---------------------------------------------------------------------------
// Context types
// ---------------------------------------------------------------------------

/** A message in a session (generic, not tied to stim server's SessionMessage) */
export interface ContextMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  sender?: { id: string; displayName?: string; type: string };
}

/** A context module produces a fragment to inject into the prompt */
export interface ContextModule {
  readonly name: string;
  /** Assemble context for this module. Returns null if nothing to contribute. */
  assemble(params: ContextModuleParams): Promise<ContextFragment | null>;
}

export interface ContextModuleParams {
  sessionId?: string;
  role: string;
  prompt: string;
  plan: ResolvedContextPlan;
}

export interface ContextFragment {
  /** Module that produced this fragment */
  source: string;
  /** Formatted text to inject into the prompt */
  text: string;
  /** Estimated token count */
  tokenEstimate: number;
  /** Metadata for logging */
  meta?: Record<string, unknown>;
}

export interface ContextPlanConfig {
  summaryChunkSize: number;
  summaryModel: string;
  summaryPromptTemplate: string;
  rawSummarizationThreshold: number;
  maxSummaries: number;
  modelContextSize: number;
  tokenBudgetPct: number;
  /** Per-role overrides */
  overrides?: Record<string, Partial<{
    maxSummaries: number;
    tokenBudgetPct: number;
    modules: string[];
  }>>;
  topicTrackingEnabled: boolean;
  associativeRetrievalEnabled: boolean;
}

export interface ResolvedContextPlan extends ContextPlanConfig {
  /** Resolved budget in tokens */
  tokenBudget: number;
  /** Which modules to run */
  modules: string[];
}

export interface AssembledContext {
  /** Ordered context fragments from all modules */
  fragments: ContextFragment[];
  /** Combined text for prompt injection */
  text: string;
  /** Total estimated tokens */
  totalTokens: number;
  /** Assembly metadata */
  meta: {
    planName: string;
    modulesRun: string[];
    assemblyMs: number;
  };
}

// ---------------------------------------------------------------------------
// Summary types (for conversation context module)
// ---------------------------------------------------------------------------

export interface SummaryRecord {
  id: string;
  sessionId: string;
  summary: string;
  topics: string[];
  entities: string[];
  msgStartIdx: number;
  msgEndIdx: number;
  msgCount: number;
  tsStart: string;
  tsEnd: string;
  model: string;
  promptTokens: number | null;
  outputTokens: number | null;
  latencyMs: number | null;
  planName: string;
}

// ---------------------------------------------------------------------------
// Role types
// ---------------------------------------------------------------------------

export interface RoleTemplate {
  /** Role identifier */
  name: string;
  /** System prompt framing text */
  systemPrompt: string;
  /** Default context modules for this role */
  defaultModules: string[];
  /** Default runtime config (can be overridden by caller) */
  defaultRuntime?: Partial<RuntimeConfig>;
}
