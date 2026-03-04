/**
 * Worktree manager — creates and cleans up git worktrees for job isolation.
 *
 * When multiple agents need to work on the same project concurrently, we
 * create a git worktree per job so they don't step on each other.
 *
 * For independent jobs (research, maintenance), we use a scratch directory
 * under /tmp/brain-scratch/<jobId>/ instead.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const WORKTREE_BASE = '/tmp/brain-worktrees';
const SCRATCH_BASE = '/tmp/brain-scratch';

/** Create an isolated scratch directory for a job */
export function createScratchDir(jobId: string): string {
  const dir = join(SCRATCH_BASE, jobId);
  mkdirSync(dir, { recursive: true });
  log('info', 'Created scratch dir', { jobId, dir });
  return dir;
}

/** Remove a scratch directory on job completion */
export function cleanupScratchDir(jobId: string): void {
  const dir = join(SCRATCH_BASE, jobId);
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
    log('info', 'Cleaned up scratch dir', { jobId, dir });
  }
}

/** Create a git worktree for a job working on the given project */
export async function createWorktree(jobId: string, projectPath: string): Promise<string> {
  const worktreePath = join(WORKTREE_BASE, jobId);
  const branchName = `brain-job/${jobId.slice(0, 8)}`;

  mkdirSync(WORKTREE_BASE, { recursive: true });

  await runGit(['worktree', 'add', '-b', branchName, worktreePath], projectPath);
  log('info', 'Created git worktree', { jobId, worktreePath, branchName });
  return worktreePath;
}

/** Remove a git worktree after job completion */
export async function removeWorktree(jobId: string, projectPath: string): Promise<void> {
  const worktreePath = join(WORKTREE_BASE, jobId);
  if (!existsSync(worktreePath)) return;

  try {
    await runGit(['worktree', 'remove', '--force', worktreePath], projectPath);
    log('info', 'Removed git worktree', { jobId, worktreePath });
  } catch (err) {
    log('warn', 'Failed to remove git worktree — may already be gone', { jobId, error: String(err) });
  }
}

function runGit(args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', args, { cwd, stdio: 'pipe' });
    let stderr = '';

    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`git ${args.join(' ')} failed (code ${code}): ${stderr}`));
      }
    });

    proc.on('error', reject);
  });
}

function log(level: string, msg: string, extra?: Record<string, unknown>): void {
  console.log(JSON.stringify({ level, msg, component: 'brain-worktree', ts: new Date().toISOString(), ...extra }));
}
