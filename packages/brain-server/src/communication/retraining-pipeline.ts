/**
 * Retraining Pipeline — daily automated improvement of hallucination detection.
 *
 * Reads logs/confidence-feedback.ndjson, extracts patterns from user corrections,
 * and writes logs/hallucination-calibration.json. The hallucination-detector
 * reads this calibration file at inference time to:
 *
 *   1. Use adjusted confidence thresholds (per badge tier, based on observed accuracy)
 *   2. Inject few-shot correction examples into Ollama self-check prompts
 *   3. Skip re-verification of claims already in the "confirmed correct" cache
 *
 * Schedule: daily at RETRAINING_HOUR_UTC (default 02:00 UTC), configurable.
 * Also exposes `runRetrainingPipeline()` for manual/API-triggered runs.
 *
 * Output: logs/hallucination-calibration.json
 * Input:  logs/confidence-feedback.ndjson (written by feedback-collector.ts)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAllFeedback, type ClaimFeedback } from './feedback-collector.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single training example derived from user correction feedback. */
export interface CorrectionExample {
  /** The original claim that was flagged */
  claim: string;
  /** The badge the system assigned (what it thought) */
  assignedBadge: '✅' | '⚠️' | '🚨';
  /** The confidence score that was assigned */
  assignedConfidence: number;
  /** What the user said the correct answer is */
  correction: string;
  /**
   * Whether the system over-flagged (assigned low confidence but claim was correct)
   * or under-flagged (assigned high confidence but claim was wrong).
   */
  errorDirection: 'over-flagged' | 'under-flagged';
  /** When this example was captured */
  capturedAt: string;
}

/** Per-badge accuracy stats derived from feedback. */
export interface BadgeAccuracyStats {
  badge: '✅' | '⚠️' | '🚨';
  totalFeedback: number;
  confirmed: number;
  corrected: number;
  disputed: number;
  /** confirmed / (confirmed + corrected + disputed), 0–1 */
  accuracyRate: number;
}

/** Calibrated thresholds derived from observed accuracy. */
export interface ThresholdCalibration {
  /**
   * Minimum confidence score to assign ✅ badge.
   * Default 80. Lowered if ✅ badges are frequently confirmed.
   * Raised if ✅ badges are frequently corrected.
   */
  verifiedThreshold: number;
  /**
   * Minimum confidence score to assign ⚠️ badge.
   * Default 60. Adjusted based on ⚠️ accuracy.
   */
  lowConfidenceThreshold: number;
}

/** Full calibration file written to logs/hallucination-calibration.json */
export interface HallucinationCalibration {
  /** When this calibration was computed */
  generatedAt: string;
  /** How many feedback entries were processed */
  totalFeedbackProcessed: number;
  /** Per-badge accuracy statistics */
  badgeStats: BadgeAccuracyStats[];
  /** Calibrated confidence thresholds */
  thresholds: ThresholdCalibration;
  /**
   * Few-shot correction examples for Ollama prompt injection.
   * Capped at MAX_EXAMPLES_TO_KEEP most-recent examples.
   */
  correctionExamples: CorrectionExample[];
  /**
   * Claims the system correctly identified with high confidence.
   * Used for quick-path: skip re-verification of known-good claims.
   */
  confirmedCorrectClaims: string[];
}

/** Result of a pipeline run */
export interface RetrainingResult {
  startedAt: string;
  completedAt: string;
  feedbackEntriesRead: number;
  correctionExamplesExtracted: number;
  confirmedClaimsIndexed: number;
  thresholdsAdjusted: boolean;
  calibrationPath: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const RETRAINING_HOUR_UTC = parseInt(process.env.RETRAINING_HOUR_UTC ?? '2', 10);
const MAX_EXAMPLES_TO_KEEP = parseInt(process.env.RETRAINING_MAX_EXAMPLES ?? '50', 10);
const MAX_CONFIRMED_CLAIMS = parseInt(process.env.RETRAINING_MAX_CONFIRMED ?? '200', 10);

/** Default confidence thresholds (baseline before any calibration). */
const DEFAULT_VERIFIED_THRESHOLD = 80;
const DEFAULT_LOW_CONF_THRESHOLD = 60;

/**
 * If the system has this many or fewer feedback entries for a badge,
 * don't adjust that badge's threshold (not enough signal).
 */
const MIN_FEEDBACK_FOR_CALIBRATION = 5;

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.resolve(__dirname, '../../logs');
const CALIBRATION_FILE = path.join(LOG_DIR, 'hallucination-calibration.json');

// ---------------------------------------------------------------------------
// Scheduler state
// ---------------------------------------------------------------------------

let retrainingTimer: ReturnType<typeof setTimeout> | null = null;
let isRunning = false;
let lastRunAt: Date | null = null;
let lastRunResult: RetrainingResult | null = null;

// ---------------------------------------------------------------------------
// Core pipeline logic
// ---------------------------------------------------------------------------

/**
 * Compute per-badge accuracy stats from all feedback entries.
 */
export function computeBadgeStats(entries: ClaimFeedback[]): BadgeAccuracyStats[] {
  const badges: Array<'✅' | '⚠️' | '🚨'> = ['✅', '⚠️', '🚨'];

  return badges.map((badge) => {
    const subset = entries.filter((e) => e.assignedBadge === badge);
    const confirmed = subset.filter((e) => e.verdict === 'confirmed').length;
    const corrected = subset.filter((e) => e.verdict === 'corrected').length;
    const disputed = subset.filter((e) => e.verdict === 'disputed').length;
    const total = subset.length;
    const accuracyRate = total === 0 ? 0 : confirmed / total;

    return { badge, totalFeedback: total, confirmed, corrected, disputed, accuracyRate };
  });
}

/**
 * Calibrate confidence thresholds based on observed badge accuracy.
 *
 * Adjustment logic (per badge, only when enough feedback exists):
 *   - ✅ badges: if accuracy < 70%, raise verifiedThreshold by up to 5 points
 *                 if accuracy > 90%, lower verifiedThreshold by up to 3 points
 *   - ⚠️ badges: if disputed+corrected > 70%, lower lowConfidenceThreshold
 *                 (the flag is too sensitive — we're over-flagging)
 *                 if disputed+corrected < 30%, raise lowConfidenceThreshold
 *                 (the flag isn't sensitive enough — we're under-flagging)
 */
export function calibrateThresholds(
  badgeStats: BadgeAccuracyStats[],
  current: ThresholdCalibration,
): ThresholdCalibration {
  let { verifiedThreshold, lowConfidenceThreshold } = current;

  const verified = badgeStats.find((s) => s.badge === '✅');
  const lowConf = badgeStats.find((s) => s.badge === '⚠️');

  // Calibrate verifiedThreshold from ✅ accuracy
  if (verified && verified.totalFeedback >= MIN_FEEDBACK_FOR_CALIBRATION) {
    if (verified.accuracyRate < 0.70) {
      // System is over-confident — ✅ claims are wrong too often → raise threshold
      verifiedThreshold = Math.min(90, verifiedThreshold + 5);
    } else if (verified.accuracyRate > 0.90) {
      // System is under-confident — ✅ claims are correct — we can lower threshold
      verifiedThreshold = Math.max(70, verifiedThreshold - 3);
    }
  }

  // Calibrate lowConfidenceThreshold from ⚠️ behavior
  if (lowConf && lowConf.totalFeedback >= MIN_FEEDBACK_FOR_CALIBRATION) {
    const sensitivityRate = (lowConf.corrected + lowConf.disputed) / lowConf.totalFeedback;
    if (sensitivityRate > 0.70) {
      // Too many ⚠️ flags are wrong — lower threshold to make flagging harder
      lowConfidenceThreshold = Math.max(40, lowConfidenceThreshold - 5);
    } else if (sensitivityRate < 0.30) {
      // Too few ⚠️ flags triggered — raise threshold to catch more
      lowConfidenceThreshold = Math.min(75, lowConfidenceThreshold + 5);
    }
  }

  const adjusted =
    verifiedThreshold !== current.verifiedThreshold ||
    lowConfidenceThreshold !== current.lowConfidenceThreshold;

  if (adjusted) {
    log('info', 'Thresholds calibrated', {
      previous: current,
      adjusted: { verifiedThreshold, lowConfidenceThreshold },
    });
  }

  return { verifiedThreshold, lowConfidenceThreshold };
}

/**
 * Extract correction examples from entries where user provided a correction.
 * Only 'corrected' verdicts produce training examples (explicit right-answer signal).
 */
export function extractCorrectionExamples(entries: ClaimFeedback[]): CorrectionExample[] {
  return entries
    .filter((e) => e.verdict === 'corrected' && e.correction)
    .map((e): CorrectionExample => ({
      claim: e.claim,
      assignedBadge: e.assignedBadge,
      assignedConfidence: e.assignedConfidence,
      correction: e.correction!,
      errorDirection: e.assignedConfidence >= 80 ? 'under-flagged' : 'over-flagged',
      capturedAt: e.submittedAt,
    }))
    // Sort by most recent first, then cap
    .sort((a, b) => new Date(b.capturedAt).getTime() - new Date(a.capturedAt).getTime())
    .slice(0, MAX_EXAMPLES_TO_KEEP);
}

/**
 * Extract claims that were confirmed correct with high confidence (✅, confirmed).
 * These form a short-circuit cache — skip re-verification of known-good claims.
 */
export function extractConfirmedCorrectClaims(entries: ClaimFeedback[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  // Most recent first
  const sorted = [...entries].sort(
    (a, b) => new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime(),
  );

  for (const entry of sorted) {
    if (
      entry.verdict === 'confirmed' &&
      entry.assignedBadge === '✅' &&
      !seen.has(entry.claim)
    ) {
      seen.add(entry.claim);
      result.push(entry.claim);
      if (result.length >= MAX_CONFIRMED_CLAIMS) break;
    }
  }

  return result;
}

/**
 * Load the existing calibration (to preserve thresholds between runs).
 * Returns default thresholds if no calibration file exists yet.
 */
function loadExistingCalibration(): ThresholdCalibration {
  try {
    if (fs.existsSync(CALIBRATION_FILE)) {
      const raw = fs.readFileSync(CALIBRATION_FILE, 'utf8');
      const parsed = JSON.parse(raw) as Partial<HallucinationCalibration>;
      if (parsed.thresholds) return parsed.thresholds;
    }
  } catch {
    // Fall through to defaults
  }
  return {
    verifiedThreshold: DEFAULT_VERIFIED_THRESHOLD,
    lowConfidenceThreshold: DEFAULT_LOW_CONF_THRESHOLD,
  };
}

/**
 * Write the calibration file atomically (write to temp, then rename).
 */
function writeCalibration(calibration: HallucinationCalibration): void {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
  const tmp = CALIBRATION_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(calibration, null, 2), 'utf8');
  fs.renameSync(tmp, CALIBRATION_FILE);
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Run the full retraining pipeline once.
 * Idempotent — safe to call multiple times; concurrent calls are no-ops.
 */
export async function runRetrainingPipeline(): Promise<RetrainingResult> {
  if (isRunning) {
    log('info', 'Retraining already in progress — skipping');
    return {
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      feedbackEntriesRead: 0,
      correctionExamplesExtracted: 0,
      confirmedClaimsIndexed: 0,
      thresholdsAdjusted: false,
      calibrationPath: CALIBRATION_FILE,
      error: 'Already running',
    };
  }

  isRunning = true;
  const startedAt = new Date().toISOString();
  log('info', 'Retraining pipeline started');

  try {
    // 1. Read all feedback
    const entries = readAllFeedback();
    log('info', 'Feedback entries read', { count: entries.length });

    // 2. Compute badge accuracy stats
    const badgeStats = computeBadgeStats(entries);
    for (const s of badgeStats) {
      if (s.totalFeedback > 0) {
        log('info', `Badge ${s.badge} accuracy`, {
          badge: s.badge,
          total: s.totalFeedback,
          accuracyRate: s.accuracyRate,
        });
      }
    }

    // 3. Load existing thresholds and calibrate
    const existingThresholds = loadExistingCalibration();
    const thresholds = calibrateThresholds(badgeStats, existingThresholds);
    const thresholdsAdjusted =
      thresholds.verifiedThreshold !== existingThresholds.verifiedThreshold ||
      thresholds.lowConfidenceThreshold !== existingThresholds.lowConfidenceThreshold;

    // 4. Extract correction examples (few-shot training data)
    const correctionExamples = extractCorrectionExamples(entries);
    log('info', 'Correction examples extracted', { count: correctionExamples.length });

    // 5. Extract confirmed-correct claim cache
    const confirmedCorrectClaims = extractConfirmedCorrectClaims(entries);
    log('info', 'Confirmed-correct claims indexed', { count: confirmedCorrectClaims.length });

    // 6. Write calibration file
    const calibration: HallucinationCalibration = {
      generatedAt: new Date().toISOString(),
      totalFeedbackProcessed: entries.length,
      badgeStats,
      thresholds,
      correctionExamples,
      confirmedCorrectClaims,
    };
    writeCalibration(calibration);

    const completedAt = new Date().toISOString();
    lastRunAt = new Date();
    lastRunResult = {
      startedAt,
      completedAt,
      feedbackEntriesRead: entries.length,
      correctionExamplesExtracted: correctionExamples.length,
      confirmedClaimsIndexed: confirmedCorrectClaims.length,
      thresholdsAdjusted,
      calibrationPath: CALIBRATION_FILE,
    };

    log('info', 'Retraining pipeline completed', {
      durationMs: new Date(completedAt).getTime() - new Date(startedAt).getTime(),
      ...lastRunResult,
    });

    return lastRunResult;
  } catch (err) {
    const completedAt = new Date().toISOString();
    log('error', 'Retraining pipeline failed', { error: String(err) });
    lastRunResult = {
      startedAt,
      completedAt,
      feedbackEntriesRead: 0,
      correctionExamplesExtracted: 0,
      confirmedClaimsIndexed: 0,
      thresholdsAdjusted: false,
      calibrationPath: CALIBRATION_FILE,
      error: String(err),
    };
    return lastRunResult;
  } finally {
    isRunning = false;
  }
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

/**
 * Compute milliseconds until next scheduled run at RETRAINING_HOUR_UTC:00 UTC.
 */
export function msUntilNextScheduledRun(now: Date = new Date()): number {
  const next = new Date(now);
  next.setUTCHours(RETRAINING_HOUR_UTC, 0, 0, 0);
  if (next.getTime() <= now.getTime()) {
    // Target hour has passed today — schedule for tomorrow
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next.getTime() - now.getTime();
}

function scheduleNextRun(): void {
  const ms = msUntilNextScheduledRun();
  const nextRunAt = new Date(Date.now() + ms).toISOString();
  log('info', 'Retraining pipeline scheduled', { nextRunAt, ms });

  retrainingTimer = setTimeout(async () => {
    try {
      await runRetrainingPipeline();
    } catch (err) {
      log('error', 'Scheduled retraining threw', { error: String(err) });
    }
    scheduleNextRun(); // Re-schedule for the next day
  }, ms);
}

/**
 * Start the daily retraining scheduler.
 * Call once at server startup.
 */
export function startRetrainingScheduler(): void {
  log('info', 'Retraining scheduler starting', { hourUTC: RETRAINING_HOUR_UTC });
  scheduleNextRun();
}

/**
 * Stop the scheduler (for graceful shutdown).
 */
export function stopRetrainingScheduler(): void {
  if (retrainingTimer) {
    clearTimeout(retrainingTimer);
    retrainingTimer = null;
    log('info', 'Retraining scheduler stopped');
  }
}

/**
 * Status snapshot for the HTTP API.
 */
export function getRetrainingStatus(): {
  scheduled: boolean;
  hourUTC: number;
  isRunning: boolean;
  lastRunAt: string | null;
  lastRunResult: RetrainingResult | null;
  nextRunAt: string | null;
  calibrationPath: string;
} {
  return {
    scheduled: retrainingTimer !== null,
    hourUTC: RETRAINING_HOUR_UTC,
    isRunning,
    lastRunAt: lastRunAt?.toISOString() ?? null,
    lastRunResult,
    nextRunAt: retrainingTimer
      ? new Date(Date.now() + msUntilNextScheduledRun()).toISOString()
      : null,
    calibrationPath: CALIBRATION_FILE,
  };
}

/**
 * Read the current calibration file.
 * Returns null if no calibration has been generated yet.
 */
export function readCalibration(): HallucinationCalibration | null {
  try {
    if (!fs.existsSync(CALIBRATION_FILE)) return null;
    const raw = fs.readFileSync(CALIBRATION_FILE, 'utf8');
    return JSON.parse(raw) as HallucinationCalibration;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(level: string, msg: string, extra?: Record<string, unknown>): void {
  console.log(JSON.stringify({
    level,
    msg,
    component: 'comm.retraining-pipeline',
    ts: new Date().toISOString(),
    ...extra,
  }));
}
