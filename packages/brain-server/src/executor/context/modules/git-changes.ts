/**
 * Git changes context module — injects current working-tree state for session worktrees.
 *
 * When a session workspace has git worktrees, reads:
 * - `git status --short` (modified/staged/untracked files)
 * - `git diff --stat HEAD` (change summary by file)
 * - Full `git diff HEAD` if it fits within the token budget
 *
 * Returns a compact GIT CHANGES: fragment useful for implementer and debugger
 * agents that need to know what's been modified in the current session.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import type { ContextModule, ContextModuleParams, ContextFragment } from '../types.js';
import { estimateTokens } from '../tokens.js';
import { findWorktrees } from './project-context.js';

const DEFAULT_TOKEN_BUDGET = 2500;
/** Max token budget reserved for the full diff section */
const MAX_DIFF_TOKENS = 1500;

// ---------------------------------------------------------------------------
// Exported helpers (for testing)
// ---------------------------------------------------------------------------

/**
 * Run `git status --short` in a directory.
 * Returns empty string if not a git repo or no changes.
 */
export function getGitStatus(dirPath: string): string {
  try {
    const output = execSync('git status --short', {
      cwd: dirPath,
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return output.toString().trim();
  } catch {
    return '';
  }
}

/**
 * Run `git diff --stat HEAD` in a directory.
 * Returns empty string if not a git repo or nothing to diff.
 */
export function getGitDiffStat(dirPath: string): string {
  try {
    const output = execSync('git diff --stat HEAD', {
      cwd: dirPath,
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return output.toString().trim();
  } catch {
    return '';
  }
}

/**
 * Run `git diff HEAD` in a directory.
 * Returns empty string if not a git repo or no diff.
 * Truncates output at maxChars to keep it reasonable.
 */
export function getGitDiff(dirPath: string, maxChars = 8000): string {
  try {
    const output = execSync('git diff HEAD', {
      cwd: dirPath,
      timeout: 10000,
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 10 * 1024 * 1024, // 10 MB
    });
    const text = output.toString();
    if (text.length > maxChars) {
      return text.slice(0, maxChars) + '\n... (diff truncated)';
    }
    return text.trim();
  } catch {
    return '';
  }
}

/**
 * Build a compact changes section for a single worktree.
 * Returns null if the worktree has no changes.
 */
export function buildChangesSection(dirPath: string, includeDiff: boolean): string | null {
  const status = getGitStatus(dirPath);
  if (!status) return null; // clean working tree

  const name = dirPath.split('/').pop() ?? dirPath;
  const parts: string[] = [`--- ${name} ---`];

  // Status summary
  const statusLines = status.split('\n');
  parts.push(`Modified files (${statusLines.length}):\n${status}`);

  // Diff stat
  const diffStat = getGitDiffStat(dirPath);
  if (diffStat) {
    parts.push(`Diff summary:\n${diffStat}`);
  }

  // Full diff if requested and budget allows
  if (includeDiff) {
    const diff = getGitDiff(dirPath);
    if (diff) {
      parts.push(`Full diff:\n${diff}`);
    }
  }

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

const SESSIONS_BASE = '/agent/sessions';

const gitChangesModule: ContextModule = {
  name: 'git-changes',

  async assemble(params: ContextModuleParams): Promise<ContextFragment | null> {
    if (!params.sessionId) return null;

    const workspacePath = join(SESSIONS_BASE, params.sessionId);
    if (!existsSync(workspacePath)) return null;

    try {
      const worktrees = findWorktrees(workspacePath);
      if (worktrees.length === 0) return null;

      const budget = params.plan?.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
      const parts: string[] = ['GIT CHANGES (current session):'];
      let totalTokens = estimateTokens(parts[0]);
      let worktreesWithChanges = 0;

      for (const wtPath of worktrees) {
        // First check if there are any changes at all (cheap: just status)
        const status = getGitStatus(wtPath);
        if (!status) continue; // clean — skip

        // Determine if we can include the full diff
        const remainingBudget = budget - totalTokens;
        const includeDiff = remainingBudget > MAX_DIFF_TOKENS;

        const section = buildChangesSection(wtPath, includeDiff);
        if (!section) continue;

        const sectionTokens = estimateTokens(section);
        if (totalTokens + sectionTokens > budget) {
          // Include just the status without diff if it fits
          const minimalSection = buildChangesSection(wtPath, false);
          if (minimalSection) {
            const minTokens = estimateTokens(minimalSection);
            if (totalTokens + minTokens <= budget) {
              parts.push(minimalSection);
              totalTokens += minTokens;
              worktreesWithChanges++;
            }
          }
          break;
        }

        parts.push(section);
        totalTokens += sectionTokens;
        worktreesWithChanges++;
      }

      if (worktreesWithChanges === 0) return null; // all clean

      const text = parts.join('\n\n');

      log('debug', 'Git changes context assembled', {
        sessionId: params.sessionId,
        worktreesFound: worktrees.length,
        worktreesWithChanges,
        totalTokens,
      });

      return {
        source: 'git-changes',
        text,
        tokenEstimate: totalTokens,
        meta: {
          worktreesFound: worktrees.length,
          worktreesWithChanges,
        },
      };
    } catch (err) {
      log('warn', 'Git changes module failed', { error: String(err) });
      return null;
    }
  },
};

export default gitChangesModule;

function log(level: string, msg: string, extra?: Record<string, unknown>): void {
  console.log(JSON.stringify({ level, msg, component: 'context.git-changes', ts: new Date().toISOString(), ...extra }));
}
