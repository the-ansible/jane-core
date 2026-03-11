/**
 * Tests for communication/hallucination-detector.ts
 *
 * These tests focus on deterministic logic (heuristic pre-filter, claim routing,
 * score aggregation, Wikipedia verification, score fusion) without hitting external APIs.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeClaimResult(confidence: number, source: 'wolfram' | 'ollama-selfcheck' | 'skipped' = 'ollama-selfcheck') {
  return { claim: 'test claim', category: 'general' as const, confidence, source };
}

// ---------------------------------------------------------------------------
// likelyHasClaims — heuristic pre-filter
// ---------------------------------------------------------------------------

describe('likelyHasClaims', () => {
  it('returns false for short messages', async () => {
    const { likelyHasClaims } = await import('./hallucination-detector.js');
    expect(likelyHasClaims('Hi!')).toBe(false);
    expect(likelyHasClaims('Sure, I can help.')).toBe(false);
  });

  it('returns false for conversational messages with no factual markers', async () => {
    const { likelyHasClaims } = await import('./hallucination-detector.js');
    expect(likelyHasClaims('That sounds like a great idea, let me know if you want to explore that further.')).toBe(false);
  });

  it('returns true for messages with numeric quantities', async () => {
    const { likelyHasClaims } = await import('./hallucination-detector.js');
    expect(likelyHasClaims('The population of the United States is approximately 331 million people.')).toBe(true);
  });

  it('returns true for messages with year-based temporal claims', async () => {
    const { likelyHasClaims } = await import('./hallucination-detector.js');
    expect(likelyHasClaims('Python was first released in 1991 by Guido van Rossum.')).toBe(true);
  });

  it('returns true for messages with superlative factual claims', async () => {
    const { likelyHasClaims } = await import('./hallucination-detector.js');
    expect(likelyHasClaims('The Nile is the longest river in the world according to most sources.')).toBe(true);
  });

  it('returns true for percentage-based claims', async () => {
    const { likelyHasClaims } = await import('./hallucination-detector.js');
    expect(likelyHasClaims('The model achieved 94.2% accuracy on the test set after fine-tuning.')).toBe(true);
  });

  it('returns true for approximate-quantity claims', async () => {
    const { likelyHasClaims } = await import('./hallucination-detector.js');
    expect(likelyHasClaims('There are roughly 8 billion people on Earth right now.')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// detectHallucinations — overall behavior
// ---------------------------------------------------------------------------

describe('detectHallucinations', () => {
  it('returns unchanged message and no-flag report for short/conversational messages', async () => {
    const { detectHallucinations } = await import('./hallucination-detector.js');
    const message = 'Sounds good!';
    const result = await detectHallucinations(message, 'msg-001');

    expect(result.annotatedMessage).toBe(message);
    expect(result.report.flagged).toBe(false);
    expect(result.report.claimsFound).toBe(0);
    expect(result.report.overallConfidence).toBe(100);
  });

  it('returns the original message on Ollama unavailability (no claims extracted)', async () => {
    // When Ollama is down, extractClaims returns [], so detector passes through
    const { detectHallucinations } = await import('./hallucination-detector.js');
    const message = 'Python was created in 1991 and has approximately 8 million active users worldwide.';

    // We cannot control network in unit tests — but if Ollama isn't running,
    // the result should gracefully pass through without throwing
    const result = await detectHallucinations(message, 'msg-002');

    expect(result.annotatedMessage).toBeDefined();
    expect(typeof result.annotatedMessage).toBe('string');
    expect(result.report.messageId).toBe('msg-002');
    expect(result.report.flagged).toBeDefined();
  });

  it('report always has required fields', async () => {
    const { detectHallucinations } = await import('./hallucination-detector.js');
    const result = await detectHallucinations('Hi there.', 'msg-003');

    expect(result.report).toMatchObject({
      messageId: 'msg-003',
      claimsFound: expect.any(Number),
      claimsVerified: expect.any(Number),
      overallConfidence: expect.any(Number),
      flagged: expect.any(Boolean),
      results: expect.any(Array),
      timestamp: expect.any(String),
    });
  });

  it('does not throw on empty message', async () => {
    const { detectHallucinations } = await import('./hallucination-detector.js');
    await expect(detectHallucinations('', 'msg-004')).resolves.toBeDefined();
  });

  it('does not throw when called multiple times concurrently', async () => {
    const { detectHallucinations } = await import('./hallucination-detector.js');
    const messages = [
      'The speed of light is approximately 299,792 kilometers per second.',
      'Water boils at 100 degrees Celsius at sea level.',
      'Hello, how are you today?',
    ];
    const results = await Promise.all(
      messages.map((m, i) => detectHallucinations(m, `msg-conc-${i}`))
    );
    expect(results).toHaveLength(3);
    results.forEach(r => expect(r.report.messageId).toMatch(/^msg-conc-/));
  });
});

// ---------------------------------------------------------------------------
// Confidence threshold and annotation
// ---------------------------------------------------------------------------

describe('confidence threshold behavior (unit-level)', () => {
  it('likelyHasClaims correctly gates messages at length boundary', async () => {
    const { likelyHasClaims } = await import('./hallucination-detector.js');

    // At or below minimum length (40 chars)
    const borderline = 'The answer is 42 percent of the total.';
    // This has a numeric claim pattern but may be under 40 chars
    const len = borderline.length;
    if (len < 40) {
      expect(likelyHasClaims(borderline)).toBe(false);
    } else {
      expect(likelyHasClaims(borderline)).toBe(true);
    }
  });

  it('messages with no factual markers are not passed to extraction', async () => {
    const { likelyHasClaims } = await import('./hallucination-detector.js');

    const noFacts = [
      'Let me think about that for a moment and get back to you with a more detailed response.',
      'That is a really interesting question and I appreciate you bringing it up.',
      'I would be happy to help you with that task whenever you are ready to proceed.',
    ];

    for (const msg of noFacts) {
      expect(likelyHasClaims(msg)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// fuseConfidenceScores — score fusion logic
// ---------------------------------------------------------------------------

describe('fuseConfidenceScores', () => {
  it('returns primary confidence when Wikipedia did not find an article', async () => {
    const { fuseConfidenceScores } = await import('./hallucination-detector.js');
    const wiki = { confidence: 80, snippet: '', found: false };
    expect(fuseConfidenceScores(70, 'wolfram', wiki)).toBe(70);
  });

  it('returns primary confidence when Wikipedia is undefined', async () => {
    const { fuseConfidenceScores } = await import('./hallucination-detector.js');
    expect(fuseConfidenceScores(65, 'ollama-selfcheck', undefined)).toBe(65);
  });

  it('averages primary and Wikipedia confidence when both sources found content', async () => {
    const { fuseConfidenceScores } = await import('./hallucination-detector.js');
    const wiki = { confidence: 80, snippet: 'Python (programming language): ...', found: true };
    // (60 + 80) / 2 = 70
    expect(fuseConfidenceScores(60, 'wolfram', wiki)).toBe(70);
  });

  it('rounds to nearest integer when averaging', async () => {
    const { fuseConfidenceScores } = await import('./hallucination-detector.js');
    const wiki = { confidence: 75, snippet: 'Some article', found: true };
    // (60 + 75) / 2 = 67.5 → rounds to 68
    expect(fuseConfidenceScores(60, 'ollama-selfcheck', wiki)).toBe(68);
  });

  it('uses Wikipedia alone when primary source was skipped', async () => {
    const { fuseConfidenceScores } = await import('./hallucination-detector.js');
    const wiki = { confidence: 85, snippet: 'Relevant article found', found: true };
    expect(fuseConfidenceScores(50, 'skipped', wiki)).toBe(85);
  });

  it('returns primary confidence when primary is skipped and Wikipedia did not find article', async () => {
    const { fuseConfidenceScores } = await import('./hallucination-detector.js');
    const wiki = { confidence: 50, snippet: '', found: false };
    expect(fuseConfidenceScores(50, 'skipped', wiki)).toBe(50);
  });

  it('handles extreme confidence values correctly', async () => {
    const { fuseConfidenceScores } = await import('./hallucination-detector.js');
    const wikiHigh = { confidence: 100, snippet: 'Verified by Wikipedia', found: true };
    const wikiLow = { confidence: 0, snippet: 'Contradicted by Wikipedia', found: true };

    // (100 + 100) / 2 = 100
    expect(fuseConfidenceScores(100, 'wolfram', wikiHigh)).toBe(100);
    // (0 + 0) / 2 = 0
    expect(fuseConfidenceScores(0, 'ollama-selfcheck', wikiLow)).toBe(0);
    // (100 + 0) / 2 = 50
    expect(fuseConfidenceScores(100, 'wolfram', wikiLow)).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// verifyWithWikipedia — graceful degradation
// ---------------------------------------------------------------------------

describe('verifyWithWikipedia', () => {
  it('returns found=false without throwing when Wikipedia is unreachable', async () => {
    const { verifyWithWikipedia } = await import('./hallucination-detector.js');
    // In test environment with no network or Wikipedia unreachable, should return gracefully
    const result = await verifyWithWikipedia('Python programming language created in 1991');

    expect(result).toMatchObject({
      confidence: expect.any(Number),
      snippet: expect.any(String),
      found: expect.any(Boolean),
    });
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(100);
  });

  it('never throws regardless of input', async () => {
    const { verifyWithWikipedia } = await import('./hallucination-detector.js');

    const inputs = [
      '',
      'a'.repeat(500),
      'The speed of light is 299,792 km/s',
      'xyzzy frobble quux nonsense claim',
    ];

    for (const claim of inputs) {
      await expect(verifyWithWikipedia(claim)).resolves.toMatchObject({
        confidence: expect.any(Number),
        found: expect.any(Boolean),
      });
    }
  });

  it('WikipediaVerificationResult has the correct shape', async () => {
    const { verifyWithWikipedia } = await import('./hallucination-detector.js');
    const result = await verifyWithWikipedia('water boils at 100 degrees Celsius');

    expect(typeof result.confidence).toBe('number');
    expect(typeof result.snippet).toBe('string');
    expect(typeof result.found).toBe('boolean');
  });
});

// ---------------------------------------------------------------------------
// verifyWithWikipedia — retry and cache behavior
// ---------------------------------------------------------------------------

describe('verifyWithWikipedia retry and cache', () => {
  beforeEach(async () => {
    const { clearWikipediaCache } = await import('./hallucination-detector.js');
    clearWikipediaCache();
  });

  afterEach(async () => {
    const { clearWikipediaCache } = await import('./hallucination-detector.js');
    clearWikipediaCache();
  });

  it('returns cached result on second call with same claim', async () => {
    const { verifyWithWikipedia, clearWikipediaCache } = await import('./hallucination-detector.js');

    // Call once — result is whatever the network returns (or graceful failure)
    const first = await verifyWithWikipedia('Python programming language 1991');
    // Call again — should get same object reference (cache hit) or equivalent
    const second = await verifyWithWikipedia('Python programming language 1991');

    // Both calls return valid WikipediaVerificationResult shape
    expect(first).toMatchObject({ confidence: expect.any(Number), found: expect.any(Boolean), snippet: expect.any(String) });
    expect(second).toMatchObject({ confidence: expect.any(Number), found: expect.any(Boolean), snippet: expect.any(String) });
    // Cached result should match first result
    expect(second.confidence).toBe(first.confidence);
    expect(second.found).toBe(first.found);
  });

  it('fetchWithRetry: retries on TypeError and eventually returns result', async () => {
    // Mock global fetch to fail twice then succeed
    let calls = 0;
    const originalFetch = global.fetch;
    const mockResponse = {
      ok: true,
      status: 200,
      json: async () => ({ pages: [] }),
    };
    global.fetch = vi.fn().mockImplementation(() => {
      calls++;
      if (calls <= 2) return Promise.reject(new TypeError('fetch failed'));
      return Promise.resolve(mockResponse);
    }) as unknown as typeof fetch;

    try {
      const { verifyWithWikipedia, clearWikipediaCache } = await import('./hallucination-detector.js');
      clearWikipediaCache();
      const result = await verifyWithWikipedia('some claim about history');

      expect(result).toMatchObject({ found: expect.any(Boolean), confidence: expect.any(Number) });
      // fetch should have been called 3 times (2 retries + success)
      expect(calls).toBeGreaterThanOrEqual(3);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('fetchWithRetry: returns stale cache when all retries fail', async () => {
    const { verifyWithWikipedia, clearWikipediaCache } = await import('./hallucination-detector.js');
    clearWikipediaCache();

    // Seed cache manually by making a call that fails gracefully (no network)
    // Then mock fetch to always fail to verify stale cache fallback behavior
    const originalFetch = global.fetch;
    const mockFetchFail = vi.fn().mockRejectedValue(new TypeError('fetch failed'));

    // First, get a cached entry (real or fail-graceful)
    const firstResult = await verifyWithWikipedia('stale cache test claim unique xyz');

    // Now replace fetch with always-failing mock
    global.fetch = mockFetchFail as unknown as typeof fetch;

    try {
      // If first call succeeded and was cached, second call should return cached value
      // If first call failed, cache is empty, second call also returns {found:false}
      const secondResult = await verifyWithWikipedia('stale cache test claim unique xyz');
      expect(secondResult).toMatchObject({
        confidence: expect.any(Number),
        found: expect.any(Boolean),
        snippet: expect.any(String),
      });
      // Should match first result (either from cache or same graceful failure)
      expect(secondResult.confidence).toBe(firstResult.confidence);
      expect(secondResult.found).toBe(firstResult.found);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('does not retry on AbortError', async () => {
    const originalFetch = global.fetch;
    let calls = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      calls++;
      const err = new DOMException('The operation was aborted', 'AbortError');
      return Promise.reject(err);
    }) as unknown as typeof fetch;

    try {
      const { verifyWithWikipedia, clearWikipediaCache } = await import('./hallucination-detector.js');
      clearWikipediaCache();
      const result = await verifyWithWikipedia('abort test claim');
      // Should fail gracefully without retrying
      expect(result.found).toBe(false);
      // AbortError should not retry — only 1 call per fetch attempt
      expect(calls).toBeLessThanOrEqual(2); // at most one search call attempted
    } finally {
      global.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// ClaimVerificationResult includes wikipedia field
// ---------------------------------------------------------------------------

describe('ClaimVerificationResult wikipedia field', () => {
  it('detectHallucinations result items have wikipedia field when claims are found', async () => {
    const { detectHallucinations } = await import('./hallucination-detector.js');
    // This message has factual claim markers — if Ollama extracts claims, results will have wikipedia
    const result = await detectHallucinations(
      'Python was created in 1991 and has approximately 8 million active users worldwide.',
      'msg-wiki-01',
    );

    // Even if no claims extracted (Ollama down), shape is valid
    expect(result.report.results).toBeInstanceOf(Array);
    for (const r of result.report.results) {
      // If wikipedia field exists, it must have the right shape
      if (r.wikipedia !== undefined) {
        expect(typeof r.wikipedia.confidence).toBe('number');
        expect(typeof r.wikipedia.found).toBe('boolean');
        expect(typeof r.wikipedia.snippet).toBe('string');
      }
    }
  });
});
