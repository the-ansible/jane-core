import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { JsonlWriter } from '../writer.js';
import { readFileSync, rmSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `drainer-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('JsonlWriter', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true });
    }
  });

  it('creates the base directory if it does not exist', () => {
    const nested = join(tmpDir, 'nested', 'deep');
    const writer = new JsonlWriter(nested);
    expect(existsSync(nested)).toBe(true);
  });

  it('writes events as JSON lines', () => {
    const writer = new JsonlWriter(tmpDir);

    writer.write({ id: '1', msg: 'hello' });
    writer.write({ id: '2', msg: 'world' });

    const files = readdirSync(tmpDir);
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}-\d{2}\.jsonl$/);

    const content = readFileSync(join(tmpDir, files[0]), 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]).id).toBe('1');
    expect(JSON.parse(lines[1]).id).toBe('2');
  });

  it('tracks stats correctly', () => {
    const writer = new JsonlWriter(tmpDir);

    writer.write({ a: 1 });
    writer.write({ b: 2 });
    writer.write({ c: 3 });

    const stats = writer.getStats();
    expect(stats.eventsWritten).toBe(3);
    expect(stats.currentHour).toMatch(/^\d{4}-\d{2}-\d{2}-\d{2}$/);
    expect(stats.currentFile).toContain('.jsonl');
  });

  it('appends to the same file within the same hour', () => {
    const writer = new JsonlWriter(tmpDir);

    writer.write({ first: true });
    const path1 = writer.getStats().currentFile;

    writer.write({ second: true });
    const path2 = writer.getStats().currentFile;

    expect(path1).toBe(path2);

    const content = readFileSync(path1, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines.length).toBe(2);
  });

  it('uses UTC hour keys', () => {
    const writer = new JsonlWriter(tmpDir);
    writer.write({ test: true });

    const stats = writer.getStats();
    const now = new Date();
    const expectedHour = String(now.getUTCHours()).padStart(2, '0');
    expect(stats.currentHour).toContain(`-${expectedHour}`);
  });
});
