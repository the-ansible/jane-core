import { describe, it, expect } from 'vitest';
import { parseClassificationResponse, majorityVote, classifyByConsensus } from '../classifier/ollama.js';
import type { Classification } from '../classifier/types.js';

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
  it('returns consensus when 3/3 agree', async () => {
    const mockResponse = { urgency: 'normal', category: 'question', routing: 'deliberate_thought' };

    const mockFetch = async () => ({
      ok: true,
      json: async () => ({ response: JSON.stringify(mockResponse) }),
    } as Response);

    const result = await classifyByConsensus('What is this?', mockFetch);
    expect(result).not.toBeNull();
    expect(result!.classification).toEqual(mockResponse);
    expect(result!.agreement.agreeing).toBe(3);
    expect(result!.confidence).toBe('high');
  });

  it('returns null when all calls fail', async () => {
    const mockFetch = async () => {
      throw new Error('connection refused');
    };

    const result = await classifyByConsensus('test', mockFetch as unknown as typeof fetch);
    expect(result).toBeNull();
  });

  it('returns null when models all disagree', async () => {
    let callNum = 0;
    const responses = [
      { urgency: 'normal', category: 'question', routing: 'deliberate_thought' },
      { urgency: 'low', category: 'social', routing: 'reflexive_reply' },
      { urgency: 'immediate', category: 'alert', routing: 'escalate' },
    ];

    const mockFetch = async () => ({
      ok: true,
      json: async () => ({ response: JSON.stringify(responses[callNum++]) }),
    } as Response);

    const result = await classifyByConsensus('ambiguous message', mockFetch);
    // All disagree — should return null (no consensus)
    expect(result).toBeNull();
  });

  it('returns consensus when 2/3 agree with one null', async () => {
    let callNum = 0;
    const mockFetch = async () => {
      callNum++;
      if (callNum === 2) {
        return { ok: false, json: async () => ({}) } as Response;
      }
      return {
        ok: true,
        json: async () => ({
          response: '{"urgency":"low","category":"social","routing":"reflexive_reply"}',
        }),
      } as Response;
    };

    const result = await classifyByConsensus('hello', mockFetch);
    expect(result).not.toBeNull();
    expect(result!.agreement.votes).toBe(2);
    expect(result!.agreement.agreeing).toBe(2);
  });
});
