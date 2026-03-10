/**
 * Session Workspaces — persistent, per-session working directories.
 *
 * Each session that needs isolation gets `/agent/sessions/{sessionId}/`
 * with symlinks to project config (.claude, CLAUDE.md, etc.) and optional
 * git worktrees for code changes.
 *
 * Multiple agents in the same session share the workspace. This is the
 * session-level isolation boundary (vs. per-job worktrees which are ephemeral).
 */

import { mkdirSync, symlinkSync, existsSync, readdirSync, rmSync, lstatSync } from 'node:fs';
import { join, basename } from 'node:path';
import { spawn } from 'node:child_process';
import pg from 'pg';

const { Pool } = pg;

const SCHEMA = process.env.BRAIN_SCHEMA ?? 'brain';
const SESSIONS_BASE = '/agent/sessions';

/** Files/dirs to symlink from /agent into each workspace */
const SYMLINK_TARGETS = [
  { name: '.claude', target: '/agent/.claude' },
  { name: 'CLAUDE.md', target: '/agent/CLAUDE.md' },
  { name: 'INNER_VOICE.md', target: '/agent/INNER_VOICE.md' },
  { name: 'CONVENTIONS.md', target: '/agent/CONVENTIONS.md' },
  { name: 'DIRECTIVES.md', target: '/agent/DIRECTIVES.md' },
  { name: 'INDEX.md', target: '/agent/INDEX.md' },
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorkspaceInfo {
  sessionId: string;
  path: string;
  worktrees: WorktreeInfo[];
  createdAt: string;
}

export interface WorktreeInfo {
  name: string;
  path: string;
  projectPath: string;
  branch: string;
}

// ---------------------------------------------------------------------------
// DB
// ---------------------------------------------------------------------------

let pool: pg.Pool | null = null;

function getPool(): pg.Pool {
  if (pool) return pool;
  const connectionString = process.env.JANE_DATABASE_URL;
  if (!connectionString) throw new Error('JANE_DATABASE_URL is required');
  pool = new Pool({ connectionString });
  return pool;
}

export async function initWorkspaceSchema(): Promise<void> {
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.session_workspaces (
      session_id       UUID PRIMARY KEY,
      workspace_path   TEXT NOT NULL,
      worktree_paths   JSONB NOT NULL DEFAULT '[]',
      status           TEXT NOT NULL DEFAULT 'active',
      created_at       TIMESTAMPTZ DEFAULT now(),
      last_activity_at TIMESTAMPTZ DEFAULT now(),
      cleaned_at       TIMESTAMPTZ
    )
  `);
  log('info', 'Workspace schema initialized');
}

// ---------------------------------------------------------------------------
// Core API
// ---------------------------------------------------------------------------

/**
 * Ensure a session workspace exists. Idempotent.
 * Creates the directory, symlinks, and optional git worktrees.
 */
export async function ensureWorkspace(
  sessionId: string,
  opts?: { worktrees?: string[] },
): Promise<WorkspaceInfo> {
  const workspacePath = join(SESSIONS_BASE, sessionId);

  // Create directory if needed
  mkdirSync(workspacePath, { recursive: true });

  // Set up symlinks (skip if already present)
  for (const { name, target } of SYMLINK_TARGETS) {
    const linkPath = join(workspacePath, name);
    if (!existsSync(linkPath) && existsSync(target)) {
      try {
        symlinkSync(target, linkPath);
      } catch {
        // Race condition or permission issue; non-fatal
      }
    }
  }

  // Create git worktrees
  const worktrees: WorktreeInfo[] = [];
  if (opts?.worktrees) {
    for (const projectPath of opts.worktrees) {
      const name = basename(projectPath);
      const wtPath = join(workspacePath, name);
      const branch = `session/${sessionId.slice(0, 8)}/${name}`;

      if (!existsSync(wtPath)) {
        try {
          await runGit(['worktree', 'add', '-b', branch, wtPath], projectPath);

          // Symlink node_modules from source to avoid reinstall
          const srcModules = join(projectPath, 'node_modules');
          const dstModules = join(wtPath, 'node_modules');
          if (existsSync(srcModules) && !existsSync(dstModules)) {
            symlinkSync(srcModules, dstModules);
          }

          log('info', 'Created session worktree', { sessionId, name, branch, wtPath });
        } catch (err) {
          log('warn', 'Failed to create session worktree', {
            sessionId, name, projectPath, error: String(err),
          });
          continue;
        }
      }

      worktrees.push({ name, path: wtPath, projectPath, branch });
    }
  }

  // Upsert DB record
  await getPool().query(`
    INSERT INTO ${SCHEMA}.session_workspaces (session_id, workspace_path, worktree_paths, status, last_activity_at)
    VALUES ($1, $2, $3, 'active', now())
    ON CONFLICT (session_id) DO UPDATE SET
      worktree_paths = COALESCE(
        NULLIF($3::jsonb, '[]'::jsonb),
        ${SCHEMA}.session_workspaces.worktree_paths
      ),
      last_activity_at = now(),
      status = 'active'
  `, [sessionId, workspacePath, JSON.stringify(worktrees)]);

  const createdAt = new Date().toISOString();

  return { sessionId, path: workspacePath, worktrees, createdAt };
}

/**
 * Get workspace info for a session, or null if none exists.
 */
export async function getWorkspace(sessionId: string): Promise<WorkspaceInfo | null> {
  const { rows } = await getPool().query<{
    session_id: string;
    workspace_path: string;
    worktree_paths: WorktreeInfo[];
    created_at: string;
    status: string;
  }>(
    `SELECT session_id, workspace_path, worktree_paths, created_at, status
     FROM ${SCHEMA}.session_workspaces WHERE session_id = $1`,
    [sessionId],
  );

  if (rows.length === 0) return null;
  const row = rows[0];
  if (row.status !== 'active') return null;

  return {
    sessionId: row.session_id,
    path: row.workspace_path,
    worktrees: row.worktree_paths,
    createdAt: row.created_at,
  };
}

/**
 * List all active workspaces.
 */
export async function listWorkspaces(): Promise<WorkspaceInfo[]> {
  const { rows } = await getPool().query<{
    session_id: string;
    workspace_path: string;
    worktree_paths: WorktreeInfo[];
    created_at: string;
  }>(
    `SELECT session_id, workspace_path, worktree_paths, created_at
     FROM ${SCHEMA}.session_workspaces WHERE status = 'active'
     ORDER BY last_activity_at DESC`,
  );

  return rows.map((r) => ({
    sessionId: r.session_id,
    path: r.workspace_path,
    worktrees: r.worktree_paths,
    createdAt: r.created_at,
  }));
}

/**
 * Update last_activity_at for a workspace.
 */
export async function touchWorkspaceActivity(sessionId: string): Promise<void> {
  await getPool().query(
    `UPDATE ${SCHEMA}.session_workspaces SET last_activity_at = now() WHERE session_id = $1`,
    [sessionId],
  );
}

/**
 * Clean up a session workspace: remove worktrees, delete directory, mark DB record.
 */
export async function cleanupWorkspace(sessionId: string): Promise<void> {
  const workspace = await getWorkspace(sessionId);
  if (!workspace) return;

  // Remove git worktrees
  for (const wt of workspace.worktrees) {
    try {
      // Remove node_modules symlink first (git worktree remove won't handle it)
      const nmLink = join(wt.path, 'node_modules');
      if (existsSync(nmLink) && lstatSync(nmLink).isSymbolicLink()) {
        rmSync(nmLink);
      }
      await runGit(['worktree', 'remove', '--force', wt.path], wt.projectPath);
      // Also delete the branch
      await runGit(['branch', '-D', wt.branch], wt.projectPath).catch((err) => log('warn', 'Failed to delete worktree branch (may already be gone)', { branch: wt.branch, error: String(err) }));
      log('info', 'Removed session worktree', { sessionId, name: wt.name });
    } catch (err) {
      log('warn', 'Failed to remove session worktree', {
        sessionId, name: wt.name, error: String(err),
      });
    }
  }

  // Remove the workspace directory (symlinks and all)
  const workspacePath = join(SESSIONS_BASE, sessionId);
  if (existsSync(workspacePath)) {
    rmSync(workspacePath, { recursive: true, force: true });
    log('info', 'Removed session workspace directory', { sessionId, workspacePath });
  }

  // Mark DB record
  await getPool().query(
    `UPDATE ${SCHEMA}.session_workspaces SET status = 'cleaned', cleaned_at = now() WHERE session_id = $1`,
    [sessionId],
  );
}

/**
 * Clean up workspaces that have been inactive for longer than maxAgeMs.
 * Skips sessions with running jobs.
 */
export async function cleanupStaleWorkspaces(maxAgeMs: number): Promise<number> {
  const { rows } = await getPool().query<{ session_id: string }>(
    `SELECT sw.session_id
     FROM ${SCHEMA}.session_workspaces sw
     WHERE sw.status = 'active'
       AND sw.last_activity_at < now() - interval '1 millisecond' * $1
       AND NOT EXISTS (
         SELECT 1 FROM ${SCHEMA}.agent_jobs aj
         WHERE aj.session_id = sw.session_id AND aj.status = 'running'
       )`,
    [maxAgeMs],
  );

  let cleaned = 0;
  for (const row of rows) {
    try {
      await cleanupWorkspace(row.session_id);
      cleaned++;
    } catch (err) {
      log('warn', 'Stale workspace cleanup failed', {
        sessionId: row.session_id, error: String(err),
      });
    }
  }

  if (cleaned > 0) {
    log('info', 'Cleaned up stale workspaces', { cleaned, total: rows.length });
  }

  return cleaned;
}

// ---------------------------------------------------------------------------
// Periodic cleanup
// ---------------------------------------------------------------------------

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours

let cleanupTimer: ReturnType<typeof setInterval> | null = null;

export function startWorkspaceCleanup(): void {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(async () => {
    try {
      await cleanupStaleWorkspaces(STALE_THRESHOLD_MS);
    } catch (err) {
      log('error', 'Workspace cleanup sweep failed', { error: String(err) });
    }
  }, CLEANUP_INTERVAL_MS);
  log('info', 'Workspace cleanup started', { intervalMs: CLEANUP_INTERVAL_MS, staleThresholdMs: STALE_THRESHOLD_MS });
}

export function stopWorkspaceCleanup(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Git helper
// ---------------------------------------------------------------------------

function runGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', args, { cwd, stdio: 'pipe' });
    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`git ${args.join(' ')} failed (code ${code}): ${stderr}`));
      }
    });

    proc.on('error', reject);
  });
}

function log(level: string, msg: string, extra?: Record<string, unknown>): void {
  console.log(JSON.stringify({ level, msg, component: 'workspace', ts: new Date().toISOString(), ...extra }));
}

/** For testing */
export function _resetPool(): void {
  pool = null;
}
