import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, symlinkSync, lstatSync, rmSync, readdirSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';

// Mock child_process.spawn for git commands
vi.mock('node:child_process', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    spawn: vi.fn(() => {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      // Auto-succeed
      process.nextTick(() => proc.emit('close', 0));
      return proc;
    }),
  };
});

// Mock pg Pool
const mockQuery = vi.fn().mockResolvedValue({ rows: [] });
vi.mock('pg', () => ({
  default: {
    Pool: vi.fn(() => ({
      query: (...args: any[]) => mockQuery(...args),
    })),
  },
}));

// Set required env
vi.stubEnv('JANE_DATABASE_URL', 'postgres://test:test@localhost/test');

import {
  ensureWorkspace,
  getWorkspace,
  cleanupWorkspace,
  cleanupStaleWorkspaces,
  initWorkspaceSchema,
  _resetPool,
} from '../workspace.js';

const TEST_BASE = '/tmp/workspace-test-' + Date.now();
const SESSIONS_BASE = join(TEST_BASE, 'sessions');

// Override the SESSIONS_BASE used by workspace.ts
// We can't directly override the const, so we'll test with the real /agent/sessions path
// but clean up after ourselves. Instead, let's test the logic via mocks.

describe('Session Workspaces', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetPool();
  });

  describe('initWorkspaceSchema', () => {
    it('creates the session_workspaces table', async () => {
      await initWorkspaceSchema();
      expect(mockQuery).toHaveBeenCalledOnce();
      const sql = mockQuery.mock.calls[0][0] as string;
      expect(sql).toContain('session_workspaces');
      expect(sql).toContain('session_id');
      expect(sql).toContain('workspace_path');
      expect(sql).toContain('worktree_paths');
    });
  });

  describe('ensureWorkspace', () => {
    it('creates directory and symlinks', async () => {
      const sessionId = 'test-ws-' + Date.now();
      const workspacePath = `/agent/sessions/${sessionId}`;

      try {
        const result = await ensureWorkspace(sessionId);

        expect(result.sessionId).toBe(sessionId);
        expect(result.path).toBe(workspacePath);
        expect(existsSync(workspacePath)).toBe(true);

        // Check symlinks
        const claudeMdLink = join(workspacePath, 'CLAUDE.md');
        if (existsSync(claudeMdLink)) {
          expect(lstatSync(claudeMdLink).isSymbolicLink()).toBe(true);
          expect(readlinkSync(claudeMdLink)).toBe('/agent/CLAUDE.md');
        }

        const dotClaudeLink = join(workspacePath, '.claude');
        if (existsSync(dotClaudeLink)) {
          expect(lstatSync(dotClaudeLink).isSymbolicLink()).toBe(true);
          expect(readlinkSync(dotClaudeLink)).toBe('/agent/.claude');
        }

        // Check DB upsert was called
        const upsertCall = mockQuery.mock.calls.find(
          (call) => typeof call[0] === 'string' && call[0].includes('INSERT INTO'),
        );
        expect(upsertCall).toBeDefined();
      } finally {
        // Cleanup
        if (existsSync(workspacePath)) {
          rmSync(workspacePath, { recursive: true, force: true });
        }
      }
    });

    it('is idempotent — calling twice returns same path', async () => {
      const sessionId = 'test-idempotent-' + Date.now();
      const workspacePath = `/agent/sessions/${sessionId}`;

      try {
        const result1 = await ensureWorkspace(sessionId);
        const result2 = await ensureWorkspace(sessionId);

        expect(result1.path).toBe(result2.path);
        expect(result1.path).toBe(workspacePath);
      } finally {
        if (existsSync(workspacePath)) {
          rmSync(workspacePath, { recursive: true, force: true });
        }
      }
    });

    it('preserves existing files in directory', async () => {
      const sessionId = 'test-preserve-' + Date.now();
      const workspacePath = `/agent/sessions/${sessionId}`;

      try {
        // Pre-create with a file
        mkdirSync(workspacePath, { recursive: true });
        const { writeFileSync } = await import('node:fs');
        writeFileSync(join(workspacePath, 'context.md'), '# Test context');

        await ensureWorkspace(sessionId);

        // Original file should still exist
        expect(existsSync(join(workspacePath, 'context.md'))).toBe(true);
        // Symlinks should be added
        expect(existsSync(join(workspacePath, 'CLAUDE.md'))).toBe(true);
      } finally {
        if (existsSync(workspacePath)) {
          rmSync(workspacePath, { recursive: true, force: true });
        }
      }
    });

    it('returns worktree info when worktrees requested', async () => {
      const sessionId = 'test-wt-' + Date.now();
      const workspacePath = `/agent/sessions/${sessionId}`;

      // Pre-create the worktree target dir so existsSync check doesn't skip push
      const wtPath = join(workspacePath, 'jane-core');
      mkdirSync(wtPath, { recursive: true });

      try {
        const result = await ensureWorkspace(sessionId, {
          worktrees: ['/agent/projects/jane-core'],
        });

        // Worktree path already exists, so git won't be called,
        // but the info should still be returned
        expect(result.worktrees.length).toBe(1);
        expect(result.worktrees[0].name).toBe('jane-core');
        expect(result.worktrees[0].projectPath).toBe('/agent/projects/jane-core');
        expect(result.worktrees[0].branch).toContain('session/');
      } finally {
        if (existsSync(workspacePath)) {
          rmSync(workspacePath, { recursive: true, force: true });
        }
      }
    });
  });

  describe('getWorkspace', () => {
    it('returns null when no workspace exists', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const result = await getWorkspace('nonexistent');
      expect(result).toBeNull();
    });

    it('returns workspace info from DB', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          session_id: 'abc-123',
          workspace_path: '/agent/sessions/abc-123',
          worktree_paths: [],
          created_at: '2026-03-09T00:00:00Z',
          status: 'active',
        }],
      });

      const result = await getWorkspace('abc-123');
      expect(result).not.toBeNull();
      expect(result!.sessionId).toBe('abc-123');
      expect(result!.path).toBe('/agent/sessions/abc-123');
    });

    it('returns null for cleaned workspaces', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          session_id: 'abc-123',
          workspace_path: '/agent/sessions/abc-123',
          worktree_paths: [],
          created_at: '2026-03-09T00:00:00Z',
          status: 'cleaned',
        }],
      });

      const result = await getWorkspace('abc-123');
      expect(result).toBeNull();
    });
  });

  describe('cleanupStaleWorkspaces', () => {
    it('queries for stale workspaces and cleans them', async () => {
      // First call: query for stale workspaces
      mockQuery.mockResolvedValueOnce({
        rows: [{ session_id: 'stale-1' }],
      });
      // getWorkspace call inside cleanupWorkspace
      mockQuery.mockResolvedValueOnce({
        rows: [{
          session_id: 'stale-1',
          workspace_path: '/agent/sessions/stale-1',
          worktree_paths: [],
          created_at: '2026-03-07T00:00:00Z',
          status: 'active',
        }],
      });
      // UPDATE for marking cleaned
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const cleaned = await cleanupStaleWorkspaces(24 * 60 * 60 * 1000);
      expect(cleaned).toBe(1);
    });

    it('skips sessions with running jobs (via SQL)', async () => {
      // The SQL query itself excludes sessions with running jobs
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const cleaned = await cleanupStaleWorkspaces(24 * 60 * 60 * 1000);
      expect(cleaned).toBe(0);

      // Verify the SQL includes the NOT EXISTS check
      const sql = mockQuery.mock.calls[0][0] as string;
      expect(sql).toContain('NOT EXISTS');
      expect(sql).toContain('running');
    });
  });
});
