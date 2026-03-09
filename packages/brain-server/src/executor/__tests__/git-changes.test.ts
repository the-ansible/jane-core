/**
 * Git changes context module tests.
 *
 * Tests git status/diff helpers, section building, and full fragment assembly.
 * Uses mocked fs and child_process.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ContextModuleParams, ResolvedContextPlan } from '../../executor/types.js';

// ---------------------------------------------------------------------------
// Mock fs and child_process
// ---------------------------------------------------------------------------

const mockExistsSync = vi.fn();
const mockReaddirSync = vi.fn();

vi.mock('node:fs', () => ({
  existsSync: (...args: any[]) => mockExistsSync(...args),
  readdirSync: (...args: any[]) => mockReaddirSync(...args),
  readFileSync: vi.fn(),
  statSync: vi.fn().mockReturnValue({ isDirectory: () => false }),
}));

const mockExecSync = vi.fn();

vi.mock('node:child_process', () => ({
  execSync: (...args: any[]) => mockExecSync(...args),
}));

// Import after mocking
import {
  getGitStatus,
  getGitDiffStat,
  getGitDiff,
  buildChangesSection,
} from '../context/modules/git-changes.js';
import gitChangesModule from '../context/modules/git-changes.js';

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
  tokenBudget: 2500,
  modules: ['git-changes'],
  topicTrackingEnabled: false,
  associativeRetrievalEnabled: false,
};

function makeParams(sessionId?: string): ContextModuleParams {
  return { role: 'implementer', prompt: 'implement something', plan: basePlan, sessionId };
}

function makeDirEntry(name: string, isDir = true) {
  return { name, isDirectory: () => isDir, isFile: () => !isDir };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockExistsSync.mockReturnValue(false);
});

// ---------------------------------------------------------------------------
// Tests: getGitStatus
// ---------------------------------------------------------------------------

describe('getGitStatus', () => {
  it('returns git status output on success', () => {
    mockExecSync.mockReturnValue(Buffer.from('M  src/index.ts\n?? new-file.ts\n'));
    const result = getGitStatus('/some/repo');
    expect(result).toContain('src/index.ts');
    expect(result).toContain('new-file.ts');
  });

  it('returns empty string on git failure', () => {
    mockExecSync.mockImplementation(() => { throw new Error('not a git repo'); });
    expect(getGitStatus('/some/dir')).toBe('');
  });

  it('returns empty string for clean working tree', () => {
    mockExecSync.mockReturnValue(Buffer.from(''));
    expect(getGitStatus('/some/repo')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Tests: getGitDiffStat
// ---------------------------------------------------------------------------

describe('getGitDiffStat', () => {
  it('returns diff stat output on success', () => {
    mockExecSync.mockReturnValue(Buffer.from(
      ' src/index.ts | 10 +++++-----\n 1 file changed, 5 insertions(+), 5 deletions(-)\n'
    ));
    const result = getGitDiffStat('/some/repo');
    expect(result).toContain('src/index.ts');
    expect(result).toContain('insertions');
  });

  it('returns empty string on failure', () => {
    mockExecSync.mockImplementation(() => { throw new Error(); });
    expect(getGitDiffStat('/some/repo')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Tests: getGitDiff
// ---------------------------------------------------------------------------

describe('getGitDiff', () => {
  it('returns diff output on success', () => {
    const diffContent = 'diff --git a/file.ts b/file.ts\n+new line\n-old line\n';
    mockExecSync.mockReturnValue(Buffer.from(diffContent));
    const result = getGitDiff('/some/repo');
    expect(result).toContain('diff --git');
    expect(result).toContain('+new line');
  });

  it('truncates output exceeding maxChars', () => {
    const longDiff = 'x'.repeat(10000);
    mockExecSync.mockReturnValue(Buffer.from(longDiff));
    const result = getGitDiff('/some/repo', 100);
    expect(result.length).toBeLessThan(200); // some slack for truncation marker
    expect(result).toContain('truncated');
  });

  it('returns empty string on failure', () => {
    mockExecSync.mockImplementation(() => { throw new Error(); });
    expect(getGitDiff('/some/repo')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Tests: buildChangesSection
// ---------------------------------------------------------------------------

describe('buildChangesSection', () => {
  it('returns null for a clean working tree', () => {
    mockExecSync.mockReturnValue(Buffer.from('')); // empty status
    const result = buildChangesSection('/some/repo', false);
    expect(result).toBeNull();
  });

  it('includes modified file list', () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd === 'git status --short') return Buffer.from('M  src/foo.ts\n M src/bar.ts\n');
      if (cmd === 'git diff --stat HEAD') return Buffer.from(' src/foo.ts | 3 +++\n');
      return Buffer.from('');
    });
    const result = buildChangesSection('/some/repo', false);
    expect(result).not.toBeNull();
    expect(result).toContain('Modified files (2)');
    expect(result).toContain('src/foo.ts');
  });

  it('includes diff stat when available', () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd === 'git status --short') return Buffer.from('M  src/index.ts\n');
      if (cmd === 'git diff --stat HEAD') return Buffer.from(' src/index.ts | 5 +++++\n 1 file changed\n');
      return Buffer.from('');
    });
    const result = buildChangesSection('/some/repo', false);
    expect(result).toContain('Diff summary');
    expect(result).toContain('1 file changed');
  });

  it('includes full diff when includeDiff=true', () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd === 'git status --short') return Buffer.from('M  src/index.ts\n');
      if (cmd === 'git diff --stat HEAD') return Buffer.from(' 1 file changed\n');
      if (cmd === 'git diff HEAD') return Buffer.from('diff --git a/src/index.ts b/src/index.ts\n+new code\n');
      return Buffer.from('');
    });
    const result = buildChangesSection('/some/repo', true);
    expect(result).toContain('Full diff');
    expect(result).toContain('+new code');
  });

  it('omits full diff when includeDiff=false', () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd === 'git status --short') return Buffer.from('M  src/index.ts\n');
      return Buffer.from('');
    });
    const result = buildChangesSection('/some/repo', false);
    expect(result).not.toContain('Full diff');
  });
});

// ---------------------------------------------------------------------------
// Tests: full module assembly
// ---------------------------------------------------------------------------

describe('gitChangesModule', () => {
  it('returns null when no sessionId', async () => {
    const result = await gitChangesModule.assemble(makeParams(undefined));
    expect(result).toBeNull();
  });

  it('returns null when workspace does not exist', async () => {
    mockExistsSync.mockReturnValue(false);
    const result = await gitChangesModule.assemble(makeParams('no-such-session'));
    expect(result).toBeNull();
  });

  it('returns null when workspace has no worktrees', async () => {
    const sessionId = 'clean-session';
    mockExistsSync.mockImplementation((p: string) => p === `/agent/sessions/${sessionId}`);
    mockReaddirSync.mockReturnValue([]);

    const result = await gitChangesModule.assemble(makeParams(sessionId));
    expect(result).toBeNull();
  });

  it('returns null when all worktrees are clean', async () => {
    const sessionId = 'clean-session-2';
    const workspacePath = `/agent/sessions/${sessionId}`;

    mockExistsSync.mockImplementation((p: string) => {
      if (p === workspacePath) return true;
      if (p.endsWith('/package.json')) return true;
      return false;
    });
    mockReaddirSync.mockReturnValue([makeDirEntry('my-repo', true)]);
    // git status returns empty (clean)
    mockExecSync.mockReturnValue(Buffer.from(''));

    const result = await gitChangesModule.assemble(makeParams(sessionId));
    expect(result).toBeNull();
  });

  it('assembles a fragment when there are changes', async () => {
    const sessionId = 'dirty-session';
    const workspacePath = `/agent/sessions/${sessionId}`;

    mockExistsSync.mockImplementation((p: string) => {
      if (p === workspacePath) return true;
      if (p.endsWith('/package.json')) return true;
      return false;
    });
    mockReaddirSync.mockImplementation((p: string, _opts?: any) => {
      if (p === workspacePath) return [makeDirEntry('jane-core', true)];
      return [];
    });
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd === 'git status --short') return Buffer.from('M  src/executor/roles.ts\n');
      if (cmd === 'git diff --stat HEAD') return Buffer.from(' src/executor/roles.ts | 2 +-\n 1 file changed\n');
      if (cmd === 'git diff HEAD') return Buffer.from('diff --git a/src/executor/roles.ts b/src/executor/roles.ts\n+git-changes\n');
      return Buffer.from('');
    });

    const result = await gitChangesModule.assemble(makeParams(sessionId));
    expect(result).not.toBeNull();
    expect(result!.source).toBe('git-changes');
    expect(result!.text).toContain('GIT CHANGES');
    expect(result!.text).toContain('roles.ts');
    expect(result!.tokenEstimate).toBeGreaterThan(0);
    expect(result!.meta).toMatchObject({ worktreesFound: 1, worktreesWithChanges: 1 });
  });

  it('handles git command failures gracefully', async () => {
    const sessionId = 'error-session';
    const workspacePath = `/agent/sessions/${sessionId}`;

    mockExistsSync.mockImplementation((p: string) => {
      if (p === workspacePath) return true;
      if (p.endsWith('/package.json')) return true;
      return false;
    });
    mockReaddirSync.mockReturnValue([makeDirEntry('my-repo', true)]);
    // All git commands throw
    mockExecSync.mockImplementation(() => { throw new Error('git not found'); });

    const result = await gitChangesModule.assemble(makeParams(sessionId));
    // Should return null (all clean — status failed, returns empty)
    expect(result).toBeNull();
  });
});
