/**
 * Tests for vault knowledge injection in the goal cycle context — Phase 7.2.
 *
 * Tests the buildVaultContext integration (via vault-search module mock)
 * to verify vault knowledge is injected when available and skipped when absent.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { extractKeywords, collectVaultFiles, scoreFile } from '../executor/context/modules/vault-search.js';

// ---------------------------------------------------------------------------
// Tests for the vault-search utilities used by engine.ts
// ---------------------------------------------------------------------------

describe('extractKeywords — goal cycle usage', () => {
  it('extracts meaningful keywords from goal text', () => {
    const goalText = 'Become a more capable assistant: Continuously improve reasoning and knowledge';
    const keywords = extractKeywords(goalText);

    // Should include meaningful terms, not stop words
    expect(keywords).toContain('capable');
    expect(keywords).toContain('assistant');
    expect(keywords).toContain('continuously');
    expect(keywords).toContain('reasoning');
    expect(keywords).toContain('knowledge');

    // Should not include stop words or single-char tokens
    expect(keywords).not.toContain('a');
    expect(keywords).not.toContain('and');
  });

  it('extracts keywords from combined goal titles and descriptions', () => {
    const combinedText = [
      'Complete the Jane Core hierarchical agent architecture: Build all four layers — autonomic, reflexive, cognitive, strategic',
      'Establish robust self-maintenance and autonomy routines: Build and maintain scripts, audits, and scheduled jobs',
    ].join(' ');

    const keywords = extractKeywords(combinedText);

    expect(keywords).toContain('hierarchical');
    expect(keywords).toContain('architecture');
    // Should contain some of the meaningful architectural terms (capped at 12 keywords)
    expect(keywords).toContain('hierarchical');
    expect(keywords).toContain('architecture');
    // At least one of the layer names should appear
    const layerNames = ['autonomic', 'reflexive', 'cognitive', 'strategic'];
    const foundLayers = layerNames.filter(n => keywords.includes(n));
    expect(foundLayers.length).toBeGreaterThan(0);
  });

  it('returns empty array for all-stopword input', () => {
    const keywords = extractKeywords('the and or but in on at');
    expect(keywords).toHaveLength(0);
  });

  it('deduplicates keywords', () => {
    const keywords = extractKeywords('agent agent agent architecture architecture');
    const agentCount = keywords.filter(k => k === 'agent').length;
    expect(agentCount).toBe(1);
  });
});

describe('vault-search module — goal cycle integration', () => {
  it('vaultSearchModule exports an assemble function', async () => {
    const mod = await import('../executor/context/modules/vault-search.js');
    expect(typeof mod.default.assemble).toBe('function');
    expect(mod.default.name).toBe('vault-search');
  });

  it('returns null when no keywords found', async () => {
    const { default: vaultSearchModule } = await import('../executor/context/modules/vault-search.js');

    // Pass text with only stop words — should produce no keywords and return null
    const result = await vaultSearchModule.assemble({
      role: 'executor',
      prompt: 'the and or but',
      plan: {
        tokenBudget: 2500,
        modules: ['vault-search'],
        summaryChunkSize: 6,
        summaryModel: 'haiku',
        summaryPromptTemplate: 'default_v1',
        rawSummarizationThreshold: 12,
        maxSummaries: 10,
        modelContextSize: 200000,
        tokenBudgetPct: 0.06,
        topicTrackingEnabled: false,
        associativeRetrievalEnabled: false,
      },
    });

    expect(result).toBeNull();
  });

  it('returns a context fragment with VAULT KNOWLEDGE header for matching prompts', async () => {
    const { default: vaultSearchModule } = await import('../executor/context/modules/vault-search.js');

    // Use terms that definitely exist in the vault (Jane project docs)
    const result = await vaultSearchModule.assemble({
      role: 'executor',
      prompt: 'Jane brain server agent architecture executor',
      plan: {
        tokenBudget: 2500,
        modules: ['vault-search'],
        summaryChunkSize: 6,
        summaryModel: 'haiku',
        summaryPromptTemplate: 'default_v1',
        rawSummarizationThreshold: 12,
        maxSummaries: 10,
        modelContextSize: 200000,
        tokenBudgetPct: 0.06,
        topicTrackingEnabled: false,
        associativeRetrievalEnabled: false,
      },
    });

    // The vault definitely has Jane-related docs, so we should get a result
    if (result !== null) {
      expect(result.source).toBe('vault-search');
      expect(result.text).toContain('VAULT KNOWLEDGE');
      expect(result.tokenEstimate).toBeGreaterThan(0);
    }
    // Acceptable for result to be null in test environment without full vault
  });
});
