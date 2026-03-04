/**
 * Tier 3: Claude CLI escalation classifier.
 * Spawns `claude` CLI in headless mode using the OAuth-authenticated Max account.
 * Only called when local consensus fails (all models disagree).
 *
 * Uses the same spawn pattern as the executor: --print --dangerously-skip-permissions
 * --output-format json -p - (prompt via stdin). This ensures it uses the logged-in
 * OAuth token (Max 5x account) rather than an API key.
 */

import { spawn } from 'node:child_process';
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

  const args = [
    '--print',
    '--dangerously-skip-permissions',
    '--output-format',
    'json',
    '--max-turns',
    '1',
    '--model',
    CLAUDE_MODEL,
    '-p',
    '-',
  ];

  try {
    const result = await spawnClaude(args, prompt);
    const latencyMs = Date.now() - start;

    if (!result) return null;

    // Parse the Claude CLI JSON output to extract the result text
    const resultText = parseClaudeJsonOutput(result);
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

function spawnClaude(args: string[], prompt: string): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: '/agent',
      env: { ...process.env },
      timeout: CLAUDE_TIMEOUT_MS,
    });

    let stdout = '';
    let timedOut = false;

    proc.stdin.write(prompt);
    proc.stdin.end();

    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.stderr.on('data', () => {
      // Ignore stderr for classification
    });

    proc.on('close', (code, signal) => {
      if (signal === 'SIGTERM' || signal === 'SIGKILL') timedOut = true;
      if (timedOut || code !== 0) {
        resolve(null);
        return;
      }
      resolve(stdout);
    });

    proc.on('error', () => {
      resolve(null);
    });

    // Hard timeout
    setTimeout(() => {
      if (proc.exitCode === null) {
        timedOut = true;
        proc.kill('SIGTERM');
      }
    }, CLAUDE_TIMEOUT_MS + 2000);
  });
}

/**
 * Parse Claude CLI --output-format json output.
 * The output is a JSON array of message objects. We want the "result" type's "result" field.
 */
function parseClaudeJsonOutput(stdout: string): string | null {
  try {
    const messages = JSON.parse(stdout) as Array<{
      type: string;
      result?: string;
    }>;
    for (const msg of messages) {
      if (msg.type === 'result' && msg.result) {
        return msg.result;
      }
    }
  } catch {
    // If not JSON array, treat raw stdout as the result
    return stdout.trim() || null;
  }
  return null;
}
