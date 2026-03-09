/**
 * Executor context summarizer tests.
 *
 * Tests summarizeTexts() and summarizeMessages() with a mocked invokeAdapter.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock executor/index.js (invokeAdapter)
// ---------------------------------------------------------------------------

const mockInvokeAdapter = vi.fn();
vi.mock('../index.js', () => ({
  invokeAdapter: (...args: any[]) => mockInvokeAdapter(...args),
}));

import { summarizeTexts, summarizeMessages } from '../context/summarizer.js';
import type { ContextMessage } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SUCCESS_RESPONSE = `SUMMARY: The agent implemented Phase 5.2 goal snapshots and Phase 5.3 release.
TOPICS: goal-snapshots, brain-server, release
ENTITIES: Jane, brain-server, goal-engine`;

const MINIMAL_RESPONSE = `SUMMARY: Some work was done.
TOPICS:
ENTITIES: `;

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// summarizeTexts
// ---------------------------------------------------------------------------

describe('summarizeTexts', () => {
  it('returns parsed summary, topics, and entities from adapter response', async () => {
    mockInvokeAdapter.mockResolvedValueOnce({
      success: true,
      resultText: SUCCESS_RESPONSE,
      rawOutput: '',
      durationMs: 100,
    });

    const result = await summarizeTexts([
      'Action COMPLETED: Implement Phase 5.2',
      'Action FAILED: Fix scheduler crash',
    ]);

    expect(result.summary).toContain('Phase 5.2 goal snapshots');
    expect(result.topics).toContain('goal-snapshots');
    expect(result.topics).toContain('brain-server');
    expect(result.entities).toContain('Jane');
    expect(result.model).toBe('haiku');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.promptTokens).toBeGreaterThan(0);
    expect(result.outputTokens).toBeGreaterThan(0);
  });

  it('calls invokeAdapter with claude-code runtime and haiku model by default', async () => {
    mockInvokeAdapter.mockResolvedValueOnce({
      success: true,
      resultText: MINIMAL_RESPONSE,
      rawOutput: '',
      durationMs: 50,
    });

    await summarizeTexts(['Entry 1', 'Entry 2']);

    expect(mockInvokeAdapter).toHaveBeenCalledWith(expect.objectContaining({
      runtime: 'claude-code',
      model: 'haiku',
    }));
  });

  it('uses specified model when provided in options', async () => {
    mockInvokeAdapter.mockResolvedValueOnce({
      success: true,
      resultText: MINIMAL_RESPONSE,
      rawOutput: '',
      durationMs: 50,
    });

    await summarizeTexts(['Entry'], { model: 'sonnet' });

    expect(mockInvokeAdapter).toHaveBeenCalledWith(expect.objectContaining({
      model: 'sonnet',
    }));
  });

  it('falls back gracefully when adapter fails', async () => {
    mockInvokeAdapter.mockResolvedValueOnce({
      success: false,
      resultText: null,
      rawOutput: '',
      durationMs: 50,
      error: 'Connection refused',
    });

    const result = await summarizeTexts(['Entry 1', 'Entry 2']);

    expect(result.summary).toContain('[summarization_failed]');
    expect(result.topics).toEqual([]);
    expect(result.entities).toEqual([]);
  });

  it('falls back gracefully when adapter throws', async () => {
    mockInvokeAdapter.mockRejectedValueOnce(new Error('Network error'));

    const result = await summarizeTexts(['Entry']);

    expect(result.summary).toContain('[summarization_failed]');
  });

  it('handles response without structured topics/entities format', async () => {
    mockInvokeAdapter.mockResolvedValueOnce({
      success: true,
      resultText: 'Some work was done.',
      rawOutput: '',
      durationMs: 50,
    });

    const result = await summarizeTexts(['Entry']);

    // When there's no structured format, the full text becomes the summary
    expect(result.summary).toBe('Some work was done.');
    expect(result.topics).toEqual([]);
    expect(result.entities).toEqual([]);
  });

  it('includes numbered entries in prompt for clarity', async () => {
    mockInvokeAdapter.mockResolvedValueOnce({
      success: true,
      resultText: MINIMAL_RESPONSE,
      rawOutput: '',
      durationMs: 50,
    });

    await summarizeTexts(['First entry', 'Second entry']);

    const promptArg = mockInvokeAdapter.mock.calls[0][0].prompt;
    expect(promptArg).toContain('[1] First entry');
    expect(promptArg).toContain('[2] Second entry');
  });
});

// ---------------------------------------------------------------------------
// summarizeMessages
// ---------------------------------------------------------------------------

describe('summarizeMessages', () => {
  const messages: ContextMessage[] = [
    { role: 'user', content: 'What is the status of the brain server?', timestamp: '2026-03-09T10:00:00Z' },
    { role: 'assistant', content: 'The brain server is running on port 3103.', timestamp: '2026-03-09T10:01:00Z' },
    { role: 'system', content: 'Context loaded.', timestamp: '2026-03-09T10:02:00Z' },
  ];

  it('formats user/assistant/system roles correctly in prompt', async () => {
    mockInvokeAdapter.mockResolvedValueOnce({
      success: true,
      resultText: SUCCESS_RESPONSE,
      rawOutput: '',
      durationMs: 80,
    });

    await summarizeMessages(messages);

    const promptArg = mockInvokeAdapter.mock.calls[0][0].prompt;
    expect(promptArg).toContain('User: What is the status');
    expect(promptArg).toContain('Jane: The brain server is running');
    expect(promptArg).toContain('System: Context loaded');
  });

  it('returns structured summary from parsed response', async () => {
    mockInvokeAdapter.mockResolvedValueOnce({
      success: true,
      resultText: SUCCESS_RESPONSE,
      rawOutput: '',
      durationMs: 80,
    });

    const result = await summarizeMessages(messages);

    expect(result.summary).toContain('Phase 5.2 goal snapshots');
    expect(result.topics).toContain('brain-server');
    expect(result.model).toBe('haiku');
  });

  it('falls back gracefully when adapter fails', async () => {
    mockInvokeAdapter.mockResolvedValueOnce({
      success: false,
      resultText: null,
      rawOutput: '',
      durationMs: 50,
      error: 'Timeout',
    });

    const result = await summarizeMessages(messages);

    expect(result.summary).toContain('[summarization_failed]');
    expect(result.topics).toEqual([]);
  });
});
