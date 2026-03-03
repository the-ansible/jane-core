import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the DB module
const mockQuery = vi.fn();
vi.mock('../context/db.js', () => ({
  db: {
    query: (...args: any[]) => mockQuery(...args),
    exec: vi.fn(),
  },
  initializeContextDb: vi.fn(),
  _resetPool: vi.fn(),
}));

import {
  getActivePlan,
  resolvePlan,
  listPlans,
  createPlan,
  setActivePlan,
  _resetPlanCache,
} from '../context/plans.js';
import type { ContextPlanConfig } from '../context/types.js';

const basePlan: ContextPlanConfig = {
  summaryChunkSize: 6,
  summaryModel: 'gemma3:12b',
  summaryPromptTemplate: 'default_v1',
  rawSummarizationThreshold: 12,
  maxSummaries: 10,
  modelContextSize: 200000,
  tokenBudgetPct: 0.06,
  composer: { maxSummaries: 3, tokenBudgetPct: 0.02 },
  topicTrackingEnabled: false,
  associativeRetrievalEnabled: false,
};

describe('Context Plans', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetPlanCache();
  });

  describe('getActivePlan', () => {
    it('returns the active plan from DB', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ name: 'baseline_v1', config: basePlan }],
      });

      const result = await getActivePlan();

      expect(result.name).toBe('baseline_v1');
      expect(result.config.summaryChunkSize).toBe(6);
      expect(result.config.modelContextSize).toBe(200000);
    });

    it('caches the active plan for 30s', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ name: 'baseline_v1', config: basePlan }],
      });

      await getActivePlan();
      await getActivePlan();
      await getActivePlan();

      // Only one DB query despite 3 calls
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    it('throws when no active plan exists', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await expect(getActivePlan()).rejects.toThrow('No active context plan found');
    });

    it('handles config as JSON string', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ name: 'test', config: JSON.stringify(basePlan) }],
      });

      const result = await getActivePlan();
      expect(result.config.summaryChunkSize).toBe(6);
    });
  });

  describe('resolvePlan', () => {
    it('applies agent overrides (none by default)', () => {
      const resolved = resolvePlan(basePlan, 'agent');
      expect(resolved.maxSummaries).toBe(10);
      expect(resolved.tokenBudgetPct).toBe(0.06);
    });

    it('applies composer overrides', () => {
      const resolved = resolvePlan(basePlan, 'composer');
      expect(resolved.maxSummaries).toBe(3);
      expect(resolved.tokenBudgetPct).toBe(0.02);
    });

    it('falls back to base values when no overrides', () => {
      const planNoOverrides = { ...basePlan, composer: undefined };
      const resolved = resolvePlan(planNoOverrides, 'composer');
      expect(resolved.maxSummaries).toBe(10);
      expect(resolved.tokenBudgetPct).toBe(0.06);
    });
  });

  describe('listPlans', () => {
    it('returns all plans', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          { name: 'baseline_v1', config: basePlan, is_active: true },
          { name: 'aggressive_v1', config: { ...basePlan, rawSummarizationThreshold: 6 }, is_active: false },
        ],
      });

      const plans = await listPlans();
      expect(plans).toHaveLength(2);
      expect(plans[0].name).toBe('baseline_v1');
    });
  });

  describe('createPlan', () => {
    it('inserts a new plan', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      await createPlan('test_plan', basePlan, 'A test plan');

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO context.plans'),
        ['test_plan', JSON.stringify(basePlan), 'A test plan']
      );
    });
  });

  describe('setActivePlan', () => {
    it('deactivates all plans then activates the named one', async () => {
      // First call: deactivate all
      mockQuery.mockResolvedValueOnce({ rows: [] });
      // Second call: activate named plan
      mockQuery.mockResolvedValueOnce({ rows: [{ name: 'new_plan' }] });

      await setActivePlan('new_plan');

      expect(mockQuery).toHaveBeenCalledTimes(2);
      expect(mockQuery.mock.calls[0][0]).toContain('is_active = FALSE');
      expect(mockQuery.mock.calls[1][0]).toContain('is_active = TRUE');
    });

    it('throws when plan name not found', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] }); // deactivate all
      mockQuery.mockResolvedValueOnce({ rows: [] }); // no matching plan

      await expect(setActivePlan('nonexistent')).rejects.toThrow('not found');
    });

    it('invalidates the plan cache', async () => {
      // Load plan into cache
      mockQuery.mockResolvedValueOnce({
        rows: [{ name: 'baseline_v1', config: basePlan }],
      });
      await getActivePlan();

      // setActivePlan should invalidate
      mockQuery.mockResolvedValueOnce({ rows: [] }); // deactivate
      mockQuery.mockResolvedValueOnce({ rows: [{ name: 'new_plan' }] }); // activate
      await setActivePlan('new_plan');

      // Next getActivePlan should hit DB again
      mockQuery.mockResolvedValueOnce({
        rows: [{ name: 'new_plan', config: basePlan }],
      });
      const result = await getActivePlan();
      expect(result.name).toBe('new_plan');
    });
  });
});
