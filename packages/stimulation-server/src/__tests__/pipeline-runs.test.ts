import { describe, it, expect, beforeEach } from 'vitest';
import {
  startRun,
  beginStage,
  completeStage,
  failStage,
  completeRun,
  getActiveRuns,
  getRecentRuns,
  getRun,
  onRunUpdate,
  cleanupOrphanedRuns,
  clearRuns,
} from '../pipeline-runs.js';

function makeRun(id: string = 'run-1') {
  return startRun({
    runId: id,
    sessionId: 'sess-1',
    channelType: 'realtime',
    senderName: 'Chris',
    contentPreview: 'Hey Jane',
    classification: 'reflexive_reply',
  });
}

describe('PipelineRuns', () => {
  beforeEach(() => {
    clearRuns();
  });

  describe('startRun', () => {
    it('creates a running pipeline run', () => {
      const run = makeRun();
      expect(run.runId).toBe('run-1');
      expect(run.status).toBe('running');
      expect(run.currentStage).toBeNull();
      expect(run.stages).toEqual([]);
      expect(run.startedAt).toBeDefined();
    });

    it('adds run to active runs', () => {
      makeRun();
      expect(getActiveRuns()).toHaveLength(1);
    });

    it('evicts oldest when at max capacity', () => {
      for (let i = 0; i < 21; i++) {
        makeRun(`run-${i}`);
      }
      // Should have evicted the first one
      expect(getActiveRuns()).toHaveLength(20);
      expect(getRun('run-0')).toBeDefined(); // moved to recent
      expect(getRun('run-0')!.status).toBe('failure');
    });
  });

  describe('stage lifecycle', () => {
    it('tracks stage begin and complete', () => {
      makeRun();
      beginStage('run-1', 'routing');
      let run = getRun('run-1')!;
      expect(run.currentStage).toBe('routing');
      expect(run.stages).toHaveLength(1);
      expect(run.stages[0].status).toBe('running');

      completeStage('run-1', 'routing', 'reply');
      run = getRun('run-1')!;
      expect(run.stages[0].status).toBe('success');
      expect(run.stages[0].durationMs).toBeGreaterThanOrEqual(0);
      expect(run.stages[0].detail).toBe('reply');
    });

    it('tracks stage failure', () => {
      makeRun();
      beginStage('run-1', 'agent');
      failStage('run-1', 'agent', 'Agent timeout');
      const run = getRun('run-1')!;
      expect(run.stages[0].status).toBe('failure');
      expect(run.stages[0].error).toBe('Agent timeout');
    });

    it('ignores operations on non-existent runs', () => {
      beginStage('nonexistent', 'routing');
      completeStage('nonexistent', 'routing');
      failStage('nonexistent', 'routing', 'error');
      completeRun('nonexistent', 'failure');
      // No errors thrown
    });
  });

  describe('completeRun', () => {
    it('moves run from active to recent', () => {
      makeRun();
      expect(getActiveRuns()).toHaveLength(1);
      expect(getRecentRuns()).toHaveLength(0);

      completeRun('run-1', 'success', { routeAction: 'reply' });
      expect(getActiveRuns()).toHaveLength(0);
      expect(getRecentRuns()).toHaveLength(1);
    });

    it('sets completion fields', () => {
      makeRun();
      completeRun('run-1', 'failure', { routeAction: 'reply', error: 'Agent timeout' });
      const run = getRun('run-1')!;
      expect(run.status).toBe('failure');
      expect(run.completedAt).toBeDefined();
      expect(run.totalMs).toBeGreaterThanOrEqual(0);
      expect(run.error).toBe('Agent timeout');
      expect(run.routeAction).toBe('reply');
    });

    it('completes dangling running stages', () => {
      makeRun();
      beginStage('run-1', 'agent');
      completeRun('run-1', 'failure', { error: 'Crashed' });
      const run = getRun('run-1')!;
      expect(run.stages[0].status).toBe('failure');
      expect(run.stages[0].error).toBe('Crashed');
    });
  });

  describe('queries', () => {
    it('getRun finds active runs', () => {
      makeRun('active-1');
      expect(getRun('active-1')).toBeDefined();
    });

    it('getRun finds recent runs', () => {
      makeRun('recent-1');
      completeRun('recent-1', 'success');
      expect(getRun('recent-1')).toBeDefined();
    });

    it('getRun returns undefined for unknown', () => {
      expect(getRun('unknown')).toBeUndefined();
    });

    it('getRecentRuns respects limit', () => {
      for (let i = 0; i < 10; i++) {
        makeRun(`r-${i}`);
        completeRun(`r-${i}`, 'success');
      }
      expect(getRecentRuns(3)).toHaveLength(3);
    });
  });

  describe('listeners', () => {
    it('notifies on startRun', () => {
      const updates: string[] = [];
      onRunUpdate((run) => updates.push(run.runId));
      makeRun('listen-1');
      expect(updates).toEqual(['listen-1']);
    });

    it('notifies on stage changes', () => {
      const updates: string[] = [];
      onRunUpdate((run) => updates.push(`${run.runId}:${run.currentStage}`));
      makeRun('listen-2');
      beginStage('listen-2', 'routing');
      completeStage('listen-2', 'routing');
      expect(updates.length).toBe(3); // start + begin + complete
    });

    it('unsubscribe stops notifications', () => {
      const updates: string[] = [];
      const unsub = onRunUpdate((run) => updates.push(run.runId));
      makeRun('listen-3');
      unsub();
      makeRun('listen-4');
      expect(updates).toEqual(['listen-3']);
    });
  });

  describe('cleanupOrphanedRuns', () => {
    it('cleans up runs older than max age', () => {
      const run = makeRun('orphan-1');
      // Manually backdate
      (run as any).startedAt = new Date(Date.now() - 25 * 60 * 1000).toISOString();
      const cleaned = cleanupOrphanedRuns(20 * 60 * 1000);
      expect(cleaned).toBe(1);
      expect(getActiveRuns()).toHaveLength(0);
      const completed = getRun('orphan-1')!;
      expect(completed.status).toBe('failure');
      expect(completed.error).toContain('Orphaned');
    });

    it('does not clean up recent runs', () => {
      makeRun('fresh-1');
      const cleaned = cleanupOrphanedRuns();
      expect(cleaned).toBe(0);
      expect(getActiveRuns()).toHaveLength(1);
    });
  });

  describe('clearRuns', () => {
    it('clears all state', () => {
      makeRun('clear-1');
      completeRun('clear-1', 'success');
      makeRun('clear-2');
      clearRuns();
      expect(getActiveRuns()).toHaveLength(0);
      expect(getRecentRuns()).toHaveLength(0);
    });
  });
});
