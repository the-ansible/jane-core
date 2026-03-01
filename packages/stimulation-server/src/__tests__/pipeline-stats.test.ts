import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordPipelineOutcome,
  getPipelineStats,
  resetPipelineStats,
} from '../pipeline-stats.js';

describe('Pipeline Stats', () => {
  beforeEach(() => {
    resetPipelineStats();
  });

  describe('recordPipelineOutcome', () => {
    it('tracks total count', () => {
      recordPipelineOutcome({ action: 'log', responded: false, totalMs: 5 });
      recordPipelineOutcome({ action: 'reply', responded: true, totalMs: 12000 });
      const stats = getPipelineStats();
      expect(stats.total).toBe(2);
    });

    it('tracks responded count and rate', () => {
      recordPipelineOutcome({ action: 'reply', responded: true, totalMs: 10000 });
      recordPipelineOutcome({ action: 'reply', responded: true, totalMs: 11000 });
      recordPipelineOutcome({ action: 'reply', responded: false, totalMs: 5000, error: 'Agent failed' });
      const stats = getPipelineStats();
      expect(stats.responded).toBe(2);
      expect(stats.failed).toBe(1);
      expect(stats.responseRate).toBeCloseTo(0.667, 2);
    });

    it('tracks by action type', () => {
      recordPipelineOutcome({ action: 'log', responded: false, totalMs: 1 });
      recordPipelineOutcome({ action: 'log', responded: false, totalMs: 1 });
      recordPipelineOutcome({ action: 'reply', responded: true, totalMs: 10000 });
      recordPipelineOutcome({ action: 'think', responded: true, totalMs: 15000 });

      const stats = getPipelineStats();
      expect(stats.byAction['log']).toEqual({ count: 2, responded: 0 });
      expect(stats.byAction['reply']).toEqual({ count: 1, responded: 1 });
      expect(stats.byAction['think']).toEqual({ count: 1, responded: 1 });
    });

    it('tracks recent errors', () => {
      recordPipelineOutcome({ action: 'reply', responded: false, totalMs: 5000, error: 'Agent timeout' });
      recordPipelineOutcome({ action: 'reply', responded: false, totalMs: 3000, error: 'NATS down' });

      const stats = getPipelineStats();
      expect(stats.recentErrors.length).toBe(2);
      expect(stats.recentErrors[0]).toContain('Agent timeout');
      expect(stats.recentErrors[1]).toContain('NATS down');
    });

    it('caps recent errors at 20', () => {
      for (let i = 0; i < 25; i++) {
        recordPipelineOutcome({ action: 'reply', responded: false, totalMs: 1000, error: `Error ${i}` });
      }

      const stats = getPipelineStats();
      expect(stats.recentErrors.length).toBe(20);
      expect(stats.recentErrors[0]).toContain('Error 5');
      expect(stats.recentErrors[19]).toContain('Error 24');
    });
  });

  describe('latency tracking', () => {
    it('computes agent latency percentiles', () => {
      for (let i = 1; i <= 100; i++) {
        recordPipelineOutcome({
          action: 'reply', responded: true,
          agentMs: i * 100,
          composerMs: 5000,
          totalMs: i * 100 + 5000,
        });
      }

      const stats = getPipelineStats();
      expect(stats.latency.agent.count).toBe(100);
      expect(stats.latency.agent.p50).toBe(5000); // ~50th value
      expect(stats.latency.agent.p95).toBe(9500); // ~95th value
      expect(stats.latency.agent.min).toBe(100);
      expect(stats.latency.agent.max).toBe(10000);
      expect(stats.latency.agent.avg).toBe(5050); // mean of 100..10000
    });

    it('computes composer latency separately', () => {
      recordPipelineOutcome({
        action: 'reply', responded: true,
        agentMs: 6000, composerMs: 4000, totalMs: 10000,
      });
      recordPipelineOutcome({
        action: 'reply', responded: true,
        agentMs: 8000, composerMs: 5000, totalMs: 13000,
      });

      const stats = getPipelineStats();
      expect(stats.latency.composer.count).toBe(2);
      expect(stats.latency.composer.avg).toBe(4500);
      expect(stats.latency.total.avg).toBe(11500);
    });

    it('handles log-only actions with no agent/composer latency', () => {
      recordPipelineOutcome({ action: 'log', responded: false, totalMs: 2 });

      const stats = getPipelineStats();
      expect(stats.latency.total.count).toBe(1);
      expect(stats.latency.agent.count).toBe(0);
      expect(stats.latency.composer.count).toBe(0);
    });

    it('returns null percentiles when no samples', () => {
      const stats = getPipelineStats();
      expect(stats.latency.agent.p50).toBeNull();
      expect(stats.latency.agent.p95).toBeNull();
      expect(stats.latency.agent.avg).toBeNull();
    });
  });

  describe('resetPipelineStats', () => {
    it('resets all counters', () => {
      recordPipelineOutcome({ action: 'reply', responded: true, agentMs: 5000, composerMs: 3000, totalMs: 8000 });
      recordPipelineOutcome({ action: 'reply', responded: false, totalMs: 1000, error: 'fail' });

      resetPipelineStats();

      const stats = getPipelineStats();
      expect(stats.total).toBe(0);
      expect(stats.responded).toBe(0);
      expect(stats.failed).toBe(0);
      expect(stats.recentErrors).toEqual([]);
      expect(stats.latency.agent.count).toBe(0);
      expect(Object.keys(stats.byAction)).toHaveLength(0);
    });
  });

  describe('response rate', () => {
    it('returns 0 when no events', () => {
      expect(getPipelineStats().responseRate).toBe(0);
    });

    it('returns 1.0 when all respond', () => {
      recordPipelineOutcome({ action: 'reply', responded: true, totalMs: 10000 });
      recordPipelineOutcome({ action: 'think', responded: true, totalMs: 15000 });
      expect(getPipelineStats().responseRate).toBe(1);
    });

    it('excludes log-only from failed count but includes in total', () => {
      recordPipelineOutcome({ action: 'log', responded: false, totalMs: 1 });
      recordPipelineOutcome({ action: 'reply', responded: true, totalMs: 10000 });

      const stats = getPipelineStats();
      expect(stats.total).toBe(2);
      expect(stats.responded).toBe(1);
      expect(stats.failed).toBe(0); // log-only has no error, so not counted as failed
      expect(stats.responseRate).toBe(0.5);
    });
  });
});
