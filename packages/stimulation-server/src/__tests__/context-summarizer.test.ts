import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock Claude launcher — summarizer uses launchClaude, not fetch
const mockLaunchClaude = vi.fn();
vi.mock('@jane-core/claude-launcher', () => ({
  launchClaude: (...args: any[]) => mockLaunchClaude(...args),
}));

// Mock uuidv7
vi.mock('@the-ansible/life-system-shared', () => ({
  uuidv7: () => 'test-uuid-001',
}));

import { summarizeChunk } from '../context/summarizer.js';
import type { ContextPlanConfig } from '../context/types.js';
import type { SessionMessage } from '../sessions/store.js';

const defaultPlan: ContextPlanConfig = {
  summaryChunkSize: 6,
  summaryModel: 'gemma3:12b',
  summaryPromptTemplate: 'default_v1',
  rawSummarizationThreshold: 12,
  maxSummaries: 10,
  modelContextSize: 200000,
  tokenBudgetPct: 0.06,
  topicTrackingEnabled: false,
  associativeRetrievalEnabled: false,
};

function makeMessages(count: number): SessionMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    content: `Message ${i + 1} content here`,
    timestamp: new Date(Date.now() - (count - i) * 60000).toISOString(),
  }));
}

describe('Context Summarizer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('constructs correct prompt from messages', async () => {
    const messages = makeMessages(4);

    mockLaunchClaude.mockResolvedValueOnce({
      exitCode: 0,
      timedOut: false,
      resultText: 'SUMMARY: Test summary\nTOPICS: topic1, topic2\nENTITIES: Chris, Jane',
      stdout: '',
    });

    await summarizeChunk(messages, defaultPlan, 'test-session', 0, 3);

    expect(mockLaunchClaude).toHaveBeenCalledOnce();
    const [opts] = mockLaunchClaude.mock.calls[0];
    expect(opts.prompt).toContain('User: Message 1 content here');
    expect(opts.prompt).toContain('Jane: Message 2 content here');
    expect(opts.prompt).toContain('Summarize this conversation segment');
  });

  it('parses SUMMARY/TOPICS/ENTITIES format correctly', async () => {
    mockLaunchClaude.mockResolvedValueOnce({
      exitCode: 0,
      timedOut: false,
      resultText: 'SUMMARY: Chris asked about the weather. Jane said it was sunny.\nTOPICS: weather, small talk\nENTITIES: Chris, Jane, San Jose',
      stdout: '',
    });

    const messages = makeMessages(4);
    const result = await summarizeChunk(messages, defaultPlan, 'test-session', 0, 3);

    expect(result.summary).toBe('Chris asked about the weather. Jane said it was sunny.');
    expect(result.topics).toEqual(['weather', 'small talk']);
    expect(result.entities).toEqual(['Chris', 'Jane', 'San Jose']);
  });

  it('handles missing TOPICS/ENTITIES sections', async () => {
    mockLaunchClaude.mockResolvedValueOnce({
      exitCode: 0,
      timedOut: false,
      resultText: 'SUMMARY: Just a simple summary with no topic or entity extraction.',
      stdout: '',
    });

    const messages = makeMessages(2);
    const result = await summarizeChunk(messages, defaultPlan, 'test-session', 0, 1);

    expect(result.summary).toBe('Just a simple summary with no topic or entity extraction.');
    expect(result.topics).toEqual([]);
    expect(result.entities).toEqual([]);
  });

  it('falls back to naive concatenation on Claude failure', async () => {
    mockLaunchClaude.mockRejectedValueOnce(new Error('Connection refused'));

    const messages = makeMessages(3);
    const result = await summarizeChunk(messages, defaultPlan, 'test-session', 0, 2);

    expect(result.summary).toContain('[summarization_failed]');
    expect(result.topics).toEqual([]);
    expect(result.entities).toEqual([]);
  });

  it('falls back on non-zero exit code', async () => {
    mockLaunchClaude.mockResolvedValueOnce({
      exitCode: 1,
      timedOut: false,
      resultText: null,
      stdout: '',
    });

    const messages = makeMessages(2);
    const result = await summarizeChunk(messages, defaultPlan, 'test-session', 0, 1);

    expect(result.summary).toContain('[summarization_failed]');
  });

  it('records correct metadata in returned SummaryRecord', async () => {
    mockLaunchClaude.mockResolvedValueOnce({
      exitCode: 0,
      timedOut: false,
      resultText: 'SUMMARY: A summary\nTOPICS: coding\nENTITIES: Chris',
      stdout: '',
    });

    const messages = makeMessages(6);
    const result = await summarizeChunk(messages, defaultPlan, 'sess-123', 5, 10);

    expect(result.id).toBe('test-uuid-001');
    expect(result.sessionId).toBe('sess-123');
    expect(result.msgStartIdx).toBe(5);
    expect(result.msgEndIdx).toBe(10);
    expect(result.msgCount).toBe(6);
    expect(result.model).toBe('gemma3:12b');
    expect(result.promptTokens).toBeGreaterThan(0);
    expect(result.outputTokens).toBeGreaterThan(0);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });
});
