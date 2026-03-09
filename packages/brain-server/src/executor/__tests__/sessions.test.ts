/**
 * Sessions module tests — brain.sessions table and parent-session context module.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock pg Pool
// ---------------------------------------------------------------------------

const mockQuery = vi.fn().mockResolvedValue({ rows: [] });
vi.mock('pg', () => ({
  default: {
    Pool: vi.fn(() => ({
      query: (...args: any[]) => mockQuery(...args),
    })),
  },
}));

vi.stubEnv('JANE_DATABASE_URL', 'postgres://test:test@localhost/test');

import {
  initSessionsSchema,
  registerSession,
  getParentSessionId,
  getSession,
  listSessions,
  listChildSessions,
  closeSession,
  _resetPool,
} from '../sessions.js';

// ---------------------------------------------------------------------------
// initSessionsSchema
// ---------------------------------------------------------------------------

describe('initSessionsSchema', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetPool();
  });

  it('creates brain.sessions table', async () => {
    await initSessionsSchema();
    expect(mockQuery).toHaveBeenCalledOnce();
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain('sessions');
    expect(sql).toContain('parent_id');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS');
  });
});

// ---------------------------------------------------------------------------
// registerSession
// ---------------------------------------------------------------------------

describe('registerSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetPool();
  });

  it('inserts session without parent', async () => {
    await registerSession('sess-abc');
    expect(mockQuery).toHaveBeenCalledOnce();
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('INSERT INTO');
    expect(params[0]).toBe('sess-abc');
    expect(params[1]).toBeNull();
  });

  it('inserts session with parent', async () => {
    await registerSession('sess-child', 'sess-parent');
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('INSERT INTO');
    expect(params[0]).toBe('sess-child');
    expect(params[1]).toBe('sess-parent');
  });

  it('includes metadata when provided', async () => {
    await registerSession('sess-abc', undefined, { source: 'test' });
    const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(params[2]).toBe(JSON.stringify({ source: 'test' }));
  });

  it('upserts on conflict', async () => {
    await registerSession('sess-abc');
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain('ON CONFLICT');
    expect(sql).toContain('DO UPDATE SET');
  });
});

// ---------------------------------------------------------------------------
// getParentSessionId
// ---------------------------------------------------------------------------

describe('getParentSessionId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetPool();
  });

  it('returns parent_id when session has a parent', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ parent_id: 'parent-uuid' }] });
    const result = await getParentSessionId('child-uuid');
    expect(result).toBe('parent-uuid');
  });

  it('returns null when session has no parent', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ parent_id: null }] });
    const result = await getParentSessionId('child-uuid');
    expect(result).toBeNull();
  });

  it('returns null when session not found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const result = await getParentSessionId('nonexistent');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getSession
// ---------------------------------------------------------------------------

describe('getSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetPool();
  });

  it('returns null when session not found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const result = await getSession('nonexistent');
    expect(result).toBeNull();
  });

  it('returns session info when found', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'sess-abc',
        parent_id: 'sess-parent',
        status: 'active',
        created_at: '2026-03-09T00:00:00Z',
        last_active_at: '2026-03-09T01:00:00Z',
        metadata: { source: 'test' },
      }],
    });
    const result = await getSession('sess-abc');
    expect(result).not.toBeNull();
    expect(result!.id).toBe('sess-abc');
    expect(result!.parentId).toBe('sess-parent');
    expect(result!.status).toBe('active');
    expect(result!.metadata).toEqual({ source: 'test' });
  });
});

// ---------------------------------------------------------------------------
// listSessions
// ---------------------------------------------------------------------------

describe('listSessions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetPool();
  });

  it('queries without filters by default', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await listSessions();
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain('FROM');
    expect(sql).toContain('sessions');
    expect(sql).not.toContain('WHERE');
  });

  it('filters by status', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await listSessions({ status: 'active' });
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('status =');
    expect(params).toContain('active');
  });

  it('filters to root sessions when parentId is null', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await listSessions({ parentId: null });
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain('parent_id IS NULL');
  });

  it('returns mapped session objects', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'sess-1',
        parent_id: null,
        status: 'active',
        created_at: '2026-03-09T00:00:00Z',
        last_active_at: '2026-03-09T01:00:00Z',
        metadata: {},
      }],
    });
    const results = await listSessions();
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('sess-1');
    expect(results[0].parentId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// listChildSessions
// ---------------------------------------------------------------------------

describe('listChildSessions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetPool();
  });

  it('queries by parent_id', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await listChildSessions('parent-uuid');
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('parent_id =');
    expect(params).toContain('parent-uuid');
  });
});

// ---------------------------------------------------------------------------
// closeSession
// ---------------------------------------------------------------------------

describe('closeSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetPool();
  });

  it('updates status to closed', async () => {
    await closeSession('sess-xyz');
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("status = 'closed'");
    expect(params[0]).toBe('sess-xyz');
  });
});

// ---------------------------------------------------------------------------
// Parent-session module
// ---------------------------------------------------------------------------

// We need a second pool mock for the parent-session module (separate pool instance)
const mockQueryParentModule = vi.fn().mockResolvedValue({ rows: [] });

vi.mock('../../sessions.js', async (importOriginal) => {
  // Use real getParentSessionId but with controlled DB via our mock
  return importOriginal();
});

describe('parent-session context module', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetPool();
  });

  it('returns null when no sessionId provided', async () => {
    const { default: module } = await import('../context/modules/parent-session.js');
    const result = await module.assemble({
      sessionId: undefined,
      role: 'communicator',
      prompt: 'hello',
      plan: makePlan(),
    });
    expect(result).toBeNull();
  });

  it('returns null when session has no parent', async () => {
    // getParentSessionId returns null
    mockQuery.mockResolvedValueOnce({ rows: [{ parent_id: null }] });

    const { default: module, _resetPool: resetParentPool } = await import('../context/modules/parent-session.js');
    resetParentPool?.();

    const result = await module.assemble({
      sessionId: 'child-session',
      role: 'communicator',
      prompt: 'hello',
      plan: makePlan(),
    });
    expect(result).toBeNull();
  });

  it('returns null when parent has no summaries', async () => {
    // getParentSessionId returns a parent
    mockQuery
      .mockResolvedValueOnce({ rows: [{ parent_id: 'parent-uuid' }] })
      // context.summaries query returns empty
      .mockResolvedValueOnce({ rows: [] });

    const { default: module, _resetPool: resetParentPool } = await import('../context/modules/parent-session.js');
    resetParentPool?.();

    const result = await module.assemble({
      sessionId: 'child-session',
      role: 'communicator',
      prompt: 'hello',
      plan: makePlan(),
    });
    expect(result).toBeNull();
  });

  it('returns fragment when parent has summaries', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ parent_id: 'parent-uuid' }] })
      .mockResolvedValueOnce({
        rows: [{
          summary: 'We discussed the canvas architecture and decided to use modular context.',
          topics: ['architecture', 'canvas'],
          msg_count: 12,
          ts_start: '2026-03-09T00:00:00Z',
          ts_end: '2026-03-09T01:00:00Z',
        }],
      });

    const { default: module, _resetPool: resetParentPool } = await import('../context/modules/parent-session.js');
    resetParentPool?.();

    const result = await module.assemble({
      sessionId: 'child-session',
      role: 'communicator',
      prompt: 'continue our work',
      plan: makePlan(),
    });

    expect(result).not.toBeNull();
    expect(result!.source).toBe('parent-session');
    expect(result!.text).toContain('PARENT SESSION CONTEXT');
    expect(result!.text).toContain('canvas architecture');
    expect(result!.meta?.parentSessionId).toBe('parent-uuid');
    expect(result!.meta?.summaryCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePlan() {
  return {
    summaryChunkSize: 6,
    summaryModel: 'haiku',
    summaryPromptTemplate: 'default_v1',
    rawSummarizationThreshold: 12,
    maxSummaries: 10,
    modelContextSize: 200_000,
    tokenBudgetPct: 0.06,
    tokenBudget: 12_000,
    modules: ['conversation', 'parent-session'],
    topicTrackingEnabled: false,
    associativeRetrievalEnabled: false,
  };
}
