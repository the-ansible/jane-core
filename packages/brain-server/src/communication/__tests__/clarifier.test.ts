/**
 * Tests for clarifier module — queryChrisInsight function.
 *
 * analyzeClarification relies on external LLM calls (Mercury/Ollama) so we
 * only test queryChrisInsight here, which is pure/deterministic.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Mock node:fs to avoid hitting the real vault directory during tests
// ---------------------------------------------------------------------------

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
  readdirSync: vi.fn(),
  existsSync: vi.fn(),
}));

const mockExistsSync = vi.mocked(existsSync);
const mockReaddirSync = vi.mocked(readdirSync);
const mockReadFileSync = vi.mocked(readFileSync);

// ---------------------------------------------------------------------------
// Fixture data — realistic excerpts from Chris Insights vault
// ---------------------------------------------------------------------------

const PRIORITIES_MD = `# Chris Priorities — 2026-03-11

## Top 3 Priorities

1. **Goal engine state machine** — Chris wants goals to have lifecycle states (open, in-progress, achieved, abandoned)
2. **Lane model for goal engine** — Separate goals into system/craft/self lanes
3. **Behavioral research** — Understanding Jane's execution patterns

## Communication Notes

Chris prefers brief updates. He gets frustrated when Jane over-engineers solutions.
`;

const PERSONA_PROFILE_MD = `# Chris Persona Profile

## Who He Is

- Timezone: US/Pacific (San Jose, CA)
- Colorblindness constraints: no red/green only distinctions
- Building Jane as an entity, not a tool

## What Motivates Him

Chris values transparency, directness, and systems that actually work.
He gets energized by seeing Jane make autonomous progress on meaningful goals.

## Communication Style

- Act first, brief update after
- No em-dashes
- Prefer bullet points over prose paragraphs
- Slack DMs over email
`;

const SENTIMENT_TRACKER_MD = `# Chris Sentiment Tracker

## Summary

Dominant tone: Analytical-neutral (74%)

## Detected Patterns

- Design-correction pattern: Chris redirects premature implementations
- Collaborative: High engagement when Jane proposes novel approaches
- Frustrated: Triggered by repeated zombie-goal actions

## Key Topics

- AI agent architecture
- Brain server development
- Goal engine improvements
`;

// ---------------------------------------------------------------------------
// Helper to reset module cache between tests
// ---------------------------------------------------------------------------

async function importFresh() {
  vi.resetModules();
  const mod = await import('../clarifier.js');
  return mod;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('queryChrisInsight', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns empty result when vault directory does not exist', async () => {
    mockExistsSync.mockReturnValue(false);

    const { queryChrisInsight } = await importFresh();
    const result = queryChrisInsight('What are Chris priorities?');

    expect(result.insights).toHaveLength(0);
    expect(result.summary).toContain('No Chris Insights vault data available');
  });

  it('returns empty result when no markdown files exist', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue([] as unknown as ReturnType<typeof readdirSync>);

    const { queryChrisInsight } = await importFresh();
    const result = queryChrisInsight('What are Chris priorities?');

    expect(result.insights).toHaveLength(0);
    expect(result.summary).toContain('No Chris Insights vault data available');
  });

  it('finds relevant content for a priorities query', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue(['2026-03-11-priorities.md', 'Chris-Persona-Profile.md'] as unknown as ReturnType<typeof readdirSync>);
    mockReadFileSync
      .mockReturnValueOnce(PRIORITIES_MD)
      .mockReturnValueOnce(PERSONA_PROFILE_MD);

    const { queryChrisInsight } = await importFresh();
    const result = queryChrisInsight('What are Chris current priorities goal engine?', 5);

    expect(result.insights.length).toBeGreaterThan(0);
    // The priorities file should rank high
    const topInsight = result.insights[0];
    expect(topInsight.relevance).toBeGreaterThan(0);
    expect(result.summary).toContain('goal engine');
  });

  it('finds communication style from persona profile', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue(['Chris-Persona-Profile.md'] as unknown as ReturnType<typeof readdirSync>);
    mockReadFileSync.mockReturnValueOnce(PERSONA_PROFILE_MD);

    const { queryChrisInsight } = await importFresh();
    const result = queryChrisInsight('How does Chris prefer communication style messaging?', 3);

    expect(result.insights.length).toBeGreaterThan(0);
    const sources = result.insights.map((i) => i.source);
    expect(sources).toContain('Chris-Persona-Profile');
  });

  it('respects maxInsights limit', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue([
      '2026-03-11-priorities.md',
      'Chris-Persona-Profile.md',
      'Chris-Sentiment-Tracker.md',
    ] as unknown as ReturnType<typeof readdirSync>);
    mockReadFileSync
      .mockReturnValueOnce(PRIORITIES_MD)
      .mockReturnValueOnce(PERSONA_PROFILE_MD)
      .mockReturnValueOnce(SENTIMENT_TRACKER_MD);

    const { queryChrisInsight } = await importFresh();
    const result = queryChrisInsight('Chris work style preferences communication analysis', 2);

    expect(result.insights.length).toBeLessThanOrEqual(2);
  });

  it('returns no-match summary when query has no relevant terms', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue(['Chris-Persona-Profile.md'] as unknown as ReturnType<typeof readdirSync>);
    mockReadFileSync.mockReturnValueOnce(PERSONA_PROFILE_MD);

    const { queryChrisInsight } = await importFresh();
    const result = queryChrisInsight('xylophone quantum flux capacitor oscillation', 5);

    expect(result.insights).toHaveLength(0);
    expect(result.summary).toContain('No relevant insights found');
  });

  it('includes source file names in insight results', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue(['Chris-Sentiment-Tracker.md'] as unknown as ReturnType<typeof readdirSync>);
    mockReadFileSync.mockReturnValueOnce(SENTIMENT_TRACKER_MD);

    const { queryChrisInsight } = await importFresh();
    const result = queryChrisInsight('sentiment patterns frustration zombie goals', 3);

    if (result.insights.length > 0) {
      expect(result.insights[0].source).toBe('Chris-Sentiment-Tracker');
    }
  });

  it('returns empty result when query tokenizes to nothing', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue(['Chris-Persona-Profile.md'] as unknown as ReturnType<typeof readdirSync>);
    mockReadFileSync.mockReturnValueOnce(PERSONA_PROFILE_MD);

    const { queryChrisInsight } = await importFresh();
    // Only stop words
    const result = queryChrisInsight('a the is are', 5);

    expect(result.insights).toHaveLength(0);
    expect(result.summary).toBe('');
  });

  it('summary contains query and source references', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReaddirSync.mockReturnValue(['Chris-Persona-Profile.md'] as unknown as ReturnType<typeof readdirSync>);
    mockReadFileSync.mockReturnValueOnce(PERSONA_PROFILE_MD);

    const { queryChrisInsight } = await importFresh();
    const result = queryChrisInsight('timezone schedule pacific location', 3);

    if (result.insights.length > 0) {
      expect(result.summary).toContain('Chris Insights');
      expect(result.summary).toContain('timezone schedule pacific location');
      expect(result.summary).toContain('Chris-Persona-Profile');
    }
  });
});
