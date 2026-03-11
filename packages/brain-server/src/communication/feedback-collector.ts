/**
 * Feedback Collector — receives user confirmations/corrections on confidence flags.
 *
 * When the response-formatter appends ✅/⚠️/🚨 badges to messages, users can
 * confirm or correct those confidence assessments. This module persists that
 * feedback to a NDJSON log for later analysis and model fine-tuning.
 *
 * Log location: logs/confidence-feedback.ndjson (relative to brain-server)
 * Log format: one JSON object per line (NDJSON)
 *
 * Each entry captures:
 *   - The original claim text
 *   - The badge Jane assigned (✅/⚠️/🚨)
 *   - The original confidence score
 *   - User's verdict (confirmed|corrected|disputed)
 *   - Optional correction text (if verdict is 'corrected')
 *   - Message and session context for traceability
 *   - Timestamp
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type UserVerdict = 'confirmed' | 'corrected' | 'disputed';

/** A single piece of user feedback on a confidence-flagged claim. */
export interface ClaimFeedback {
  /** Unique ID for this feedback entry */
  feedbackId: string;
  /** The message ID from the HallucinationReport */
  messageId: string;
  /** Conversation session ID (for context retrieval) */
  sessionId?: string;
  /** The original claim text that was flagged */
  claim: string;
  /** The badge the system assigned */
  assignedBadge: '✅' | '⚠️' | '🚨';
  /** The numeric confidence score the system assigned (0–100) */
  assignedConfidence: number;
  /** User's verdict on the badge */
  verdict: UserVerdict;
  /**
   * If verdict is 'corrected': what the correct answer / claim is.
   * If verdict is 'disputed': why the user disagrees.
   */
  correction?: string;
  /** Free-form note from the user */
  note?: string;
  /** ISO timestamp of when feedback was submitted */
  submittedAt: string;
  /** Source identifier (e.g. 'slack', 'api', 'dashboard') */
  source?: string;
}

/** Aggregated stats returned by getSummary() */
export interface FeedbackSummary {
  totalEntries: number;
  confirmedCount: number;
  correctedCount: number;
  disputedCount: number;
  /** Accuracy = confirmed / (confirmed + corrected + disputed) */
  accuracyRate: number;
  /** Average assigned confidence for confirmed entries */
  avgConfidenceOnConfirmed: number;
  /** Average assigned confidence for corrected entries */
  avgConfidenceOnCorrected: number;
  /** Breakdown by badge */
  byBadge: Record<string, { confirmed: number; corrected: number; disputed: number }>;
}

// ---------------------------------------------------------------------------
// File path
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Resolve to brain-server root, then logs/
const LOG_DIR = path.resolve(__dirname, '../../logs');
const LOG_FILE = path.join(LOG_DIR, 'confidence-feedback.ndjson');

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function ensureLogDir(): void {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

function generateId(): string {
  // Simple time-based ID with a random suffix
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `fb-${ts}-${rand}`;
}

function badgeFromConfidence(confidence: number): '✅' | '⚠️' | '🚨' {
  if (confidence >= 80) return '✅';
  if (confidence >= 60) return '⚠️';
  return '🚨';
}

function log(level: string, msg: string, extra?: Record<string, unknown>): void {
  console.log(JSON.stringify({
    level,
    msg,
    component: 'comm.feedback-collector',
    ts: new Date().toISOString(),
    ...extra,
  }));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Record a single piece of user feedback on a confidence-flagged claim.
 * Appends to the NDJSON log file. Never throws.
 */
export function recordFeedback(input: {
  messageId: string;
  sessionId?: string;
  claim: string;
  assignedConfidence: number;
  verdict: UserVerdict;
  correction?: string;
  note?: string;
  source?: string;
}): ClaimFeedback {
  const entry: ClaimFeedback = {
    feedbackId: generateId(),
    messageId: input.messageId,
    sessionId: input.sessionId,
    claim: input.claim,
    assignedBadge: badgeFromConfidence(input.assignedConfidence),
    assignedConfidence: input.assignedConfidence,
    verdict: input.verdict,
    correction: input.correction,
    note: input.note,
    submittedAt: new Date().toISOString(),
    source: input.source ?? 'api',
  };

  try {
    ensureLogDir();
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n', 'utf8');
    log('info', 'Feedback recorded', {
      feedbackId: entry.feedbackId,
      verdict: entry.verdict,
      badge: entry.assignedBadge,
      confidence: entry.assignedConfidence,
    });
  } catch (err) {
    log('error', 'Failed to write feedback to log', { error: String(err) });
  }

  return entry;
}

/**
 * Read all feedback entries from the log file.
 * Returns empty array on error or if file doesn't exist.
 */
export function readAllFeedback(): ClaimFeedback[] {
  try {
    if (!fs.existsSync(LOG_FILE)) return [];
    const raw = fs.readFileSync(LOG_FILE, 'utf8');
    return raw
      .split('\n')
      .filter(line => line.trim().length > 0)
      .map(line => JSON.parse(line) as ClaimFeedback);
  } catch (err) {
    log('warn', 'Failed to read feedback log', { error: String(err) });
    return [];
  }
}

/**
 * Read feedback entries for a specific message.
 */
export function getFeedbackForMessage(messageId: string): ClaimFeedback[] {
  return readAllFeedback().filter(e => e.messageId === messageId);
}

/**
 * Compute aggregated stats across all recorded feedback.
 * Useful for dashboards and model evaluation.
 */
export function getFeedbackSummary(): FeedbackSummary {
  const entries = readAllFeedback();

  const confirmed = entries.filter(e => e.verdict === 'confirmed');
  const corrected = entries.filter(e => e.verdict === 'corrected');
  const disputed = entries.filter(e => e.verdict === 'disputed');

  const total = entries.length;
  const accuracyRate = total === 0 ? 0 : confirmed.length / total;

  const avgConfidence = (arr: ClaimFeedback[]) =>
    arr.length === 0 ? 0 : arr.reduce((s, e) => s + e.assignedConfidence, 0) / arr.length;

  const byBadge: FeedbackSummary['byBadge'] = {};
  for (const entry of entries) {
    const badge = entry.assignedBadge;
    if (!byBadge[badge]) byBadge[badge] = { confirmed: 0, corrected: 0, disputed: 0 };
    byBadge[badge][entry.verdict]++;
  }

  return {
    totalEntries: total,
    confirmedCount: confirmed.length,
    correctedCount: corrected.length,
    disputedCount: disputed.length,
    accuracyRate: Math.round(accuracyRate * 1000) / 1000,
    avgConfidenceOnConfirmed: Math.round(avgConfidence(confirmed) * 10) / 10,
    avgConfidenceOnCorrected: Math.round(avgConfidence(corrected) * 10) / 10,
    byBadge,
  };
}

/** Path to the feedback log file (for external tooling). */
export function getFeedbackLogPath(): string {
  return LOG_FILE;
}
