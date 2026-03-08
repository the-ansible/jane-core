import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseClassificationResponse, majorityVote, classifyByConsensus } from '../classifier/ollama.js';
import type { Classification } from '../classifier/types.js';
import type { ClassificationContext } from '../classifier/types.js';

// Mock executor client
const mockInvoke = vi.fn();
vi.mock('../executor-client.js', () => ({
  invoke: (...args: any[]) => mockInvoke(...args),
}));

function makeCtx(content = 'test message'): ClassificationContext {
  return {
    content,
    channelType: 'slack',
    sessionState: 'active_conversation',
  };
}

describe('parseClassificationResponse', () => {
  it('parses clean JSON', () => {
    const result = parseClassificationResponse(
      '{"urgency":"normal","category":"question","routing":"deliberate_thought"}'
    );
    expect(result).toEqual({
      urgency: 'normal',
      category: 'question',
      routing: 'deliberate_thought',
    });
  });

  it('parses JSON wrapped in markdown code block', () => {
    const result = parseClassificationResponse(
      '```json\n{"urgency":"low","category":"social","routing":"reflexive_reply"}\n```'
    );
    expect(result).toEqual({
      urgency: 'low',
      category: 'social',
      routing: 'reflexive_reply',
    });
  });

  it('extracts JSON from surrounding text', () => {
    const result = parseClassificationResponse(
      'Here is the classification:\n{"urgency":"immediate","category":"alert","routing":"escalate"}\nDone.'
    );
    expect(result).toEqual({
      urgency: 'immediate',
      category: 'alert',
      routing: 'escalate',
    });
  });

  it('returns null for invalid urgency', () => {
    const result = parseClassificationResponse(
      '{"urgency":"super_urgent","category":"question","routing":"deliberate_thought"}'
    );
    expect(result).toBeNull();
  });

  it('returns null for no JSON', () => {
    expect(parseClassificationResponse('I think this is a question')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseClassificationResponse('')).toBeNull();
  });
});

describe('majorityVote', () => {
  const q: Classification = { urgency: 'normal', category: 'question', routing: 'deliberate_thought' };
  const s: Classification = { urgency: 'low', category: 'social', routing: 'reflexive_reply' };
  const a: Classification = { urgency: 'immediate', category: 'alert', routing: 'escalate' };

  it('3/3 agreement → high confidence', () => {
    const result = majorityVote([q, q, q]);
    expect(result).not.toBeNull();
    expect(result!.classification).toEqual(q);
    expect(result!.agreeing).toBe(3);
    expect(result!.confidence).toBe('high');
  });

  it('2/3 agreement → medium confidence', () => {
    const result = majorityVote([q, q, s]);
    expect(result).not.toBeNull();
    expect(result!.classification).toEqual(q);
    expect(result!.agreeing).toBe(2);
    expect(result!.confidence).toBe('medium');
  });

  it('all different → low confidence', () => {
    const result = majorityVote([q, s, a]);
    expect(result).not.toBeNull();
    expect(result!.agreeing).toBe(1);
    expect(result!.confidence).toBe('low');
  });

  it('handles null votes', () => {
    const result = majorityVote([q, null, q]);
    expect(result).not.toBeNull();
    expect(result!.agreeing).toBe(2);
  });

  it('returns null for all null votes', () => {
    expect(majorityVote([null, null, null])).toBeNull();
  });
});

describe('classifyByConsensus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns consensus when 3/3 agree', async () => {
    const mockResponse = { urgency: 'normal', category: 'question', routing: 'deliberate_thought' };

    mockInvoke.mockResolvedValue({
      success: true,
      resultText: JSON.stringify(mockResponse),
      durationMs: 10,
    });

    const result = await classifyByConsensus(makeCtx('What is this?'));
    expect(result).not.toBeNull();
    expect(result!.classification).toEqual(mockResponse);
    expect(result!.agreement.agreeing).toBe(3);
    expect(result!.confidence).toBe('high');
  });

  it('returns null when all calls fail', async () => {
    mockInvoke.mockRejectedValue(new Error('connection refused'));

    const result = await classifyByConsensus(makeCtx('test'));
    expect(result).toBeNull();
  });

  it('returns null when models all disagree', async () => {
    const responses = [
      { urgency: 'normal', category: 'question', routing: 'deliberate_thought' },
      { urgency: 'low', category: 'social', routing: 'reflexive_reply' },
      { urgency: 'immediate', category: 'alert', routing: 'escalate' },
    ];

    let callNum = 0;
    mockInvoke.mockImplementation(async () => ({
      success: true,
      resultText: JSON.stringify(responses[callNum++]),
      durationMs: 10,
    }));

    const result = await classifyByConsensus(makeCtx('ambiguous message'));
    // All disagree — should return null (no consensus)
    expect(result).toBeNull();
  });

  it('returns consensus when 2/3 agree with one failure', async () => {
    let callNum = 0;
    mockInvoke.mockImplementation(async () => {
      callNum++;
      if (callNum === 2) {
        return { success: false, resultText: null, durationMs: 10, error: 'timeout' };
      }
      return {
        success: true,
        resultText: '{"urgency":"low","category":"social","routing":"reflexive_reply"}',
        durationMs: 10,
      };
    });

    const result = await classifyByConsensus(makeCtx('hello'));
    expect(result).not.toBeNull();
    expect(result!.agreement.votes).toBe(2);
    expect(result!.agreement.agreeing).toBe(2);
  });
});
