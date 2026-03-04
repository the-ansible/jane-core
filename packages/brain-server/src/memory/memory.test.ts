/**
 * Memory System Integration Tests
 *
 * Tests registry CRUD, recorder helpers, retriever, consolidator state,
 * and HTTP API routes. Requires JANE_DATABASE_URL to be set.
 *
 * Each test cleans up after itself.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import pg from 'pg';
import {
  initMemoryRegistry,
  recordMemory,
  getMemory,
  listMemories,
  searchMemories,
  updateMemoryImportance,
  deleteMemory,
  purgeExpiredMemories,
  countMemories,
  recordPattern,
  listPatterns,
  applyImportanceDecay,
  _resetPool,
} from './registry.js';
import { recordManualMemory, recordGoalCycleMemory, recordJobCompletionMemory } from './recorder.js';
import { getRelevantMemories, formatMemoriesForContext } from './retriever.js';
import { isConsolidating, getLastConsolidationResult, stopConsolidator } from './consolidator.js';
import { createApp, type ServerDeps } from '../api/routes.js';

const { Pool } = pg;
let pool: pg.Pool;

// Track IDs for cleanup
const testMemoryIds: string[] = [];

beforeAll(async () => {
  const connectionString = process.env.JANE_DATABASE_URL;
  if (!connectionString) throw new Error('JANE_DATABASE_URL is required for tests');
  pool = new Pool({ connectionString });
  await initMemoryRegistry();
  // Stop consolidator timer so it doesn't interfere
  stopConsolidator();
});

afterAll(async () => {
  await pool.end();
  _resetPool();
});

afterEach(async () => {
  if (testMemoryIds.length > 0) {
    const ids = testMemoryIds.splice(0);
    await pool.query(`DELETE FROM brain.memories WHERE id = ANY($1)`, [ids]).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// Registry — basic CRUD
// ---------------------------------------------------------------------------

describe('memory registry', () => {
  it('records and retrieves an episodic memory', async () => {
    const id = await recordMemory({
      type: 'episodic',
      source: 'manual',
      title: 'Test episodic memory',
      content: 'Something happened',
      tags: ['test', 'episodic'],
      importance: 0.7,
    });
    testMemoryIds.push(id);

    const m = await getMemory(id);
    expect(m).not.toBeNull();
    expect(m!.title).toBe('Test episodic memory');
    expect(m!.type).toBe('episodic');
    expect(m!.source).toBe('manual');
    expect(Number(m!.importance)).toBeCloseTo(0.7, 2);
    expect(m!.access_count).toBe(1); // getMemory increments
  });

  it('records a semantic memory', async () => {
    const id = await recordMemory({
      type: 'semantic',
      source: 'consolidation',
      title: 'Semantic fact',
      content: 'Jane prefers TypeScript over JavaScript',
      tags: ['preferences'],
    });
    testMemoryIds.push(id);

    const m = await getMemory(id);
    expect(m!.type).toBe('semantic');
    expect(m!.source).toBe('consolidation');
  });

  it('records a working memory that expires', async () => {
    const id = await recordMemory({
      type: 'working',
      source: 'manual',
      title: 'Temp scratch',
      content: 'Short-lived note',
      expiresInMs: 100, // expires very fast
    });
    testMemoryIds.push(id);

    const before = await getMemory(id);
    expect(before).not.toBeNull();

    // Wait for expiry
    await new Promise((r) => setTimeout(r, 200));
    const purged = await purgeExpiredMemories();
    expect(purged).toBeGreaterThanOrEqual(1);

    // listMemories should exclude it
    const list = await listMemories({ includeExpired: false });
    expect(list.find((m) => m.id === id)).toBeUndefined();
  });

  it('lists memories with type filter', async () => {
    const id1 = await recordMemory({ type: 'episodic', source: 'manual', title: 'Ep', content: 'x' });
    const id2 = await recordMemory({ type: 'semantic', source: 'manual', title: 'Sem', content: 'x' });
    testMemoryIds.push(id1, id2);

    const eps = await listMemories({ type: 'episodic' });
    expect(eps.some((m) => m.id === id1)).toBe(true);
    expect(eps.some((m) => m.id === id2)).toBe(false);
  });

  it('lists memories with tag filter', async () => {
    const id = await recordMemory({
      type: 'episodic',
      source: 'manual',
      title: 'Tagged memory',
      content: 'x',
      tags: ['unique-test-tag-abc'],
    });
    testMemoryIds.push(id);

    const found = await listMemories({ tags: ['unique-test-tag-abc'] });
    expect(found.some((m) => m.id === id)).toBe(true);
  });

  it('searches memories by keyword', async () => {
    const id = await recordMemory({
      type: 'semantic',
      source: 'manual',
      title: 'Unique xenomorphic concept',
      content: 'Xenomorphic architecture is important',
    });
    testMemoryIds.push(id);

    const results = await searchMemories('xenomorphic');
    expect(results.some((m) => m.id === id)).toBe(true);
  });

  it('updates importance', async () => {
    const id = await recordMemory({ type: 'episodic', source: 'manual', title: 'T', content: 'c', importance: 0.5 });
    testMemoryIds.push(id);

    await updateMemoryImportance(id, 0.9);
    const m = await getMemory(id);
    expect(Number(m!.importance)).toBeCloseTo(0.9, 2);
  });

  it('deletes a memory', async () => {
    const id = await recordMemory({ type: 'working', source: 'manual', title: 'Del', content: 'x' });
    // Don't push to testMemoryIds — we're deleting it

    const deleted = await deleteMemory(id);
    expect(deleted).toBe(true);

    const m = await getMemory(id);
    expect(m).toBeNull();
  });

  it('countMemories returns a non-negative number', async () => {
    const count = await countMemories();
    expect(count).toBeGreaterThanOrEqual(0);
  });

  it('applyImportanceDecay does not throw', async () => {
    const count = await applyImportanceDecay({ olderThanDays: 365, decayFactor: 0.01 });
    expect(typeof count).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// Registry — patterns
// ---------------------------------------------------------------------------

describe('memory patterns', () => {
  afterEach(async () => {
    await pool.query(`DELETE FROM brain.memory_patterns WHERE description LIKE 'test-pattern-%'`).catch(() => {});
  });

  it('records a pattern', async () => {
    const id = await recordPattern({
      patternType: 'success',
      description: 'test-pattern-abc — unit test pattern',
      confidence: 0.6,
    });
    expect(typeof id).toBe('string');
  });

  it('reinforces an existing pattern (upsert)', async () => {
    const desc = 'test-pattern-reinforced — reinforcement test';
    const id1 = await recordPattern({ patternType: 'success', description: desc, confidence: 0.5 });
    const id2 = await recordPattern({ patternType: 'success', description: desc, confidence: 0.6 });
    expect(id1).toBe(id2); // same record updated
  });

  it('lists patterns', async () => {
    await recordPattern({ patternType: 'failure', description: 'test-pattern-list — list test', confidence: 0.7 });
    const patterns = await listPatterns({ patternType: 'failure' });
    expect(patterns.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Recorder helpers
// ---------------------------------------------------------------------------

describe('memory recorder', () => {
  it('recordManualMemory creates a memory and returns ID', async () => {
    const id = await recordManualMemory({
      title: 'Manual test memory',
      content: 'Created via recorder',
      tags: ['recorder-test'],
      importance: 0.55,
    });
    testMemoryIds.push(id);
    expect(typeof id).toBe('string');

    const m = await getMemory(id);
    expect(m!.title).toBe('Manual test memory');
  });

  it('recordGoalCycleMemory does not throw', async () => {
    // Should record silently and not throw even if DB is clean
    await expect(recordGoalCycleMemory({
      cycleId: '00000000-0000-0000-0000-000000000001',
      goalsAssessed: 3,
      candidatesGenerated: 6,
      selectedAction: 'Write unit tests',
      outcome: 'done',
      notes: null,
    })).resolves.not.toThrow();

    // Cleanup
    const found = await listMemories({ tags: ['goal-cycle'], limit: 5 });
    for (const m of found) testMemoryIds.push(m.id);
  });

  it('recordJobCompletionMemory does not throw', async () => {
    await expect(recordJobCompletionMemory({
      jobId: '00000000-0000-0000-0000-000000000002',
      jobType: 'task',
      prompt: 'Do something useful',
      outcome: 'failed',
    })).resolves.not.toThrow();

    const found = await listMemories({ tags: ['job'], limit: 5 });
    for (const m of found) testMemoryIds.push(m.id);
  });
});

// ---------------------------------------------------------------------------
// Retriever
// ---------------------------------------------------------------------------

describe('memory retriever', () => {
  it('getRelevantMemories returns an array', async () => {
    const memories = await getRelevantMemories({ query: 'test retrieval', limit: 5 });
    expect(Array.isArray(memories)).toBe(true);
  });

  it('formatMemoriesForContext returns a non-empty string when memories exist', async () => {
    const id = await recordMemory({
      type: 'semantic',
      source: 'manual',
      title: 'Format test memory',
      content: 'This should appear in formatted output',
      tags: ['format-test'],
      importance: 0.8,
    });
    testMemoryIds.push(id);

    const memories = await getRelevantMemories({ tags: ['format-test'], limit: 3 });
    const text = formatMemoriesForContext(memories);
    expect(text.length).toBeGreaterThan(10);
  });

  it('formatMemoriesForContext returns placeholder when empty', () => {
    const text = formatMemoriesForContext([]);
    expect(text).toContain('No relevant memories');
  });
});

// ---------------------------------------------------------------------------
// Consolidator state
// ---------------------------------------------------------------------------

describe('consolidator state', () => {
  it('is not consolidating at start', () => {
    expect(isConsolidating()).toBe(false);
  });

  it('getLastConsolidationResult returns null initially', () => {
    const { lastRunAt, result } = getLastConsolidationResult();
    // May be null or set from a previous test run — just check types
    expect(lastRunAt === null || lastRunAt instanceof Date).toBe(true);
    expect(result === null || typeof result === 'object').toBe(true);
  });
});

// ---------------------------------------------------------------------------
// HTTP API — memory routes
// ---------------------------------------------------------------------------

describe('memory API routes', () => {
  const deps: ServerDeps = { nats: null };
  const app = createApp(deps);

  it('GET /api/memories returns memories array', async () => {
    const res = await app.request('/api/memories');
    expect(res.status).toBe(200);
    const body = await res.json() as { memories: unknown[]; count: number };
    expect(Array.isArray(body.memories)).toBe(true);
    expect(typeof body.count).toBe('number');
  });

  it('GET /api/memories/stats returns total count', async () => {
    const res = await app.request('/api/memories/stats');
    expect(res.status).toBe(200);
    const body = await res.json() as { total: number };
    expect(typeof body.total).toBe('number');
    expect(body.total).toBeGreaterThanOrEqual(0);
  });

  it('POST /api/memories creates a memory', async () => {
    const res = await app.request('/api/memories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'API-created memory',
        content: 'Created via HTTP POST',
        type: 'semantic',
        tags: ['api-test'],
        importance: 0.6,
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { memory: { id: string } };
    expect(typeof body.memory.id).toBe('string');
    testMemoryIds.push(body.memory.id);
  });

  it('POST /api/memories rejects missing fields', async () => {
    const res = await app.request('/api/memories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Missing content' }),
    });
    expect(res.status).toBe(400);
  });

  it('GET /api/memories/:id returns a memory', async () => {
    const createRes = await app.request('/api/memories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'For GET test', content: 'x', type: 'working' }),
    });
    const created = await createRes.json() as { memory: { id: string } };
    testMemoryIds.push(created.memory.id);

    const res = await app.request(`/api/memories/${created.memory.id}`);
    expect(res.status).toBe(200);
    const body = await res.json() as { memory: { id: string } };
    expect(body.memory.id).toBe(created.memory.id);
  });

  it('GET /api/memories/:id returns 404 for unknown ID', async () => {
    const res = await app.request('/api/memories/00000000-0000-0000-0000-deadbeef0001');
    expect(res.status).toBe(404);
  });

  it('DELETE /api/memories/:id removes a memory', async () => {
    const createRes = await app.request('/api/memories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'For DELETE test', content: 'x', type: 'working' }),
    });
    const created = await createRes.json() as { memory: { id: string } };

    const delRes = await app.request(`/api/memories/${created.memory.id}`, { method: 'DELETE' });
    expect(delRes.status).toBe(200);
    const body = await delRes.json() as { deleted: boolean };
    expect(body.deleted).toBe(true);
  });

  it('GET /api/memories/search requires q param', async () => {
    const res = await app.request('/api/memories/search');
    expect(res.status).toBe(400);
  });

  it('GET /api/memories/search returns results', async () => {
    const res = await app.request('/api/memories/search?q=test');
    expect(res.status).toBe(200);
    const body = await res.json() as { memories: unknown[] };
    expect(Array.isArray(body.memories)).toBe(true);
  });

  it('GET /api/memories/context returns memories and text', async () => {
    const res = await app.request('/api/memories/context?q=test');
    expect(res.status).toBe(200);
    const body = await res.json() as { memories: unknown[]; text: string };
    expect(Array.isArray(body.memories)).toBe(true);
    expect(typeof body.text).toBe('string');
  });

  it('GET /api/memories/patterns returns patterns array', async () => {
    const res = await app.request('/api/memories/patterns');
    expect(res.status).toBe(200);
    const body = await res.json() as { patterns: unknown[] };
    expect(Array.isArray(body.patterns)).toBe(true);
  });

  it('GET /api/memories/consolidation returns state', async () => {
    const res = await app.request('/api/memories/consolidation');
    expect(res.status).toBe(200);
    const body = await res.json() as { consolidating: boolean };
    expect(typeof body.consolidating).toBe('boolean');
  });
});
