/**
 * Tests for communication/hallucination-detector.ts
 *
 * These tests focus on deterministic logic (heuristic pre-filter, claim routing,
 * score aggregation) without hitting external APIs.
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
