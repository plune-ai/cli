import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { appendBatch, DEFAULT_FALLBACK_PATH, type DeferredBatch } from '../fallback.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plune-fallback-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const batch = (over: Partial<DeferredBatch> = {}): DeferredBatch => ({
  runId: 'r-1',
  externalKey: 'ci-42',
  results: [{ resultKey: 'a#0', testCaseId: 'tc-1', source: 'playwright', rawStatus: 'passed' }],
  ...over,
});

const lines = (file: string): unknown[] =>
  fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l));

describe('fallback (AC-05)', () => {
  it('writes one parseable line per batch', () => {
    const file = path.join(dir, 'pending.jsonl');
    appendBatch(file, batch());

    expect(lines(file)).toHaveLength(1);
  });

  it('appends rather than replaces — a second batch does not cost the first', () => {
    const file = path.join(dir, 'pending.jsonl');
    appendBatch(file, batch({ runId: 'r-1' }));
    appendBatch(file, batch({ runId: 'r-2' }));

    const written = lines(file) as { runId: string }[];
    expect(written.map((b) => b.runId)).toEqual(['r-1', 'r-2']);
  });

  // `.plune/` is created by `plune run`, and a project that has only ever used the reporter has
  // never run it. A fallback that needed the directory to exist would fail exactly when it is the
  // last thing standing between a run and losing it.
  it('creates the directory it was pointed at', () => {
    const file = path.join(dir, 'never', 'made', 'pending.jsonl');
    appendBatch(file, batch());

    expect(fs.existsSync(file)).toBe(true);
  });

  it('records that the run was never created, rather than skipping the batch', () => {
    const file = path.join(dir, 'pending.jsonl');
    appendBatch(file, batch({ runId: null }));

    expect((lines(file)[0] as { runId: string | null }).runId).toBeNull();
  });

  it('stamps each line with when it was deferred', () => {
    const file = path.join(dir, 'pending.jsonl');
    appendBatch(file, batch());

    const ts = (lines(file)[0] as { ts: string }).ts;
    expect(Number.isNaN(Date.parse(ts))).toBe(false);
  });

  // AC-12 structurally: the line holds the run's identity and its results, and there is nowhere
  // for a token, a header or a config object to end up.
  it('writes those four fields and nothing else', () => {
    const file = path.join(dir, 'pending.jsonl');
    appendBatch(file, batch());

    expect(Object.keys(lines(file)[0] as object).sort()).toEqual([
      'externalKey',
      'results',
      'runId',
      'ts',
    ]);
  });

  it('defaults beside the run file the CLI already writes', () => {
    expect(DEFAULT_FALLBACK_PATH).toBe(path.join('.plune', 'pending-results.jsonl'));
  });
});
