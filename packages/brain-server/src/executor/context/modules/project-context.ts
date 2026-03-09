/**
 * Project context module — injects workspace-specific project state.
 *
 * When a session workspace has git worktrees, reads:
 * - package.json / pnpm-workspace.yaml (project name, version, key deps)
 * - Recent git log (last 10 commits, one-line)
 * - src/ directory listing (top-level only)
 *
 * Returns a compact PROJECT CONTEXT: fragment for implementer and architect
 * agents that need to know what project they're working in.
 */

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { execSync } from 'node:child_process';
import type { ContextModule, ContextModuleParams, ContextFragment } from '../types.js';
import { estimateTokens } from '../tokens.js';

const SESSIONS_BASE = '/agent/sessions';
const DEFAULT_TOKEN_BUDGET = 2000;

/** Directories to skip when scanning workspace for project roots */
const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', '.cache', '.claude',
  '.next', 'coverage', 'tmp',
]);

/** Files that indicate a directory is a project root */
const PROJECT_INDICATORS = [
  'package.json',
  'pnpm-workspace.yaml',
  'cargo.toml',
  'pyproject.toml',
];

// ---------------------------------------------------------------------------
// Exported helpers (for testing)
// ---------------------------------------------------------------------------

/**
 * Find direct subdirectories of a workspace that look like project roots.
 * Only checks one level deep — worktrees are always direct children.
 */
export function findWorktrees(workspacePath: string): string[] {
  if (!existsSync(workspacePath)) return [];

  const results: string[] = [];
  try {
    const entries = readdirSync(workspacePath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;

      const dirPath = join(workspacePath, entry.name);
      // Check if this directory looks like a project root
      const hasIndicator = PROJECT_INDICATORS.some(f => existsSync(join(dirPath, f)));
      if (hasIndicator) {
        results.push(dirPath);
      }
    }
  } catch {
    // Unreadable directory — skip
  }

  return results;
}

/**
 * Read and parse a JSON file, returning null on error.
 */
export function readJsonFile(filePath: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Get recent git log for a directory.
 * Returns empty string if not a git repo or git fails.
 */
export function getGitLog(dirPath: string, lines = 10): string {
  try {
    const output = execSync(`git log --oneline -${lines}`, {
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
 * List top-level entries in src/ (or packages/ for monorepos).
 * Returns a compact string like "src/: api.ts, db.ts, index.ts (+2 more)"
 */
export function listSourceDir(dirPath: string): string {
  const candidates = ['src', 'packages', 'lib'];
  for (const candidate of candidates) {
    const srcPath = join(dirPath, candidate);
    if (!existsSync(srcPath)) continue;

    try {
      const stat = statSync(srcPath);
      if (!stat.isDirectory()) continue;

      const entries = readdirSync(srcPath).sort();
      const MAX_SHOW = 8;
      const shown = entries.slice(0, MAX_SHOW).join(', ');
      const extra = entries.length > MAX_SHOW ? ` (+${entries.length - MAX_SHOW} more)` : '';
      return `${candidate}/: ${shown}${extra}`;
    } catch {
      // Unreadable
    }
  }
  return '';
}

/**
 * Build a compact summary section for a single project directory.
 */
export function buildProjectSection(dirPath: string): string | null {
  const name = basename(dirPath);
  const parts: string[] = [`--- ${name} ---`];

  // Package info
  const pkgPath = join(dirPath, 'package.json');
  if (existsSync(pkgPath)) {
    const pkg = readJsonFile(pkgPath);
    if (pkg) {
      const version = typeof pkg.version === 'string' ? ` v${pkg.version}` : '';
      const pkgName = typeof pkg.name === 'string' ? pkg.name : name;
      parts.push(`Package: ${pkgName}${version}`);

      // Key scripts
      const scripts = pkg.scripts as Record<string, string> | undefined;
      if (scripts && typeof scripts === 'object') {
        const keyScripts = ['start', 'build', 'test', 'dev']
          .filter(k => k in scripts)
          .map(k => `${k}: ${scripts[k]}`)
          .join(', ');
        if (keyScripts) parts.push(`Scripts: ${keyScripts}`);
      }
    }
  } else {
    // Monorepo root: pnpm-workspace.yaml
    const wsPath = join(dirPath, 'pnpm-workspace.yaml');
    if (existsSync(wsPath)) {
      try {
        const yaml = readFileSync(wsPath, 'utf-8');
        const packagesMatch = yaml.match(/packages:\s*\n((?:\s+-[^\n]+\n?)+)/);
        if (packagesMatch) {
          parts.push(`Workspace packages:\n${packagesMatch[1].trimEnd()}`);
        } else {
          parts.push(`Workspace: pnpm monorepo`);
        }
      } catch {
        parts.push(`Workspace: pnpm monorepo`);
      }
    }
  }

  // Source directory listing
  const srcListing = listSourceDir(dirPath);
  if (srcListing) parts.push(srcListing);

  // Git log
  const gitLog = getGitLog(dirPath);
  if (gitLog) {
    parts.push(`Recent commits:\n${gitLog}`);
  }

  if (parts.length <= 1) return null; // only header

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

const projectContextModule: ContextModule = {
  name: 'project-context',

  async assemble(params: ContextModuleParams): Promise<ContextFragment | null> {
    if (!params.sessionId) return null;

    const workspacePath = join(SESSIONS_BASE, params.sessionId);
    if (!existsSync(workspacePath)) return null;

    try {
      const worktrees = findWorktrees(workspacePath);
      if (worktrees.length === 0) return null;

      const budget = params.plan?.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
      const parts: string[] = ['PROJECT CONTEXT (active workspace):'];
      let totalTokens = estimateTokens(parts[0]);

      for (const wtPath of worktrees) {
        const section = buildProjectSection(wtPath);
        if (!section) continue;

        const sectionTokens = estimateTokens(section);
        if (totalTokens + sectionTokens > budget) break;

        parts.push(section);
        totalTokens += sectionTokens;
      }

      if (parts.length <= 1) return null;

      const text = parts.join('\n\n');

      log('debug', 'Project context assembled', {
        sessionId: params.sessionId,
        worktreesFound: worktrees.length,
        worktreesIncluded: parts.length - 1,
        totalTokens,
      });

      return {
        source: 'project-context',
        text,
        tokenEstimate: totalTokens,
        meta: {
          worktreesFound: worktrees.length,
          worktreesIncluded: parts.length - 1,
        },
      };
    } catch (err) {
      log('warn', 'Project context module failed', { error: String(err) });
      return null;
    }
  },
};

export default projectContextModule;

function log(level: string, msg: string, extra?: Record<string, unknown>): void {
  console.log(JSON.stringify({ level, msg, component: 'context.project-context', ts: new Date().toISOString(), ...extra }));
}
