import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  recordTimelineEvent,
  recordTimelineDedup,
  recordTimelineError,
  getTimeline,
  resetTimeline,
} from '../event-timeline.js';

describe('Event Timeline', () => {
  beforeEach(() => {
    resetTimeline();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('places events in correct time buckets', () => {
    vi.useFakeTimers();
    const base = Math.floor(Date.now() / 60_000) * 60_000;
    vi.setSystemTime(base + 5_000); // 5s into bucket
    recordTimelineEvent({ channelType: 'slack', direction: 'inbound', tier: 'rules' });

    vi.setSystemTime(base + 65_000); // 5s into next bucket
    recordTimelineEvent({ channelType: 'slack', direction: 'inbound', tier: 'rules' });

    const timeline = getTimeline();
    expect(timeline).toHaveLength(2);
    expect(timeline[0].startMs).toBe(base);
    expect(timeline[0].total).toBe(1);
    expect(timeline[1].startMs).toBe(base + 60_000);
    expect(timeline[1].total).toBe(1);
  });

  it('aggregates dimensional breakdowns', () => {
    recordTimelineEvent({ channelType: 'slack', direction: 'inbound', tier: 'rules', urgency: 'normal', category: 'conversation', routing: 'reply' });
    recordTimelineEvent({ channelType: 'realtime', direction: 'outbound', tier: 'local_consensus', urgency: 'immediate', category: 'task', routing: 'execute' });
    recordTimelineEvent({ channelType: 'slack', direction: 'inbound', tier: 'rules', urgency: 'normal', category: 'conversation', routing: 'reply' });

    const timeline = getTimeline();
    expect(timeline).toHaveLength(1);
    const bucket = timeline[0];

    expect(bucket.total).toBe(3);
    expect(bucket.classified).toBe(3);
    expect(bucket.byChannel).toEqual({ slack: 2, realtime: 1 });
    expect(bucket.byTier).toEqual({ rules: 2, local_consensus: 1 });
    expect(bucket.byDirection).toEqual({ inbound: 2, outbound: 1 });
    expect(bucket.byUrgency).toEqual({ normal: 2, immediate: 1 });
    expect(bucket.byCategory).toEqual({ conversation: 2, task: 1 });
    expect(bucket.byRouting).toEqual({ reply: 2, execute: 1 });
  });

  it('tracks dedup counter', () => {
    recordTimelineDedup();
    recordTimelineDedup();
    recordTimelineEvent({ channelType: 'slack' });

    const timeline = getTimeline();
    expect(timeline).toHaveLength(1);
    expect(timeline[0].deduplicated).toBe(2);
    expect(timeline[0].total).toBe(3); // 2 dedup + 1 event
    expect(timeline[0].classified).toBe(1);
  });

  it('tracks error counter', () => {
    recordTimelineError();
    recordTimelineError();

    const timeline = getTimeline();
    expect(timeline).toHaveLength(1);
    expect(timeline[0].errors).toBe(2);
    expect(timeline[0].total).toBe(0); // errors don't increment total
  });

  it('prunes buckets older than 60 minutes', () => {
    vi.useFakeTimers();
    const base = Math.floor(Date.now() / 60_000) * 60_000;

    // Record in a bucket 61 minutes ago
    vi.setSystemTime(base - 61 * 60_000);
    recordTimelineEvent({ channelType: 'slack' });

    // Record in current bucket
    vi.setSystemTime(base);
    recordTimelineEvent({ channelType: 'slack' });

    const timeline = getTimeline();
    expect(timeline).toHaveLength(1);
    expect(timeline[0].startMs).toBe(base);
  });

  it('resetTimeline clears all state', () => {
    recordTimelineEvent({ channelType: 'slack' });
    recordTimelineDedup();
    recordTimelineError();

    expect(getTimeline()).toHaveLength(1);
    resetTimeline();
    expect(getTimeline()).toHaveLength(0);
  });

  it('handles undefined dimension values gracefully', () => {
    recordTimelineEvent({});
    const timeline = getTimeline();
    expect(timeline).toHaveLength(1);
    expect(timeline[0].total).toBe(1);
    expect(timeline[0].byChannel).toEqual({});
    expect(timeline[0].byTier).toEqual({});
  });

  it('returns buckets sorted by time', () => {
    vi.useFakeTimers();
    const base = Math.floor(Date.now() / 60_000) * 60_000;

    // Insert in reverse order
    vi.setSystemTime(base + 120_000);
    recordTimelineEvent({ channelType: 'slack' });
    vi.setSystemTime(base);
    recordTimelineEvent({ channelType: 'slack' });
    vi.setSystemTime(base + 60_000);
    recordTimelineEvent({ channelType: 'slack' });

    const timeline = getTimeline();
    expect(timeline).toHaveLength(3);
    expect(timeline[0].startMs).toBe(base);
    expect(timeline[1].startMs).toBe(base + 60_000);
    expect(timeline[2].startMs).toBe(base + 120_000);
  });
});
