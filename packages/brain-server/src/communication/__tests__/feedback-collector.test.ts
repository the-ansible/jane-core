/**
 * Tests for feedback-collector.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Mock the filesystem so tests don't write real files
// ---------------------------------------------------------------------------

vi.mock('node:fs');

const mockedFs = vi.mocked(fs);

// Simulate an in-memory store for appendFileSync + readFileSync
let logStore: string[] = [];

beforeEach(() => {
  logStore = [];
  vi.clearAllMocks();

  mockedFs.existsSync.mockReturnValue(true);
  mockedFs.mkdirSync.mockReturnValue(undefined as any);
  mockedFs.appendFileSync.mockImplementation((_path, data) => {
    logStore.push(String(data));
  });
  mockedFs.readFileSync.mockImplementation(() => logStore.join(''));
});

afterEach(() => {
  vi.resetAllMocks();
});

// Import AFTER mocks are configured
const {
  recordFeedback,
  readAllFeedback,
  getFeedbackForMessage,
  getFeedbackSummary,
} = await import('../feedback-collector.js');

// ---------------------------------------------------------------------------
// recordFeedback
// ---------------------------------------------------------------------------

describe('recordFeedback', () => {
  it('returns a ClaimFeedback entry with a generated feedbackId', () => {
    const entry = recordFeedback({
      messageId: 'msg-001',
      claim: 'The Earth is 4.5 billion years old',
      assignedConfidence: 90,
      verdict: 'confirmed',
    });

    expect(entry.feedbackId).toMatch(/^fb-/);
    expect(entry.messageId).toBe('msg-001');
    expect(entry.claim).toBe('The Earth is 4.5 billion years old');
    expect(entry.assignedConfidence).toBe(90);
    expect(entry.assignedBadge).toBe('✅');
    expect(entry.verdict).toBe('confirmed');
    expect(entry.submittedAt).toBeTruthy();
  });

  it('assigns ✅ badge for confidence ≥ 80', () => {
    const entry = recordFeedback({ messageId: 'm', claim: 'c', assignedConfidence: 80, verdict: 'confirmed' });
    expect(entry.assignedBadge).toBe('✅');
  });

  it('assigns ⚠️ badge for confidence 60–79', () => {
    const entry = recordFeedback({ messageId: 'm', claim: 'c', assignedConfidence: 65, verdict: 'confirmed' });
    expect(entry.assignedBadge).toBe('⚠️');
  });

  it('assigns 🚨 badge for confidence < 60', () => {
    const entry = recordFeedback({ messageId: 'm', claim: 'c', assignedConfidence: 40, verdict: 'corrected', correction: 'wrong' });
    expect(entry.assignedBadge).toBe('🚨');
  });

  it('stores correction and note', () => {
    const entry = recordFeedback({
      messageId: 'msg-002',
      claim: 'Water boils at 90°C at sea level',
      assignedConfidence: 55,
      verdict: 'corrected',
      correction: 'Water boils at 100°C at sea level',
      note: 'Easily verifiable physics',
    });

    expect(entry.correction).toBe('Water boils at 100°C at sea level');
    expect(entry.note).toBe('Easily verifiable physics');
  });

  it('writes a NDJSON line to the log', () => {
    recordFeedback({ messageId: 'msg-003', claim: 'claim', assignedConfidence: 75, verdict: 'disputed', correction: 'not right' });
    expect(mockedFs.appendFileSync).toHaveBeenCalledOnce();
    const written = String(mockedFs.appendFileSync.mock.calls[0][1]);
    const parsed = JSON.parse(written.trim());
    expect(parsed.messageId).toBe('msg-003');
    expect(parsed.verdict).toBe('disputed');
  });

  it('sets default source to "api" if not provided', () => {
    const entry = recordFeedback({ messageId: 'm', claim: 'c', assignedConfidence: 85, verdict: 'confirmed' });
    expect(entry.source).toBe('api');
  });

  it('uses provided source if given', () => {
    const entry = recordFeedback({ messageId: 'm', claim: 'c', assignedConfidence: 85, verdict: 'confirmed', source: 'slack' });
    expect(entry.source).toBe('slack');
  });

  it('does not throw if appendFileSync fails', () => {
    mockedFs.appendFileSync.mockImplementation(() => { throw new Error('disk full'); });
    expect(() =>
      recordFeedback({ messageId: 'm', claim: 'c', assignedConfidence: 90, verdict: 'confirmed' })
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// readAllFeedback
// ---------------------------------------------------------------------------

describe('readAllFeedback', () => {
  it('returns empty array if file does not exist', () => {
    mockedFs.existsSync.mockReturnValue(false);
    expect(readAllFeedback()).toEqual([]);
  });

  it('returns parsed entries', () => {
    recordFeedback({ messageId: 'x', claim: 'a', assignedConfidence: 90, verdict: 'confirmed' });
    recordFeedback({ messageId: 'x', claim: 'b', assignedConfidence: 50, verdict: 'corrected', correction: 'fix' });

    const all = readAllFeedback();
    expect(all).toHaveLength(2);
    expect(all[0].claim).toBe('a');
    expect(all[1].claim).toBe('b');
  });

  it('returns empty array on JSON parse error', () => {
    mockedFs.readFileSync.mockReturnValue('not-valid-json\n');
    expect(readAllFeedback()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getFeedbackForMessage
// ---------------------------------------------------------------------------

describe('getFeedbackForMessage', () => {
  it('returns only entries matching the given messageId', () => {
    recordFeedback({ messageId: 'msg-A', claim: 'claim1', assignedConfidence: 90, verdict: 'confirmed' });
    recordFeedback({ messageId: 'msg-B', claim: 'claim2', assignedConfidence: 70, verdict: 'disputed', correction: 'nope' });
    recordFeedback({ messageId: 'msg-A', claim: 'claim3', assignedConfidence: 80, verdict: 'confirmed' });

    const results = getFeedbackForMessage('msg-A');
    expect(results).toHaveLength(2);
    expect(results.every(e => e.messageId === 'msg-A')).toBe(true);
  });

  it('returns empty array for unknown messageId', () => {
    expect(getFeedbackForMessage('nope')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getFeedbackSummary
// ---------------------------------------------------------------------------

describe('getFeedbackSummary', () => {
  it('returns zeroed summary when no feedback exists', () => {
    mockedFs.existsSync.mockReturnValue(false);
    const summary = getFeedbackSummary();
    expect(summary.totalEntries).toBe(0);
    expect(summary.accuracyRate).toBe(0);
  });

  it('calculates accuracy rate correctly', () => {
    // 2 confirmed, 1 corrected
    recordFeedback({ messageId: 'm', claim: 'a', assignedConfidence: 90, verdict: 'confirmed' });
    recordFeedback({ messageId: 'm', claim: 'b', assignedConfidence: 85, verdict: 'confirmed' });
    recordFeedback({ messageId: 'm', claim: 'c', assignedConfidence: 55, verdict: 'corrected', correction: 'fix' });

    const summary = getFeedbackSummary();
    expect(summary.totalEntries).toBe(3);
    expect(summary.confirmedCount).toBe(2);
    expect(summary.correctedCount).toBe(1);
    expect(summary.disputedCount).toBe(0);
    expect(summary.accuracyRate).toBeCloseTo(2 / 3, 2);
  });

  it('groups byBadge correctly', () => {
    recordFeedback({ messageId: 'm', claim: 'a', assignedConfidence: 90, verdict: 'confirmed' }); // ✅
    recordFeedback({ messageId: 'm', claim: 'b', assignedConfidence: 65, verdict: 'disputed', correction: 'nope' }); // ⚠️
    recordFeedback({ messageId: 'm', claim: 'c', assignedConfidence: 30, verdict: 'corrected', correction: 'fix' }); // 🚨

    const summary = getFeedbackSummary();
    expect(summary.byBadge['✅'].confirmed).toBe(1);
    expect(summary.byBadge['⚠️'].disputed).toBe(1);
    expect(summary.byBadge['🚨'].corrected).toBe(1);
  });

  it('computes average confidence on confirmed vs corrected', () => {
    recordFeedback({ messageId: 'm', claim: 'a', assignedConfidence: 90, verdict: 'confirmed' });
    recordFeedback({ messageId: 'm', claim: 'b', assignedConfidence: 80, verdict: 'confirmed' });
    recordFeedback({ messageId: 'm', claim: 'c', assignedConfidence: 50, verdict: 'corrected', correction: 'fix' });
    recordFeedback({ messageId: 'm', claim: 'd', assignedConfidence: 40, verdict: 'corrected', correction: 'fix' });

    const summary = getFeedbackSummary();
    expect(summary.avgConfidenceOnConfirmed).toBeCloseTo(85, 0);
    expect(summary.avgConfidenceOnCorrected).toBeCloseTo(45, 0);
  });
});
