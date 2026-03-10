/**
 * Response Formatter — confidence-badge layer for hallucination-detected messages.
 *
 * Consumes a HallucinationReport and annotates the composed message with
 * per-claim verification badges so Chris can see exactly which statements
 * have been checked and how confident the system is in each.
 *
 * Badge legend:
 *   ✅  verified  — confidence ≥ 80
 *   ⚠️  uncertain — confidence 60–79
 *   🚨  low       — confidence < 60
 *
 * Formatting modes:
 *   'minimal'  — append section only when a flagged claim exists (< 60 conf)
 *   'detailed' — append section whenever any claim was verified
 *
 * The formatter never throws. On any error it returns the input unchanged.
 */

import type { HallucinationReport, ClaimVerificationResult } from './hallucination-detector.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type BadgeMode = 'minimal' | 'detailed';

export interface FormatterOptions {
  /** Controls when the verification section is appended (default: 'minimal') */
  mode: BadgeMode;
  /** Section header text (default: '**Fact-check:**') */
  sectionHeader: string;
  /** Maximum claims to show in the section (default: 10) */
  maxClaims: number;
}

const DEFAULT_OPTS: FormatterOptions = {
  mode: 'minimal',
  sectionHeader: '**Fact-check:**',
  maxClaims: 10,
};

// ---------------------------------------------------------------------------
// Badge helpers
// ---------------------------------------------------------------------------

/**
 * Returns a short badge string for a confidence score.
 *   ≥ 80  → ✅ verified
 *   60–79 → ⚠️ uncertain
 *   < 60  → 🚨 low confidence
 */
export function confidenceBadge(confidence: number): string {
  if (confidence >= 80) return '✅ verified';
  if (confidence >= 60) return '⚠️ uncertain';
  return '🚨 low confidence';
}

/**
 * Short emoji-only badge (used for inline tries).
 */
export function badgeEmoji(confidence: number): string {
  if (confidence >= 80) return '✅';
  if (confidence >= 60) return '⚠️';
  return '🚨';
}

// ---------------------------------------------------------------------------
// Inline annotation (best-effort)
// ---------------------------------------------------------------------------

/**
 * Attempt to find the claim text inside the message and insert a badge
 * directly after it. Returns the modified message if the claim is found,
 * or the original if not.
 *
 * Matching strategy: look for each word of the claim (≥5 chars) in sequence.
 * Uses a simple case-insensitive substring search with a length threshold to
 * avoid matching single short words.
 */
export function tryInlineAnnotate(
  message: string,
  claim: string,
  badge: string,
): string {
  // Only attempt if the claim text is long enough to be worth matching
  if (claim.length < 15) return message;

  // Try exact substring match first (case-insensitive)
  const lowerMsg = message.toLowerCase();
  const lowerClaim = claim.toLowerCase();
  const idx = lowerMsg.indexOf(lowerClaim);

  if (idx !== -1) {
    const insertAt = idx + claim.length;
    // Don't insert if a badge emoji already follows (check a few chars ahead for emoji/space combos)
    const upcoming = message.slice(insertAt, insertAt + 8);
    if (upcoming.includes('✅') || upcoming.includes('⚠️') || upcoming.includes('🚨')) {
      return message;
    }
    return message.slice(0, insertAt) + ` ${badge}` + message.slice(insertAt);
  }

  return message;
}

// ---------------------------------------------------------------------------
// Footnote section builder
// ---------------------------------------------------------------------------

/**
 * Build the verification footnote section from a list of results.
 * Each line shows: claim text, badge, confidence score, and optional source.
 */
export function buildVerificationSection(
  results: ClaimVerificationResult[],
  header: string,
): string {
  const lines: string[] = ['', `---`, header];

  for (const r of results) {
    if (r.source === 'skipped') continue;

    const badge = confidenceBadge(r.confidence);
    const claimPreview = r.claim.length > 100 ? r.claim.slice(0, 97) + '…' : r.claim;
    const sourceTag = r.source === 'wolfram' ? 'wolfram' : 'self-check';
    let line = `- "${claimPreview}" — ${badge} (${r.confidence}/100, ${sourceTag})`;
    if (r.note && r.confidence < 60) {
      // Include the note for low-confidence claims to give context
      const notePreview = r.note.length > 120 ? r.note.slice(0, 117) + '…' : r.note;
      line += `\n  _${notePreview}_`;
    }
    lines.push(line);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Format a composed message by appending per-claim confidence badges based
 * on the hallucination detection report.
 *
 * Returns the input message unchanged if:
 *   - No claims were verified
 *   - mode === 'minimal' and all claims pass (confidence ≥ 80)
 *   - An error occurs during formatting
 */
export function formatWithConfidenceBadges(
  message: string,
  report: HallucinationReport,
  opts?: Partial<FormatterOptions>,
): string {
  try {
    const options: FormatterOptions = { ...DEFAULT_OPTS, ...opts };

    // No claims verified — nothing to show
    const verifiedResults = report.results.filter(r => r.source !== 'skipped');
    if (verifiedResults.length === 0) return message;

    const hasUncertain = verifiedResults.some(r => r.confidence >= 60 && r.confidence < 80);
    const hasFlagged = verifiedResults.some(r => r.confidence < 60);

    // In minimal mode, only annotate when there are flagged or uncertain claims
    if (options.mode === 'minimal' && !hasFlagged && !hasUncertain) {
      return message;
    }

    // Try inline annotation for each claim
    let annotated = message;
    for (const result of verifiedResults.slice(0, options.maxClaims)) {
      annotated = tryInlineAnnotate(annotated, result.claim, badgeEmoji(result.confidence));
    }

    // Always append the structured verification section
    const displayResults = verifiedResults.slice(0, options.maxClaims);
    const section = buildVerificationSection(displayResults, options.sectionHeader);
    return annotated + section;
  } catch (err) {
    log('warn', 'Response formatter threw, returning original message', {
      error: String(err),
      messageId: report.messageId,
    });
    return message;
  }
}

// ---------------------------------------------------------------------------
// Logging helper
// ---------------------------------------------------------------------------

function log(level: string, msg: string, extra?: Record<string, unknown>): void {
  console.log(JSON.stringify({
    level,
    msg,
    component: 'comm.response-formatter',
    ts: new Date().toISOString(),
    ...extra,
  }));
}
