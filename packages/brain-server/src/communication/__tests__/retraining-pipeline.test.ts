/**
 * Tests for retraining-pipeline.ts
 *
 * Tests cover:
 *   - Badge accuracy stat computation
 *   - Threshold calibration logic (both directions)
 *   - Correction example extraction and capping
 *   - Confirmed-correct claim extraction and deduplication
 *   - msUntilNextScheduledRun scheduling helper
 *   - runRetrainingPipeline integration (filesystem mocked)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';

// ---------------------------------------------------------------------------
// Mock filesystem and feedback-collector
// ---------------------------------------------------------------------------

vi.mock('node:fs');
vi.mock('../feedback-collector.js', () => ({
  readAllFeedback: vi.fn(),
}));

const mockedFs = vi.mocked(fs);
import { readAllFeedback } from '../feedback-collector.js';
const mockedReadAllFeedback = vi.mocked(readAllFeedback);

// Store for written calibration content
let writtenContent = '';

beforeEach(() => {
  writtenContent = '';
  vi.clearAllMocks();

  mockedFs.existsSync.mockReturnValue(false);
  mockedFs.mkdirSync.mockReturnValue(undefined as any);
  mockedFs.writeFileSync.mockImplementation((_path, data) => {
    writtenContent = String(data);
  });
  mockedFs.renameSync.mockReturnValue(undefined as any);
  mockedFs.readFileSync.mockReturnValue('');
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Imports under test (after mocks are set up)
// ---------------------------------------------------------------------------

import {
  computeBadgeStats,
  calibrateThresholds,
  extractCorrectionExamples,
  extractConfirmedCorrectClaims,
  msUntilNextScheduledRun,
  runRetrainingPipeline,
  type BadgeAccuracyStats,
  type ThresholdCalibration,
} from '../retraining-pipeline.js';

import type { ClaimFeedback } from '../feedback-collector.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeFeedback(overrides: Partial<ClaimFeedback> = {}): ClaimFeedback {
  return {
    feedbackId: 'fb-test',
    messageId: 'msg-001',
    claim: 'Water boils at 100°C at sea level',
    assignedBadge: '✅',
    assignedConfidence: 85,
    verdict: 'confirmed',
    submittedAt: '2026-03-10T10:00:00.000Z',
    source: 'api',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// computeBadgeStats
// ---------------------------------------------------------------------------

describe('computeBadgeStats', () => {
  it('returns zero counts for all badges when no entries', () => {
    const stats = computeBadgeStats([]);
    expect(stats).toHaveLength(3);
    for (const s of stats) {
      expect(s.totalFeedback).toBe(0);
      expect(s.accuracyRate).toBe(0);
    }
  });

  it('correctly counts confirmed/corrected/disputed per badge', () => {
    const entries: ClaimFeedback[] = [
      makeFeedback({ assignedBadge: '✅', verdict: 'confirmed' }),
      makeFeedback({ assignedBadge: '✅', verdict: 'confirmed' }),
      makeFeedback({ assignedBadge: '✅', verdict: 'corrected', claim: 'Other claim' }),
      makeFeedback({ assignedBadge: '⚠️', verdict: 'disputed' }),
      makeFeedback({ assignedBadge: '🚨', verdict: 'corrected', claim: 'Flagged claim' }),
    ];

    const stats = computeBadgeStats(entries);
    const verified = stats.find(s => s.badge === '✅')!;
    const lowConf = stats.find(s => s.badge === '⚠️')!;
    const critical = stats.find(s => s.badge === '🚨')!;

    expect(verified.confirmed).toBe(2);
    expect(verified.corrected).toBe(1);
    expect(verified.totalFeedback).toBe(3);
    expect(verified.accuracyRate).toBeCloseTo(2 / 3, 2);

    expect(lowConf.disputed).toBe(1);
    expect(lowConf.totalFeedback).toBe(1);

    expect(critical.corrected).toBe(1);
    expect(critical.totalFeedback).toBe(1);
    expect(critical.accuracyRate).toBe(0);
  });

  it('computes accuracy rate as confirmed/total', () => {
    const entries = [
      makeFeedback({ assignedBadge: '✅', verdict: 'confirmed' }),
      makeFeedback({ assignedBadge: '✅', verdict: 'confirmed', claim: 'c2' }),
      makeFeedback({ assignedBadge: '✅', verdict: 'confirmed', claim: 'c3' }),
      makeFeedback({ assignedBadge: '✅', verdict: 'corrected', claim: 'c4' }),
    ];
    const stats = computeBadgeStats(entries);
    const verified = stats.find(s => s.badge === '✅')!;
    expect(verified.accuracyRate).toBeCloseTo(0.75, 2);
  });
});

// ---------------------------------------------------------------------------
// calibrateThresholds
// ---------------------------------------------------------------------------

describe('calibrateThresholds', () => {
  const defaults: ThresholdCalibration = {
    verifiedThreshold: 80,
    lowConfidenceThreshold: 60,
  };

  function makeStats(
    badge: '✅' | '⚠️' | '🚨',
    total: number,
    confirmed: number,
    corrected: number,
    disputed: number,
  ): BadgeAccuracyStats {
    return {
      badge,
      totalFeedback: total,
      confirmed,
      corrected,
      disputed,
      accuracyRate: total === 0 ? 0 : confirmed / total,
    };
  }

  it('does not adjust when fewer than MIN_FEEDBACK_FOR_CALIBRATION entries', () => {
    const badgeStats = [
      makeStats('✅', 3, 1, 1, 1), // below threshold of 5
      makeStats('⚠️', 2, 0, 1, 1),
      makeStats('🚨', 0, 0, 0, 0),
    ];
    const result = calibrateThresholds(badgeStats, defaults);
    expect(result).toEqual(defaults);
  });

  it('raises verifiedThreshold when ✅ accuracy is low (<70%)', () => {
    const badgeStats = [
      makeStats('✅', 10, 5, 4, 1), // accuracy = 0.5 → below 70%
      makeStats('⚠️', 0, 0, 0, 0),
      makeStats('🚨', 0, 0, 0, 0),
    ];
    const result = calibrateThresholds(badgeStats, defaults);
    expect(result.verifiedThreshold).toBe(85); // raised by 5
    expect(result.lowConfidenceThreshold).toBe(60); // unchanged
  });

  it('lowers verifiedThreshold when ✅ accuracy is high (>90%)', () => {
    const badgeStats = [
      makeStats('✅', 10, 10, 0, 0), // accuracy = 1.0 → above 90%
      makeStats('⚠️', 0, 0, 0, 0),
      makeStats('🚨', 0, 0, 0, 0),
    ];
    const result = calibrateThresholds(badgeStats, defaults);
    expect(result.verifiedThreshold).toBe(77); // lowered by 3
  });

  it('does not lower verifiedThreshold below 70', () => {
    const low: ThresholdCalibration = { verifiedThreshold: 71, lowConfidenceThreshold: 60 };
    const badgeStats = [
      makeStats('✅', 10, 10, 0, 0),
      makeStats('⚠️', 0, 0, 0, 0),
      makeStats('🚨', 0, 0, 0, 0),
    ];
    const result = calibrateThresholds(badgeStats, low);
    expect(result.verifiedThreshold).toBe(70);
  });

  it('does not raise verifiedThreshold above 90', () => {
    const high: ThresholdCalibration = { verifiedThreshold: 88, lowConfidenceThreshold: 60 };
    const badgeStats = [
      makeStats('✅', 10, 0, 10, 0), // very low accuracy
      makeStats('⚠️', 0, 0, 0, 0),
      makeStats('🚨', 0, 0, 0, 0),
    ];
    const result = calibrateThresholds(badgeStats, high);
    expect(result.verifiedThreshold).toBe(90);
  });

  it('lowers lowConfidenceThreshold when ⚠️ sensitivityRate > 70%', () => {
    // corrected + disputed / total = 8/10 = 0.8 → too many flags are wrong → lower threshold
    const badgeStats = [
      makeStats('✅', 0, 0, 0, 0),
      makeStats('⚠️', 10, 2, 5, 3),
      makeStats('🚨', 0, 0, 0, 0),
    ];
    const result = calibrateThresholds(badgeStats, defaults);
    expect(result.lowConfidenceThreshold).toBe(55); // lowered by 5
  });

  it('raises lowConfidenceThreshold when ⚠️ sensitivityRate < 30%', () => {
    // corrected + disputed / total = 2/10 = 0.2 → too few flags triggered → raise threshold
    const badgeStats = [
      makeStats('✅', 0, 0, 0, 0),
      makeStats('⚠️', 10, 8, 1, 1),
      makeStats('🚨', 0, 0, 0, 0),
    ];
    const result = calibrateThresholds(badgeStats, defaults);
    expect(result.lowConfidenceThreshold).toBe(65); // raised by 5
  });

  it('returns unchanged thresholds when accuracy is in normal range', () => {
    const badgeStats = [
      makeStats('✅', 10, 8, 1, 1), // accuracy = 0.8 — in range (70–90%)
      makeStats('⚠️', 10, 5, 3, 2), // sensitivity = 0.5 — in range (30–70%)
      makeStats('🚨', 0, 0, 0, 0),
    ];
    const result = calibrateThresholds(badgeStats, defaults);
    expect(result).toEqual(defaults);
  });
});

// ---------------------------------------------------------------------------
// extractCorrectionExamples
// ---------------------------------------------------------------------------

describe('extractCorrectionExamples', () => {
  it('returns empty array when no corrected verdicts', () => {
    const entries = [
      makeFeedback({ verdict: 'confirmed' }),
      makeFeedback({ verdict: 'disputed', claim: 'c2' }),
    ];
    expect(extractCorrectionExamples(entries)).toHaveLength(0);
  });

  it('only includes corrected entries with a correction string', () => {
    const entries = [
      makeFeedback({ verdict: 'corrected', correction: 'The correct answer is X', assignedConfidence: 85 }),
      makeFeedback({ verdict: 'corrected', claim: 'Other', correction: undefined }), // no correction text
    ];
    const result = extractCorrectionExamples(entries);
    expect(result).toHaveLength(1);
    expect(result[0].correction).toBe('The correct answer is X');
  });

  it('classifies under-flagged when assignedConfidence >= 80', () => {
    const entries = [
      makeFeedback({ verdict: 'corrected', correction: 'Correct answer', assignedConfidence: 85 }),
    ];
    const result = extractCorrectionExamples(entries);
    expect(result[0].errorDirection).toBe('under-flagged');
  });

  it('classifies over-flagged when assignedConfidence < 80', () => {
    const entries = [
      makeFeedback({ verdict: 'corrected', correction: 'Correct answer', assignedConfidence: 55, assignedBadge: '🚨' }),
    ];
    const result = extractCorrectionExamples(entries);
    expect(result[0].errorDirection).toBe('over-flagged');
  });

  it('sorts by most recent first and caps at MAX_EXAMPLES_TO_KEEP', () => {
    // Create 55 examples with different timestamps
    const entries: ClaimFeedback[] = Array.from({ length: 55 }, (_, i) => makeFeedback({
      claim: `Claim ${i}`,
      verdict: 'corrected',
      correction: `Correction ${i}`,
      submittedAt: new Date(1000000 + i * 1000).toISOString(),
    }));

    const result = extractCorrectionExamples(entries);
    // Default cap is 50
    expect(result.length).toBeLessThanOrEqual(50);
    // Most recent first
    expect(result[0].capturedAt > result[result.length - 1].capturedAt).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// extractConfirmedCorrectClaims
// ---------------------------------------------------------------------------

describe('extractConfirmedCorrectClaims', () => {
  it('returns empty array when no confirmed ✅ entries', () => {
    const entries = [
      makeFeedback({ verdict: 'corrected' }),
      makeFeedback({ verdict: 'disputed', assignedBadge: '⚠️' }),
    ];
    expect(extractConfirmedCorrectClaims(entries)).toHaveLength(0);
  });

  it('only includes confirmed ✅ entries', () => {
    const entries = [
      makeFeedback({ verdict: 'confirmed', assignedBadge: '✅', claim: 'Good claim' }),
      makeFeedback({ verdict: 'confirmed', assignedBadge: '⚠️', claim: 'Not ✅' }),
      makeFeedback({ verdict: 'corrected', assignedBadge: '✅', claim: 'Corrected ✅' }),
    ];
    const result = extractConfirmedCorrectClaims(entries);
    expect(result).toEqual(['Good claim']);
  });

  it('deduplicates repeated claims', () => {
    const entries = [
      makeFeedback({ verdict: 'confirmed', assignedBadge: '✅', claim: 'Same claim', submittedAt: '2026-03-10T12:00:00Z' }),
      makeFeedback({ verdict: 'confirmed', assignedBadge: '✅', claim: 'Same claim', submittedAt: '2026-03-09T10:00:00Z' }),
    ];
    const result = extractConfirmedCorrectClaims(entries);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe('Same claim');
  });
});

// ---------------------------------------------------------------------------
// msUntilNextScheduledRun
// ---------------------------------------------------------------------------

describe('msUntilNextScheduledRun', () => {
  it('returns ms until 02:00 UTC when current time is before 02:00 UTC', () => {
    // 01:00 UTC → 1 hour until 02:00
    const now = new Date('2026-03-10T01:00:00.000Z');
    const ms = msUntilNextScheduledRun(now);
    expect(ms).toBe(60 * 60 * 1000); // 1 hour
  });

  it('schedules for next day when current time is past 02:00 UTC', () => {
    // 03:00 UTC → 23 hours until next 02:00 UTC
    const now = new Date('2026-03-10T03:00:00.000Z');
    const ms = msUntilNextScheduledRun(now);
    expect(ms).toBe(23 * 60 * 60 * 1000); // 23 hours
  });

  it('always returns a positive number', () => {
    for (let h = 0; h < 24; h++) {
      const now = new Date(`2026-03-10T${String(h).padStart(2, '0')}:30:00.000Z`);
      expect(msUntilNextScheduledRun(now)).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// runRetrainingPipeline (integration, fs mocked)
// ---------------------------------------------------------------------------

describe('runRetrainingPipeline', () => {
  beforeEach(() => {
    // Provide a fresh feedback set for each test
    mockedReadAllFeedback.mockReturnValue([
      makeFeedback({ verdict: 'confirmed', assignedBadge: '✅', claim: 'Confirmed claim' }),
      makeFeedback({ verdict: 'corrected', assignedBadge: '⚠️', claim: 'Wrong claim', correction: 'Right answer', assignedConfidence: 55 }),
    ]);
    mockedFs.existsSync.mockReturnValue(false);
    mockedFs.readFileSync.mockReturnValue('');
  });

  it('returns a result with correct counts', async () => {
    const result = await runRetrainingPipeline();
    expect(result.feedbackEntriesRead).toBe(2);
    expect(result.correctionExamplesExtracted).toBe(1);
    expect(result.confirmedClaimsIndexed).toBe(1);
    expect(result.error).toBeUndefined();
  });

  it('writes the calibration file', async () => {
    await runRetrainingPipeline();
    // writeFileSync should have been called with calibration content
    expect(mockedFs.writeFileSync).toHaveBeenCalled();
    const callArgs = mockedFs.writeFileSync.mock.calls[0];
    expect(String(callArgs[0])).toContain('.tmp');
    const parsed = JSON.parse(String(callArgs[1]));
    expect(parsed.generatedAt).toBeDefined();
    expect(parsed.totalFeedbackProcessed).toBe(2);
    expect(parsed.correctionExamples).toHaveLength(1);
    expect(parsed.confirmedCorrectClaims).toContain('Confirmed claim');
  });

  it('renames tmp file to final path', async () => {
    await runRetrainingPipeline();
    expect(mockedFs.renameSync).toHaveBeenCalledWith(
      expect.stringContaining('.tmp'),
      expect.not.stringContaining('.tmp'),
    );
  });

  it('handles empty feedback log gracefully', async () => {
    mockedReadAllFeedback.mockReturnValue([]);
    const result = await runRetrainingPipeline();
    expect(result.feedbackEntriesRead).toBe(0);
    expect(result.correctionExamplesExtracted).toBe(0);
    expect(result.error).toBeUndefined();
    // Calibration should still be written
    expect(mockedFs.writeFileSync).toHaveBeenCalled();
  });

  it('completes within reasonable time', async () => {
    const start = Date.now();
    await runRetrainingPipeline();
    expect(Date.now() - start).toBeLessThan(2000);
  });
});
