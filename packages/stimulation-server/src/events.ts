import type { CommunicationEvent } from '@the-ansible/life-system-shared';

export type { CommunicationEvent };

export interface StoredEvent {
  event: CommunicationEvent;
  subject: string;
  receivedAt: string;
}

const MAX_EVENTS = 50;
const buffer: StoredEvent[] = [];

type EventListener = (stored: StoredEvent) => void;
const listeners = new Set<EventListener>();

export function onEvent(callback: EventListener): () => void {
  listeners.add(callback);
  return () => { listeners.delete(callback); };
}

export function pushEvent(event: CommunicationEvent, subject: string): void {
  const stored: StoredEvent = {
    event,
    subject,
    receivedAt: new Date().toISOString(),
  };
  buffer.push(stored);
  if (buffer.length > MAX_EVENTS) {
    buffer.shift();
  }
  for (const listener of listeners) {
    try { listener(stored); } catch { /* ignore listener errors */ }
  }
}

export function getRecentEvents(limit: number = 20): StoredEvent[] {
  return buffer.slice(-limit);
}

export function clearEvents(): void {
  buffer.length = 0;
  listeners.clear();
}
