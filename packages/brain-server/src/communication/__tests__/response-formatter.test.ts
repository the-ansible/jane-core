import { describe, it, expect } from 'vitest';
import {
  confidenceBadge,
  badgeEmoji,
  tryInlineAnnotate,
  buildVerificationSection,
  formatWithConfidenceBadges,
} from '../response-formatter.js';
import type { HallucinationReport } from '../hallucination-detector.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReport(overrides: Partial<HallucinationReport> = {}): HallucinationReport {
  return {
    messageId: 'test-id',
    timestamp: '2026-03-10T00:00:00.000Z',
    claimsFound: 0,
    claimsVerified: 0,
    overallConfidence: 100,
    flagged: false,
    results: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// confidenceBadge
// ---------------------------------------------------------------------------

describe('confidenceBadge', () => {
  it('returns verified badge for high confidence', () => {
    expect(confidenceBadge(100)).toBe('✅ verified');
    expect(confidenceBadge(80)).toBe('✅ verified');
  });

  it('returns uncertain badge for medium confidence', () => {
    expect(confidenceBadge(79)).toBe('⚠️ uncertain');
    expect(confidenceBadge(60)).toBe('⚠️ uncertain');
  });

  it('returns low confidence badge for low confidence', () => {
    expect(confidenceBadge(59)).toBe('🚨 low confidence');
    expect(confidenceBadge(0)).toBe('🚨 low confidence');
  });
});

// ---------------------------------------------------------------------------
// badgeEmoji
// ---------------------------------------------------------------------------

describe('badgeEmoji', () => {
  it('returns ✅ for ≥ 80', () => {
    expect(badgeEmoji(90)).toBe('✅');
    expect(badgeEmoji(80)).toBe('✅');
  });

  it('returns ⚠️ for 60–79', () => {
    expect(badgeEmoji(70)).toBe('⚠️');
    expect(badgeEmoji(60)).toBe('⚠️');
  });

  it('returns 🚨 for < 60', () => {
    expect(badgeEmoji(50)).toBe('🚨');
    expect(badgeEmoji(0)).toBe('🚨');
  });
});

// ---------------------------------------------------------------------------
// tryInlineAnnotate
// ---------------------------------------------------------------------------

describe('tryInlineAnnotate', () => {
  it('inserts badge after matching substring', () => {
    const msg = 'The Earth is approximately 4.5 billion years old.';
    const result = tryInlineAnnotate(msg, 'approximately 4.5 billion years old', '✅');
    expect(result).toContain('approximately 4.5 billion years old ✅');
  });

  it('is case-insensitive', () => {
    const msg = 'Mount Everest is 8849 meters tall.';
    const result = tryInlineAnnotate(msg, 'mount everest is 8849 meters tall', '⚠️');
    expect(result).toContain('8849 meters tall ⚠️');
  });

  it('returns message unchanged if claim not found', () => {
    const msg = 'The sky is blue.';
    const result = tryInlineAnnotate(msg, 'non-existent factual claim here', '✅');
    expect(result).toBe(msg);
  });

  it('returns message unchanged for claims shorter than 15 chars', () => {
    const msg = 'It is 42 degrees.';
    const result = tryInlineAnnotate(msg, '42 degrees', '⚠️');
    expect(result).toBe(msg);
  });

  it('does not double-annotate already-annotated claims', () => {
    const msg = 'approximately 4.5 billion years old ✅ and more text';
    const result = tryInlineAnnotate(msg, 'approximately 4.5 billion years old', '✅');
    // Should not insert again since next char is already ✅
    const occurrences = (result.match(/✅/g) ?? []).length;
    expect(occurrences).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// buildVerificationSection
// ---------------------------------------------------------------------------

describe('buildVerificationSection', () => {
  it('builds a section with verified and uncertain claims', () => {
    const results = [
      { claim: 'The US has 50 states', category: 'factual' as const, confidence: 95, source: 'ollama-selfcheck' as const },
      { claim: 'Population is 330 million people', category: 'numeric' as const, confidence: 65, source: 'wolfram' as const },
    ];
    const section = buildVerificationSection(results, '**Fact-check:**');
    expect(section).toContain('**Fact-check:**');
    expect(section).toContain('✅ verified');
    expect(section).toContain('⚠️ uncertain');
    expect(section).toContain('self-check');
    expect(section).toContain('wolfram');
  });

  it('skips results with source === skipped', () => {
    const results = [
      { claim: 'Some skipped claim here xx', category: 'numeric' as const, confidence: 50, source: 'skipped' as const, note: 'no api key' },
    ];
    const section = buildVerificationSection(results, '**Fact-check:**');
    expect(section).not.toContain('Some skipped claim');
  });

  it('includes note for low-confidence claims', () => {
    const results = [
      {
        claim: 'Very specific false claim about numbers',
        category: 'numeric' as const,
        confidence: 20,
        source: 'wolfram' as const,
        note: 'Wolfram says the number is actually different',
      },
    ];
    const section = buildVerificationSection(results, '**Fact-check:**');
    expect(section).toContain('Wolfram says the number is actually different');
  });
});

// ---------------------------------------------------------------------------
// formatWithConfidenceBadges
// ---------------------------------------------------------------------------

describe('formatWithConfidenceBadges', () => {
  it('returns message unchanged when no claims were verified', () => {
    const msg = 'Hello, how can I help?';
    const report = makeReport({ claimsVerified: 0, results: [] });
    expect(formatWithConfidenceBadges(msg, report)).toBe(msg);
  });

  it('returns message unchanged in minimal mode when all claims pass', () => {
    const msg = 'The Earth orbits the sun in approximately 365 days.';
    const report = makeReport({
      claimsVerified: 1,
      results: [
        { claim: 'orbits the sun in approximately 365 days', category: 'factual', confidence: 92, source: 'ollama-selfcheck' },
      ],
    });
    expect(formatWithConfidenceBadges(msg, report, { mode: 'minimal' })).toBe(msg);
  });

  it('appends verification section in detailed mode even for passing claims', () => {
    const msg = 'The Earth orbits the sun in approximately 365 days.';
    const report = makeReport({
      claimsVerified: 1,
      results: [
        { claim: 'orbits the sun in approximately 365 days', category: 'factual', confidence: 92, source: 'ollama-selfcheck' },
      ],
    });
    const result = formatWithConfidenceBadges(msg, report, { mode: 'detailed' });
    expect(result).toContain('**Fact-check:**');
    expect(result).toContain('✅ verified');
  });

  it('appends verification section in minimal mode when a claim is flagged', () => {
    const msg = 'The population of the US is exactly 200 million people.';
    const report = makeReport({
      overallConfidence: 45,
      flagged: true,
      claimsVerified: 1,
      results: [
        { claim: 'The population of the US is exactly 200 million people', category: 'numeric', confidence: 45, source: 'wolfram', note: 'US population is ~335M' },
      ],
    });
    const result = formatWithConfidenceBadges(msg, report);
    expect(result).toContain('**Fact-check:**');
    expect(result).toContain('🚨 low confidence');
    expect(result).toContain('US population is ~335M');
  });

  it('appends verification section in minimal mode for uncertain claims', () => {
    const msg = 'There are approximately 7 billion people on Earth.';
    const report = makeReport({
      overallConfidence: 70,
      claimsVerified: 1,
      results: [
        { claim: 'approximately 7 billion people on Earth', category: 'numeric', confidence: 70, source: 'ollama-selfcheck' },
      ],
    });
    const result = formatWithConfidenceBadges(msg, report);
    expect(result).toContain('**Fact-check:**');
    expect(result).toContain('⚠️ uncertain');
  });

  it('returns original message if report or options cause an error', () => {
    const msg = 'Test message.';
    // Pass a malformed report that would cause processing issues
    const badReport = { results: null } as unknown as HallucinationReport;
    const result = formatWithConfidenceBadges(msg, badReport);
    expect(result).toBe(msg);
  });

  it('respects maxClaims option', () => {
    const msg = 'Multiple claims about many things in this test message here.';
    const results = Array.from({ length: 8 }, (_, i) => ({
      claim: `claim number ${i + 1} about something very specific`,
      category: 'factual' as const,
      confidence: 65,
      source: 'ollama-selfcheck' as const,
    }));
    const report = makeReport({ claimsVerified: 8, results });
    const resultMsg = formatWithConfidenceBadges(msg, report, { maxClaims: 3 });
    // Should show only 3 claims in the section
    const claimMatches = resultMsg.match(/claim number \d/g) ?? [];
    expect(claimMatches.length).toBeLessThanOrEqual(3);
  });

  it('attempts inline annotation for verifiable claims found in message', () => {
    const msg = 'Mount Everest is 8849 meters above sea level according to recent measurements.';
    const report = makeReport({
      claimsVerified: 1,
      overallConfidence: 70,
      results: [
        { claim: 'Mount Everest is 8849 meters above sea level', category: 'numeric', confidence: 70, source: 'wolfram' },
      ],
    });
    const result = formatWithConfidenceBadges(msg, report, { mode: 'detailed' });
    // The inline badge should be present in the message body
    expect(result).toContain('8849 meters above sea level');
    expect(result).toContain('⚠️');
  });
});
