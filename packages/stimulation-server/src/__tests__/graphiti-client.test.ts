/**
 * Tests for graphiti/client.ts — HTTP wrapper for graphiti-service.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ingestEpisode, searchMemory } from '../graphiti/client.js';
import type { SessionMessage } from '../sessions/store.js';

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

const makeMessages = (count: number): SessionMessage[] =>
  Array.from({ length: count }, (_, i) => ({
    role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
    content: `Message ${i}`,
    timestamp: new Date(2026, 2, 4, i).toISOString(),
  }));

describe('ingestEpisode', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('returns episodeId on success', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ episode_uuid: 'uuid-abc', nodes_created: 2, edges_created: 1 }),
    });

    const result = await ingestEpisode('sess-1', makeMessages(4));

    expect(result.episodeId).toBe('uuid-abc');
    expect(result.error).toBeNull();
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.group_id).toBe('jane');
    expect(body.content).toContain('Chris:');
    expect(body.content).toContain('Jane:');
  });

  it('skips system messages in formatted content', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ episode_uuid: 'uuid-xyz' }),
    });

    const messages: SessionMessage[] = [
      { role: 'system', content: '[Conversation summary]', timestamp: '2026-03-04T00:00:00Z' },
      { role: 'user', content: 'Hello', timestamp: '2026-03-04T01:00:00Z' },
    ];

    await ingestEpisode('sess-2', messages);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.content).not.toContain('[Conversation summary]');
    expect(body.content).toContain('Hello');
  });

  it('returns error on non-200 response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'internal error',
    });

    const result = await ingestEpisode('sess-3', makeMessages(2));
    expect(result.episodeId).toBeNull();
    expect(result.error).toContain('500');
  });

  it('returns error on network failure', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const result = await ingestEpisode('sess-4', makeMessages(2));
    expect(result.episodeId).toBeNull();
    expect(result.error).toContain('ECONNREFUSED');
  });

  it('returns null/null for system-only messages without calling fetch', async () => {
    const messages: SessionMessage[] = [
      { role: 'system', content: 'Summary only', timestamp: '2026-03-04T00:00:00Z' },
    ];
    const result = await ingestEpisode('sess-5', messages);
    expect(result.episodeId).toBeNull();
    expect(result.error).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('searchMemory', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('returns facts on success', async () => {
    const facts = [{ uuid: 'u1', fact: 'Jane likes TypeScript', score: 0.9 }];
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => facts });

    const result = await searchMemory('TypeScript');
    expect(result).toEqual(facts);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.query).toBe('TypeScript');
    expect(body.group_ids).toContain('jane');
  });

  it('returns empty array on network error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'));
    const result = await searchMemory('test');
    expect(result).toEqual([]);
  });

  it('returns empty array on non-200', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false });
    const result = await searchMemory('test');
    expect(result).toEqual([]);
  });
});
