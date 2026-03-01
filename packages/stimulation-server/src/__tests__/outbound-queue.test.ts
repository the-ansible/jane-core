import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  enqueueForRetry,
  getQueueStatus,
  clearQueue,
} from '../outbound-queue.js';

describe('Outbound Retry Queue', () => {
  beforeEach(() => {
    clearQueue();
  });

  describe('enqueueForRetry', () => {
    it('adds a message to the queue', () => {
      enqueueForRetry('communication.outbound.message', { id: '1' }, 'sess-1', 'evt-1');
      const status = getQueueStatus();
      expect(status.size).toBe(1);
      expect(status.messages[0].subject).toBe('communication.outbound.message');
      expect(status.messages[0].eventId).toBe('evt-1');
      expect(status.messages[0].sessionId).toBe('sess-1');
      expect(status.messages[0].attempts).toBe(0);
    });

    it('queues multiple messages', () => {
      enqueueForRetry('sub.1', { id: '1' }, 'sess-1', 'evt-1');
      enqueueForRetry('sub.2', { id: '2' }, 'sess-2', 'evt-2');
      enqueueForRetry('sub.3', { id: '3' }, 'sess-3', 'evt-3');
      expect(getQueueStatus().size).toBe(3);
    });

    it('drops oldest when queue is full (50 max)', () => {
      for (let i = 0; i < 50; i++) {
        enqueueForRetry('sub', { id: String(i) }, 'sess', `evt-${i}`);
      }
      expect(getQueueStatus().size).toBe(50);

      // Adding one more should drop the oldest
      enqueueForRetry('sub', { id: '50' }, 'sess', 'evt-50');
      expect(getQueueStatus().size).toBe(50);
      // First item should now be evt-1 (evt-0 was dropped)
      expect(getQueueStatus().messages[0].eventId).toBe('evt-1');
      expect(getQueueStatus().messages[49].eventId).toBe('evt-50');
    });
  });

  describe('getQueueStatus', () => {
    it('returns empty status when no messages', () => {
      const status = getQueueStatus();
      expect(status.size).toBe(0);
      expect(status.oldest).toBeNull();
      expect(status.messages).toEqual([]);
    });

    it('returns oldest timestamp', () => {
      enqueueForRetry('sub', { id: '1' }, 'sess', 'evt-1');
      const status = getQueueStatus();
      expect(status.oldest).toBeTruthy();
      expect(new Date(status.oldest!).getTime()).toBeGreaterThan(0);
    });

    it('returns a copy of the messages array', () => {
      enqueueForRetry('sub', { id: '1' }, 'sess', 'evt-1');
      const status1 = getQueueStatus();
      const status2 = getQueueStatus();
      expect(status1.messages).not.toBe(status2.messages); // Different array references
      expect(status1.messages).toEqual(status2.messages); // Same content
    });
  });

  describe('clearQueue', () => {
    it('empties the queue', () => {
      enqueueForRetry('sub', { id: '1' }, 'sess', 'evt-1');
      enqueueForRetry('sub', { id: '2' }, 'sess', 'evt-2');
      expect(getQueueStatus().size).toBe(2);

      clearQueue();
      expect(getQueueStatus().size).toBe(0);
    });
  });
});
