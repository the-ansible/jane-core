/**
 * Tests for memory/session-chunker.ts — JSONL reader and episode chunker.
 */

import { describe, it, expect } from 'vitest';
import { chunkMessages, formatChunkAsText } from './session-chunker.js';
import type { RawMessage } from './session-chunker.js';

const makeMessages = (count: number, startHour = 0): RawMessage[] =>
  Array.from({ length: count }, (_, i) => ({
    role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
    content: `Message content ${i}`,
    timestamp: new Date(2026, 2, 4, startHour + i).toISOString(),
  }));

describe('chunkMessages', () => {
  it('returns empty array for no messages', () => {
    expect(chunkMessages('sess-1', [])).toEqual([]);
  });

  it('creates single chunk for messages under chunk size', () => {
    const msgs = makeMessages(5);
    const chunks = chunkMessages('sess-1', msgs);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].messages).toHaveLength(5);
    expect(chunks[0].sessionId).toBe('sess-1');
    expect(chunks[0].tsStart).toBe(msgs[0].timestamp);
    expect(chunks[0].tsEnd).toBe(msgs[4].timestamp);
  });

  it('creates multiple chunks for large message count', () => {
    const msgs = makeMessages(32);
    const chunks = chunkMessages('sess-2', msgs);
    // 32 messages, chunk size 15 → 3 chunks (15 + 15 + 2)
    expect(chunks).toHaveLength(3);
    expect(chunks[0].messages).toHaveLength(15);
    expect(chunks[1].messages).toHaveLength(15);
    expect(chunks[2].messages).toHaveLength(2);
  });

  it('sets correct timestamps for each chunk', () => {
    const msgs = makeMessages(16);
    const chunks = chunkMessages('sess-3', msgs);
    expect(chunks[0].tsStart).toBe(msgs[0].timestamp);
    expect(chunks[0].tsEnd).toBe(msgs[14].timestamp);
    expect(chunks[1].tsStart).toBe(msgs[15].timestamp);
    expect(chunks[1].tsEnd).toBe(msgs[15].timestamp);
  });

  it('produces exactly chunk-size messages per chunk', () => {
    const msgs = makeMessages(15);
    const chunks = chunkMessages('sess-4', msgs);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].messages).toHaveLength(15);
  });
});

describe('formatChunkAsText', () => {
  it('formats user messages as Chris', () => {
    const msgs: RawMessage[] = [
      { role: 'user', content: 'Hello there', timestamp: '2026-03-04T00:00:00Z' },
    ];
    const text = formatChunkAsText(msgs);
    expect(text).toBe('Chris: Hello there');
  });

  it('formats assistant messages as Jane', () => {
    const msgs: RawMessage[] = [
      { role: 'assistant', content: 'Hi!', timestamp: '2026-03-04T00:00:00Z' },
    ];
    const text = formatChunkAsText(msgs);
    expect(text).toBe('Jane: Hi!');
  });

  it('formats mixed conversation correctly', () => {
    const msgs: RawMessage[] = [
      { role: 'user', content: 'What time is it?', timestamp: '2026-03-04T00:00:00Z' },
      { role: 'assistant', content: "It's noon.", timestamp: '2026-03-04T00:01:00Z' },
    ];
    const text = formatChunkAsText(msgs);
    expect(text).toBe("Chris: What time is it?\nJane: It's noon.");
  });
});
