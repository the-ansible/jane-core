import type { z } from 'zod';
import type { communicationEventSchema } from '@the-ansible/life-system-shared';

export type CommunicationEvent = z.infer<typeof communicationEventSchema>;

export interface StoredEvent {
  event: CommunicationEvent;
  subject: string;
  receivedAt: string;
}

const MAX_EVENTS = 50;
const buffer: StoredEvent[] = [];

export function pushEvent(event: CommunicationEvent, subject: string): void {
  buffer.push({
    event,
    subject,
    receivedAt: new Date().toISOString(),
  });
  if (buffer.length > MAX_EVENTS) {
    buffer.shift();
  }
}

export function getRecentEvents(limit: number = 20): StoredEvent[] {
  return buffer.slice(-limit);
}

export function clearEvents(): void {
  buffer.length = 0;
}
