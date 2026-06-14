import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleDiff, DiffInputError } from '../diff.js';
import { createProgram } from '../../../cli.js';
import type { RunResult, EvalResult } from '../../../types/results.js';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plune-diff-'));
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exitCode = 0;
});

function ev(id: string, passed: boolean): EvalResult {
  return {
    id,
    tags: [],
    passed,
    rows: [{ vars: {}, output: 'x', cached: false, assertions: [{ type: 'exact-match', passed }] }],
  };
}
function runResult(evals: EvalResult[]): RunResult {
  return {
    schema: 1,
    plune_version: '0',
    started_at: '',
    finished_at: '',
    config_hash: '',
    summary: { total: evals.length, passed: 0, failed: 0, errored: 0, cost_usd: 0, duration_ms: 0 },
    evals,
  };
}
function write(name: string, r: RunResult): string {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, JSON.stringify(r));
  return p;
}

describe('handleDiff', () => {
  it('computes a RunDiff and flags a pass→fail regression', () => {
    const base = write('base.json', runResult([ev('a', true)]));
    const cur = write('cur.json', runResult([ev('a', false)]));
    const d = handleDiff({ baselinePath: base, currentPath: cur });
    expect(d.summary.hasRegression).toBe(true);
    expect(d.summary.regressions).toBe(1);
  });

  it('throws DiffInputError when a file is missing (AC-6.2)', () => {
    const cur = write('cur.json', runResult([ev('a', true)]));
    expect(() => handleDiff({ baselinePath: path.join(tmp, 'nope.json'), currentPath: cur })).toThrow(
      DiffInputError,
    );
  });

  it('throws DiffInputError on invalid JSON', () => {
    const bad = path.join(tmp, 'bad.json');
    fs.writeFileSync(bad, 'not json');
    const cur = write('cur.json', runResult([ev('a', true)]));
    expect(() => handleDiff({ baselinePath: bad, currentPath: cur })).toThrow(DiffInputError);
  });

  it('throws DiffInputError on JSON that is not a RunResult', () => {
    const bad = path.join(tmp, 'empty.json');
    fs.writeFileSync(bad, '{}');
    const cur = write('cur.json', runResult([ev('a', true)]));
    expect(() => handleDiff({ baselinePath: bad, currentPath: cur })).toThrow(DiffInputError);
  });
});

describe('plune diff command', () => {
  function captureStdout(): string[] {
    const w: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array): boolean => {
      w.push(typeof c === 'string' ? c : Buffer.from(c).toString());
      return true;
    });
    return w;
  }

  it('prints a markdown diff with the sticky marker', async () => {
    const base = write('base.json', runResult([ev('a', true)]));
    const cur = write('cur.json', runResult([ev('a', false)]));
    const w = captureStdout();
    await createProgram().parseAsync(['node', 'plune', 'diff', base, cur, '--format', 'markdown']);
    expect(w.join('')).toContain('<!-- plune-eval-diff -->');
    expect(w.join('')).toMatch(/regression/i);
  });

  it('--format json prints a RunDiff', async () => {
    const base = write('base.json', runResult([ev('a', true)]));
    const cur = write('cur.json', runResult([ev('a', false)]));
    const w = captureStdout();
    await createProgram().parseAsync(['node', 'plune', 'diff', base, cur, '--format', 'json']);
    expect((JSON.parse(w.join('')) as { summary: { hasRegression: boolean } }).summary.hasRegression).toBe(true);
  });

  it('exits 0 on regression WITHOUT --fail-on-regression (AC-4.1)', async () => {
    const base = write('base.json', runResult([ev('a', true)]));
    const cur = write('cur.json', runResult([ev('a', false)]));
    captureStdout();
    await createProgram().parseAsync(['node', 'plune', 'diff', base, cur]);
    expect(process.exitCode === undefined || process.exitCode === 0).toBe(true);
  });

  it('exits 1 on regression WITH --fail-on-regression (AC-4.2)', async () => {
    const base = write('base.json', runResult([ev('a', true)]));
    const cur = write('cur.json', runResult([ev('a', false)]));
    captureStdout();
    await createProgram().parseAsync(['node', 'plune', 'diff', base, cur, '--fail-on-regression']);
    expect(process.exitCode).toBe(1);
  });

  it('exits 2 when an input file is missing (AC-6.2)', async () => {
    const cur = write('cur.json', runResult([ev('a', true)]));
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => {}) as (code?: string | number | null | undefined) => never);
    await createProgram().parseAsync(['node', 'plune', 'diff', path.join(tmp, 'nope.json'), cur]);
    expect(exitSpy).toHaveBeenCalledWith(2);
  });
});
