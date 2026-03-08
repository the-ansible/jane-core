/**
 * Tests for the Goal Action Reviewer — prompt building and verdict parsing.
 */

import { describe, it, expect } from 'vitest';
import { buildReviewPrompt, parseReviewVerdict } from './reviewer.js';
import type { Goal, GoalAction } from './types.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeGoal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: 'goal-1',
    title: 'Fix health-check thresholds',
    description: 'Update health-check.sh to use the correct storage baseline of 1800MB',
    motivation: null,
    level: 'tactical',
    priority: 60,
    status: 'active',
    parent_id: null,
    success_criteria: 'health-check.sh uses 2200MB as the warning threshold',
    progress_notes: null,
    last_evaluated_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function makeAction(overrides: Partial<GoalAction> = {}): GoalAction {
  return {
    id: 'action-1',
    goal_id: 'goal-1',
    cycle_id: 'cycle-1',
    description: 'Update the threshold in health-check.sh from 1500 to 2200',
    rationale: 'The current threshold causes false positives',
    status: 'executing',
    score: 8,
    job_id: 'job-1',
    outcome_text: 'Updated health-check.sh line 42: changed threshold from 1500 to 2200MB.',
    review_text: null,
    review_job_id: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildReviewPrompt
// ---------------------------------------------------------------------------

describe('buildReviewPrompt', () => {
  it('includes goal title, description, and success criteria', () => {
    const goal = makeGoal();
    const action = makeAction();
    const prompt = buildReviewPrompt(goal, action, []);

    expect(prompt).toContain(goal.title);
    expect(prompt).toContain(goal.description);
    expect(prompt).toContain(goal.success_criteria!);
  });

  it('includes the current action outcome', () => {
    const action = makeAction({ outcome_text: 'Changed the threshold to 2200MB' });
    const prompt = buildReviewPrompt(makeGoal(), action, []);

    expect(prompt).toContain('Changed the threshold to 2200MB');
  });

  it('includes prior actions with their outcomes and reviews', () => {
    const prior1 = makeAction({
      id: 'prior-1',
      description: 'First attempt at fixing thresholds',
      outcome_text: 'Partially updated',
      review_text: 'Only updated one of two files',
      status: 'done',
    });
    const prior2 = makeAction({
      id: 'prior-2',
      description: 'Second attempt',
      outcome_text: 'Updated wrong file',
      review_text: null,
      status: 'failed',
    });

    const prompt = buildReviewPrompt(makeGoal(), makeAction(), [prior1, prior2]);

    expect(prompt).toContain('First attempt at fixing thresholds');
    expect(prompt).toContain('Only updated one of two files');
    expect(prompt).toContain('Second attempt');
    expect(prompt).toContain('[failed]');
  });

  it('handles missing success criteria gracefully', () => {
    const goal = makeGoal({ success_criteria: null });
    const prompt = buildReviewPrompt(goal, makeAction(), []);

    expect(prompt).not.toContain('Success Criteria');
    expect(prompt).toContain(goal.description);
  });

  it('uses asymptotic-specific instructions for asymptotic goals', () => {
    const goal = makeGoal({ level: 'asymptotic' });
    const prompt = buildReviewPrompt(goal, makeAction(), []);

    expect(prompt).toContain('asymptotic');
    expect(prompt).toContain('never fully');
  });

  it('uses standard instructions for non-asymptotic goals', () => {
    const goal = makeGoal({ level: 'tactical' });
    const prompt = buildReviewPrompt(goal, makeAction(), []);

    expect(prompt).toContain('fully satisfied the goal');
  });
});

// ---------------------------------------------------------------------------
// parseReviewVerdict
// ---------------------------------------------------------------------------

describe('parseReviewVerdict', () => {
  it('parses a clean JSON response', () => {
    const raw = JSON.stringify({
      achieved: true,
      assessment: 'The threshold was correctly updated to 2200MB',
      recommendation: '',
    });

    const verdict = parseReviewVerdict(raw);
    expect(verdict.achieved).toBe(true);
    expect(verdict.assessment).toBe('The threshold was correctly updated to 2200MB');
    expect(verdict.recommendation).toBe('');
  });

  it('parses JSON with surrounding text', () => {
    const raw = `Here is my assessment:
{"achieved": false, "assessment": "Only one file was updated", "recommendation": "Also update storage-audit.sh"}
That's my review.`;

    const verdict = parseReviewVerdict(raw);
    expect(verdict.achieved).toBe(false);
    expect(verdict.assessment).toBe('Only one file was updated');
    expect(verdict.recommendation).toBe('Also update storage-audit.sh');
  });

  it('returns fallback verdict for unparseable text', () => {
    const verdict = parseReviewVerdict('This is not JSON at all');

    expect(verdict.achieved).toBe(false);
    expect(verdict.assessment).toContain('Review parsing failed');
    expect(verdict.recommendation).toContain('Retry review');
  });

  it('handles empty response', () => {
    const verdict = parseReviewVerdict('');

    expect(verdict.achieved).toBe(false);
    expect(verdict.assessment).toContain('Review parsing failed');
  });

  it('coerces achieved to boolean', () => {
    const raw = JSON.stringify({
      achieved: 1,
      assessment: 'Done',
      recommendation: '',
    });

    const verdict = parseReviewVerdict(raw);
    expect(verdict.achieved).toBe(true);
  });

  it('treats missing achieved as false', () => {
    const raw = JSON.stringify({
      assessment: 'Something happened',
      recommendation: 'Try again',
    });

    const verdict = parseReviewVerdict(raw);
    expect(verdict.achieved).toBe(false);
  });
});
