import { describe, it, expect } from 'vitest';
import { communicationEventSchema } from '@the-ansible/life-system-shared';

const validEvent = {
  id: '019502e4-1234-7000-8000-000000000001',
  sessionId: 'session-abc',
  channelType: 'message',
  direction: 'inbound' as const,
  contentType: 'markdown' as const,
  content: 'Hello from Slack',
  metadata: {},
  timestamp: '2026-02-28T12:00:00.000Z',
};

describe('communicationEventSchema validation', () => {
  it('accepts a valid event', () => {
    const result = communicationEventSchema.safeParse(validEvent);
    expect(result.success).toBe(true);
  });

  it('accepts event with parentId', () => {
    const result = communicationEventSchema.safeParse({
      ...validEvent,
      parentId: '019502e4-1234-7000-8000-000000000002',
    });
    expect(result.success).toBe(true);
  });

  it('applies default metadata when omitted', () => {
    const { metadata, ...withoutMeta } = validEvent;
    const result = communicationEventSchema.safeParse(withoutMeta);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.metadata).toEqual({});
    }
  });

  it('rejects missing required fields', () => {
    const result = communicationEventSchema.safeParse({ id: validEvent.id });
    expect(result.success).toBe(false);
  });

  it('rejects invalid direction', () => {
    const result = communicationEventSchema.safeParse({
      ...validEvent,
      direction: 'sideways',
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid contentType', () => {
    const result = communicationEventSchema.safeParse({
      ...validEvent,
      contentType: 'html',
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid timestamp format', () => {
    const result = communicationEventSchema.safeParse({
      ...validEvent,
      timestamp: 'not-a-date',
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-uuid id', () => {
    const result = communicationEventSchema.safeParse({
      ...validEvent,
      id: 'not-a-uuid',
    });
    expect(result.success).toBe(false);
  });
});
