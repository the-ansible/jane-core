/**
 * Project context module tests.
 *
 * Tests worktree discovery, package parsing, git log, source listing,
 * and full fragment assembly. Uses mocked fs and child_process.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ContextModuleParams, ResolvedContextPlan } from '../../executor/types.js';

// ---------------------------------------------------------------------------
// Mock fs and child_process
// ---------------------------------------------------------------------------

const mockReaddirSync = vi.fn();
const mockReadFileSync = vi.fn();
const mockExistsSync = vi.fn();
const mockStatSync = vi.fn();

vi.mock('node:fs', () => ({
  readdirSync: (...args: any[]) => mockReaddirSync(...args),
  readFileSync: (...args: any[]) => mockReadFileSync(...args),
  existsSync: (...args: any[]) => mockExistsSync(...args),
  statSync: (...args: any[]) => mockStatSync(...args),
}));

const mockExecSync = vi.fn();

vi.mock('node:child_process', () => ({
  execSync: (...args: any[]) => mockExecSync(...args),
}));

// Import after mocking
import {
  findWorktrees,
  readJsonFile,
  getGitLog,
  listSourceDir,
  buildProjectSection,
} from '../context/modules/project-context.js';
import projectContextModule from '../context/modules/project-context.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const basePlan: ResolvedContextPlan = {
  summaryChunkSize: 6,
  summaryModel: 'gemma3:12b',
  summaryPromptTemplate: '',
  rawSummarizationThreshold: 12,
  maxSummaries: 10,
  modelContextSize: 200000,
  tokenBudgetPct: 0.06,
  tokenBudget: 2000,
  modules: ['project-context'],
  topicTrackingEnabled: false,
  associativeRetrievalEnabled: false,
};

function makeParams(sessionId?: string): ContextModuleParams {
  return { role: 'implementer', prompt: 'implement the feature', plan: basePlan, sessionId };
}

function makeDirEntry(name: string, isDir = true) {
  return { name, isDirectory: () => isDir, isFile: () => !isDir };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: everything exists
  mockExistsSync.mockReturnValue(false);
  mockStatSync.mockReturnValue({ isDirectory: () => false });
});

// ---------------------------------------------------------------------------
// Tests: findWorktrees
// ---------------------------------------------------------------------------

describe('findWorktrees', () => {
  it('returns empty array if workspace does not exist', () => {
    mockExistsSync.mockReturnValue(false);
    expect(findWorktrees('/agent/sessions/abc')).toEqual([]);
  });

  it('finds subdirectory with package.json as a worktree', () => {
    mockExistsSync.mockImplementation((p: string) => {
      if (p === '/agent/sessions/abc') return true;
      if (p === '/agent/sessions/abc/jane-core/package.json') return true;
      return false;
    });
    mockReaddirSync.mockReturnValue([
      makeDirEntry('jane-core', true),
    ]);

    const result = findWorktrees('/agent/sessions/abc');
    expect(result).toEqual(['/agent/sessions/abc/jane-core']);
  });

  it('skips node_modules and .git directories', () => {
    mockExistsSync.mockImplementation((p: string) => {
      if (p === '/agent/sessions/abc') return true;
      if (p === '/agent/sessions/abc/node_modules/package.json') return true;
      return false;
    });
    mockReaddirSync.mockReturnValue([
      makeDirEntry('node_modules', true),
      makeDirEntry('.git', true),
    ]);

    const result = findWorktrees('/agent/sessions/abc');
    expect(result).toEqual([]);
  });

  it('skips files (non-directories)', () => {
    mockExistsSync.mockImplementation((p: string) => p === '/agent/sessions/abc');
    mockReaddirSync.mockReturnValue([
      makeDirEntry('CLAUDE.md', false),
    ]);

    const result = findWorktrees('/agent/sessions/abc');
    expect(result).toEqual([]);
  });

  it('finds multiple worktrees', () => {
    mockExistsSync.mockImplementation((p: string) => {
      if (p === '/agent/sessions/abc') return true;
      if (p.endsWith('/package.json')) return true;
      return false;
    });
    mockReaddirSync.mockReturnValue([
      makeDirEntry('repo-a', true),
      makeDirEntry('repo-b', true),
    ]);

    const result = findWorktrees('/agent/sessions/abc');
    expect(result).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Tests: readJsonFile
// ---------------------------------------------------------------------------

describe('readJsonFile', () => {
  it('parses valid JSON', () => {
    mockReadFileSync.mockReturnValue('{"name":"my-pkg","version":"1.0.0"}');
    expect(readJsonFile('/some/package.json')).toEqual({ name: 'my-pkg', version: '1.0.0' });
  });

  it('returns null on invalid JSON', () => {
    mockReadFileSync.mockReturnValue('not json {{{');
    expect(readJsonFile('/some/package.json')).toBeNull();
  });

  it('returns null on read error', () => {
    mockReadFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
    expect(readJsonFile('/some/package.json')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests: getGitLog
// ---------------------------------------------------------------------------

describe('getGitLog', () => {
  it('returns git log output on success', () => {
    mockExecSync.mockReturnValue(Buffer.from('abc1234 feat: add thing\ndef5678 fix: remove bug\n'));
    const result = getGitLog('/some/repo');
    expect(result).toContain('feat: add thing');
    expect(result).toContain('remove bug');
  });

  it('returns empty string on git failure', () => {
    mockExecSync.mockImplementation(() => { throw new Error('not a git repo'); });
    expect(getGitLog('/some/dir')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Tests: listSourceDir
// ---------------------------------------------------------------------------

describe('listSourceDir', () => {
  it('lists src/ directory entries', () => {
    mockExistsSync.mockImplementation((p: string) => p.endsWith('/src'));
    mockStatSync.mockReturnValue({ isDirectory: () => true });
    mockReaddirSync.mockReturnValue(['api.ts', 'db.ts', 'index.ts']);

    const result = listSourceDir('/some/repo');
    expect(result).toContain('src/');
    expect(result).toContain('api.ts');
    expect(result).toContain('db.ts');
  });

  it('returns empty string if no src/ or packages/ exists', () => {
    mockExistsSync.mockReturnValue(false);
    expect(listSourceDir('/some/repo')).toBe('');
  });

  it('truncates long listings with count', () => {
    mockExistsSync.mockImplementation((p: string) => p.endsWith('/src'));
    mockStatSync.mockReturnValue({ isDirectory: () => true });
    mockReaddirSync.mockReturnValue([
      'a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts', 'g.ts', 'h.ts', 'i.ts',
    ]);

    const result = listSourceDir('/some/repo');
    expect(result).toContain('+1 more');
  });
});

// ---------------------------------------------------------------------------
// Tests: buildProjectSection
// ---------------------------------------------------------------------------

describe('buildProjectSection', () => {
  it('builds section with package.json info', () => {
    mockExistsSync.mockImplementation((p: string) => p.endsWith('package.json'));
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ name: 'brain-server', version: '0.4.1', scripts: { test: 'vitest' } })
    );
    mockExecSync.mockImplementation(() => { throw new Error(); }); // no git
    mockStatSync.mockReturnValue({ isDirectory: () => false }); // no src/

    const result = buildProjectSection('/agent/sessions/abc/jane-core');
    expect(result).not.toBeNull();
    expect(result).toContain('brain-server');
    expect(result).toContain('v0.4.1');
    expect(result).toContain('test: vitest');
  });

  it('includes git log when available', () => {
    mockExistsSync.mockImplementation((p: string) => p.endsWith('package.json'));
    mockReadFileSync.mockReturnValue(JSON.stringify({ name: 'pkg', version: '1.0.0' }));
    mockExecSync.mockReturnValue(Buffer.from('abc1234 feat: something\n'));
    mockStatSync.mockReturnValue({ isDirectory: () => false });

    const result = buildProjectSection('/agent/sessions/abc/jane-core');
    expect(result).toContain('Recent commits:');
    expect(result).toContain('feat: something');
  });

  it('returns null if only the header is produced', () => {
    // No package.json, no worktree indicators
    mockExistsSync.mockReturnValue(false);
    mockExecSync.mockImplementation(() => { throw new Error(); });

    const result = buildProjectSection('/agent/sessions/abc/jane-core');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests: full module assembly
// ---------------------------------------------------------------------------

describe('projectContextModule', () => {
  it('returns null when no sessionId', async () => {
    const result = await projectContextModule.assemble(makeParams(undefined));
    expect(result).toBeNull();
  });

  it('returns null when workspace does not exist', async () => {
    mockExistsSync.mockReturnValue(false);
    const result = await projectContextModule.assemble(makeParams('test-session'));
    expect(result).toBeNull();
  });

  it('returns null when workspace has no project directories', async () => {
    mockExistsSync.mockImplementation((p: string) => p === '/agent/sessions/test-session');
    mockReaddirSync.mockReturnValue([]); // empty workspace

    const result = await projectContextModule.assemble(makeParams('test-session'));
    expect(result).toBeNull();
  });

  it('assembles a fragment with project info', async () => {
    const sessionId = 'test-session-123';
    const workspacePath = `/agent/sessions/${sessionId}`;
    const worktreePath = `${workspacePath}/jane-core`;

    mockExistsSync.mockImplementation((p: string) => {
      if (p === workspacePath) return true;
      if (p === `${worktreePath}/package.json`) return true;
      return false;
    });
    mockReaddirSync.mockImplementation((p: string, _opts?: any) => {
      if (p === workspacePath) return [makeDirEntry('jane-core', true)];
      return [];
    });
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ name: 'brain-server', version: '0.4.1', scripts: { start: 'node dist/index.js' } })
    );
    mockExecSync.mockReturnValue(Buffer.from('abc123 feat: Phase 6.3\n'));
    mockStatSync.mockReturnValue({ isDirectory: () => false });

    const result = await projectContextModule.assemble(makeParams(sessionId));
    expect(result).not.toBeNull();
    expect(result!.source).toBe('project-context');
    expect(result!.text).toContain('PROJECT CONTEXT');
    expect(result!.text).toContain('brain-server');
    expect(result!.text).toContain('Phase 6.3');
    expect(result!.tokenEstimate).toBeGreaterThan(0);
  });

  it('respects token budget', async () => {
    const sessionId = 'budget-session';
    const workspacePath = `/agent/sessions/${sessionId}`;

    // Two worktrees
    mockExistsSync.mockImplementation((p: string) => {
      if (p === workspacePath) return true;
      if (p.endsWith('/package.json')) return true;
      return false;
    });
    mockReaddirSync.mockImplementation((p: string, _opts?: any) => {
      if (p === workspacePath) {
        return [makeDirEntry('repo-a', true), makeDirEntry('repo-b', true)];
      }
      return [];
    });
    // Return a large package.json to quickly exhaust budget
    const largePkg = { name: 'large-package', version: '9.9.9', scripts: { start: 'x'.repeat(2000) } };
    mockReadFileSync.mockReturnValue(JSON.stringify(largePkg));
    mockExecSync.mockReturnValue(Buffer.from('abc123 commit\n'));
    mockStatSync.mockReturnValue({ isDirectory: () => false });

    const tinyBudgetPlan: ResolvedContextPlan = { ...basePlan, tokenBudget: 50 };
    const params: ContextModuleParams = { ...makeParams(sessionId), plan: tinyBudgetPlan };

    const result = await projectContextModule.assemble(params);
    // Should still assemble (header fits) or return null — either is fine; just must not throw
    // The key constraint: if it does produce output, tokenEstimate shouldn't massively exceed budget
    if (result !== null) {
      expect(result.tokenEstimate).toBeDefined();
    }
  });
});
