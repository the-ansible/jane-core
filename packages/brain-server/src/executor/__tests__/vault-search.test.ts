/**
 * Vault search context module tests.
 *
 * Tests keyword extraction, file scoring, and fragment assembly.
 * Uses mocked fs functions to avoid real filesystem access.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ContextModuleParams, ResolvedContextPlan } from '../../executor/types.js';

// ---------------------------------------------------------------------------
// Mock fs
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

// Import after mocking
import { extractKeywords, collectVaultFiles, scoreFile } from '../context/modules/vault-search.js';
import vaultSearchModule from '../context/modules/vault-search.js';

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
  tokenBudget: 3000,
  modules: ['vault-search'],
  topicTrackingEnabled: false,
  associativeRetrievalEnabled: false,
};

function makeParams(prompt: string): ContextModuleParams {
  return { role: 'architect', prompt, plan: basePlan };
}

// ---------------------------------------------------------------------------
// Tests: keyword extraction
// ---------------------------------------------------------------------------

describe('extractKeywords', () => {
  it('extracts meaningful words from a prompt', () => {
    const kws = extractKeywords('Implement a NATS consumer with retry logic for brain server');
    expect(kws).toContain('nats');
    expect(kws).toContain('consumer');
    expect(kws).toContain('retry');
    expect(kws).toContain('logic');
    expect(kws).toContain('brain');
    expect(kws).toContain('server');
  });

  it('filters stop words', () => {
    const kws = extractKeywords('the quick brown fox and a dog');
    expect(kws).not.toContain('the');
    expect(kws).not.toContain('and');
    expect(kws).toContain('quick');
    expect(kws).toContain('brown');
  });

  it('filters short words', () => {
    const kws = extractKeywords('use the api to do it now');
    // 'use', 'api', 'do', 'it', 'now' are all ≤3 chars or stop words
    expect(kws.every(w => w.length > 3 || !['use', 'api', 'now'].includes(w))).toBe(true);
  });

  it('deduplicates keywords', () => {
    const kws = extractKeywords('brain server brain server brain');
    const brainCount = kws.filter(w => w === 'brain').length;
    expect(brainCount).toBe(1);
  });

  it('returns empty array for stop-word-only prompt', () => {
    const kws = extractKeywords('the and or but in on at');
    expect(kws).toHaveLength(0);
  });

  it('caps at 12 keywords', () => {
    const kws = extractKeywords(
      'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima november oscar papa'
    );
    expect(kws.length).toBeLessThanOrEqual(12);
  });
});

// ---------------------------------------------------------------------------
// Tests: file scoring
// ---------------------------------------------------------------------------

describe('scoreFile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStatSync.mockReturnValue({ size: 1000 });
    mockReadFileSync.mockReturnValue('');
  });

  it('scores 0 for no keyword matches', () => {
    mockReadFileSync.mockReturnValue('unrelated content about something else entirely');
    const score = scoreFile('/vault/Projects/Canvas.md', ['nats', 'consumer', 'brain']);
    expect(score).toBe(0);
  });

  it('scores path matches highly (3 points each)', () => {
    mockReadFileSync.mockReturnValue('some content');
    const score = scoreFile('/vault/Projects/jane-core/Brain-Server.md', ['brain', 'server']);
    // 'brain' matches path 2 times (brain-server, Brain-Server.md)
    // 'server' matches path 1 time (Brain-Server.md)
    expect(score).toBeGreaterThan(0);
  });

  it('scores content preview matches (1 point each)', () => {
    mockReadFileSync.mockReturnValue('This document is about NATS messaging and consumer patterns');
    const score = scoreFile('/vault/Projects/SomeDoc.md', ['nats', 'consumer']);
    // Path has no matches, but content has 2
    expect(score).toBe(2);
  });

  it('returns 0 for empty keywords', () => {
    const score = scoreFile('/vault/Projects/Brain-Server.md', []);
    expect(score).toBe(0);
  });

  it('skips content scoring for large files', () => {
    mockStatSync.mockReturnValue({ size: 200000 }); // > 100KB threshold
    const score = scoreFile('/vault/Projects/LargeFile.md', ['content', 'nats']);
    // Large file: no content read, only path scoring
    expect(mockReadFileSync).not.toHaveBeenCalled();
    expect(score).toBe(0); // 'content' and 'nats' not in path
  });
});

// ---------------------------------------------------------------------------
// Tests: vault-search module assembly
// ---------------------------------------------------------------------------

describe('vaultSearchModule.assemble', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
  });

  it('returns null for stop-word-only prompt', async () => {
    const result = await vaultSearchModule.assemble(makeParams('the and or but'));
    expect(result).toBeNull();
  });

  it('returns null when vault directory does not exist', async () => {
    mockExistsSync.mockReturnValue(false);
    const result = await vaultSearchModule.assemble(makeParams('brain server NATS consumer'));
    expect(result).toBeNull();
  });

  it('returns null when no files match keywords', async () => {
    // collectVaultFiles returns a file, but it scores 0
    mockReaddirSync.mockReturnValue([
      { name: 'Unrelated.md', isDirectory: () => false, isFile: () => true },
    ]);
    mockStatSync.mockReturnValue({ size: 100 });
    mockReadFileSync.mockReturnValue('totally unrelated content');

    const result = await vaultSearchModule.assemble(makeParams('brain server NATS consumer'));
    expect(result).toBeNull();
  });

  it('returns a fragment when matching files are found', async () => {
    // Mock vault directory listing
    mockReaddirSync.mockImplementation((dir: string, _opts: any) => {
      if (dir === '/agent/data/vault') {
        return [{ name: 'Projects', isDirectory: () => true, isFile: () => false }];
      }
      if (dir.endsWith('/Projects')) {
        return [{ name: 'Brain-Server.md', isDirectory: () => false, isFile: () => true }];
      }
      return [];
    });
    mockStatSync.mockReturnValue({ size: 500 });
    mockReadFileSync.mockReturnValue('# Brain Server\n\nThis covers NATS messaging patterns and consumer setup.');

    const result = await vaultSearchModule.assemble(makeParams('implement NATS consumer for brain server'));
    expect(result).not.toBeNull();
    expect(result!.source).toBe('vault-search');
    expect(result!.text).toContain('VAULT KNOWLEDGE');
    expect(result!.text).toContain('Brain-Server.md');
    expect(result!.text).toContain('Brain Server');
    expect(result!.tokenEstimate).toBeGreaterThan(0);
    expect(result!.meta?.filesIncluded).toBeGreaterThan(0);
  });

  it('does not throw on readFileSync failure — returns null gracefully', async () => {
    mockReaddirSync.mockReturnValue([
      { name: 'BadFile.md', isDirectory: () => false, isFile: () => true },
    ]);
    mockStatSync.mockImplementation(() => { throw new Error('stat failed'); });

    const result = await vaultSearchModule.assemble(makeParams('brain server NATS consumer testing'));
    // Should not throw; returns null or empty
    expect(result === null || result?.meta?.filesIncluded === 0).toBe(true);
  });

  it('respects token budget — does not exceed it significantly', async () => {
    // Two matching files
    mockReaddirSync.mockImplementation((dir: string, _opts: any) => {
      if (dir === '/agent/data/vault') {
        return [
          { name: 'Brain-Server.md', isDirectory: () => false, isFile: () => true },
          { name: 'NATS-Guide.md', isDirectory: () => false, isFile: () => true },
        ];
      }
      return [];
    });
    mockStatSync.mockReturnValue({ size: 500 });
    // Return large content for each file
    const largeContent = 'brain nats consumer server '.repeat(500); // ~12500 chars, ~3125 tokens
    mockReadFileSync.mockReturnValue(largeContent);

    const tightPlan = { ...basePlan, tokenBudget: 500 };
    const result = await vaultSearchModule.assemble({
      role: 'architect',
      prompt: 'brain server NATS consumer',
      plan: tightPlan,
    });

    if (result) {
      // Allow modest overshoot from headers, but not 3x budget
      expect(result.tokenEstimate).toBeLessThan(tightPlan.tokenBudget * 2);
    }
  });
});
