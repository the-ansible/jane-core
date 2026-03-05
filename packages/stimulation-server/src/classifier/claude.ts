/**
 * Tier 3: Claude CLI escalation classifier.
 * Spawns `claude` CLI in headless mode using the OAuth-authenticated Max account.
 * Only called when local consensus fails (all models disagree).
 *
 * Uses @jane-core/claude-launcher for standardized Claude CLI spawning.
 */

import { launchClaude, parseClaudeJsonOutput } from '@jane-core/claude-launcher';
import {
  type Classification,
  type ClassificationContext,
  isValidClassification,
} from './types.js';
import { parseClassificationResponse } from './ollama.js';
import { buildClassificationPrompt } from './prompt.js';

const CLAUDE_TIMEOUT_MS = 60_000; // 1 minute max for classification
const CLAUDE_MODEL = 'haiku';

interface ClaudeResult {
  classification: Classification;
  latencyMs: number;
  model: string;
}

/**
 * Classify a message by spawning the Claude CLI.
 * Uses --print mode with prompt via stdin to leverage OAuth session.
 */
export async function classifyByClaude(
  ctx: ClassificationContext
): Promise<ClaudeResult | null> {
  const start = Date.now();
  const prompt = buildClassificationPrompt(ctx);

  try {
    const result = await launchClaude({
      model: CLAUDE_MODEL,
      prompt,
      maxTurns: 1,
      timeout: CLAUDE_TIMEOUT_MS,
    });
    const latencyMs = Date.now() - start;

    if (result.exitCode !== 0 || result.timedOut) return null;

    // Parse the Claude CLI JSON output to extract the result text
    const resultText = result.resultText;
    if (!resultText) return null;

    // Parse the classification from the result text
    const classification = parseClassificationResponse(resultText);
    if (!classification) return null;

    return { classification, latencyMs, model: CLAUDE_MODEL };
  } catch (err) {
    console.log(JSON.stringify({
      level: 'error',
      msg: 'Claude classifier failed',
      error: String(err),
      component: 'classifier',
      ts: new Date().toISOString(),
    }));
    return null;
  }
}
