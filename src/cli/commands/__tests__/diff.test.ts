import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
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
    schemaVersion: 1,
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

  it('exits 3 WITH --fail-on-regression when nothing regressed but an eval was not measured (#2414)', async () => {
    const errored: EvalResult = {
      id: 'a',
      tags: [],
      passed: false,
      rows: [{ vars: {}, output: null, cached: false, error: { code: 'PROVIDER_TRANSIENT_EXHAUSTED', message: 'down' }, assertions: [] }],
    };
    const base = write('base.json', runResult([ev('a', true)]));
    const cur = write('cur.json', runResult([errored]));
    captureStdout();
    await createProgram().parseAsync(['node', 'plune', 'diff', base, cur, '--fail-on-regression']);
    expect(process.exitCode).toBe(3);
    process.exitCode = 0;
    await createProgram().parseAsync(['node', 'plune', 'diff', base, cur]);
    expect(process.exitCode).toBe(0);
  });

  it('a regression wins over unmeasured evals: exit 1', async () => {
    const errored: EvalResult = {
      id: 'b',
      tags: [],
      passed: false,
      rows: [{ vars: {}, output: null, cached: false, error: { code: 'PROVIDER_TRANSIENT_EXHAUSTED', message: 'down' }, assertions: [] }],
    };
    const base = write('base.json', runResult([ev('a', true), ev('b', true)]));
    const cur = write('cur.json', runResult([ev('a', false), errored]));
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

// MCP-D5: gates for agent runs.
describe('CLI · diff · gates · plune diff exit codes', () => {
  function capture(): { out: string[]; err: string[]; exit: ReturnType<typeof vi.spyOn> } {
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array): boolean => {
      out.push(String(c));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array): boolean => {
      err.push(String(c));
      return true;
    });
    const exit = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => {}) as (code?: string | number | null | undefined) => never);
    return { out, err, exit };
  }
  const plune = (...args: string[]) => createProgram().parseAsync(['node', 'plune', 'diff', ...args]);

  // What PLUNE_MOCK_PROVIDER=1 writes: usage without `priced`.
  function mockEval(id: string, passed: boolean): EvalResult {
    return {
      ...ev(id, passed),
      rows: [
        {
          vars: {},
          output: 'x',
          cached: false,
          usage: { input_tokens: 5, output_tokens: 5, cost_usd: 0 },
          assertions: [{ type: 'exact-match', passed }],
        },
      ],
    };
  }

  it('AC-15: without --fail-on-regression or a gate, exit 0 and the json has only its old fields', async () => {
    const base = write('base.json', runResult([ev('a', true)]));
    const cur = write('cur.json', runResult([mockEval('a', false)]));
    const { out } = capture();
    await plune(base, cur, '--format', 'json');
    expect(process.exitCode).toBe(0);
    expect(Object.keys(JSON.parse(out.join('')) as object)).toEqual(['evals', 'summary']);
  });

  it('AC-6: --max-cost-usd on a run with no prices exits 3, and the json says why', async () => {
    const base = write('base.json', runResult([mockEval('a', true)]));
    const cur = write('cur.json', runResult([mockEval('a', true)]));
    const { out } = capture();
    await plune(base, cur, '--fail-on-regression', '--max-cost-usd', '1', '--format', 'json');
    expect(process.exitCode).toBe(3);
    const d = JSON.parse(out.join('')) as { gates: { exitCode: number; gates: { gate: string; state: string }[] } };
    expect(d.gates.exitCode).toBe(3);
    expect(d.gates.gates).toEqual([
      expect.objectContaining({ gate: 'regression', state: 'passed' }),
      expect.objectContaining({ gate: 'cost', state: 'unmeasured' }),
    ]);
  });

  it('a waiver file lifts a measured regression (exit 0); a bad one is an input error (exit 2) naming the entry', async () => {
    const base = write('base.json', runResult([ev('a', true)]));
    const cur = write('cur.json', runResult([ev('a', false)]));
    const today = new Date().toISOString().slice(0, 10);
    const later = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    const good = path.join(tmp, 'waivers.yaml');
    fs.writeFileSync(
      good,
      `waivers:\n  - gate: regression\n    eval: a\n    reason: flaky upstream\n    granted: "${today}"\n    expires: "${later}"\n`,
    );
    const { exit, err } = capture();
    await plune(base, cur, '--fail-on-regression', '--waivers', good);
    expect(process.exitCode).toBe(0);
    const bad = path.join(tmp, 'bad.yaml');
    fs.writeFileSync(bad, `waivers:\n  - gate: regression\n    eval: a\n    reason: r\n    granted: "${today}"\n`);
    await plune(base, cur, '--fail-on-regression', '--waivers', bad);
    expect(exit).toHaveBeenCalledWith(2);
    expect(err.join('')).toMatch(/waivers\[0\].*expires is required/);
    exit.mockClear();
    await plune(base, cur, '--fail-on-regression', '--waivers', path.join(tmp, 'missing.yaml'));
    expect(exit).toHaveBeenCalledWith(2);
  });

  it.each([['--max-cost-usd', 'abc'], ['--max-tokens', '-1'], ['--max-pass-rate-drop-percent', '']])(
    '%s %s is an input error (exit 2)',
    async (flag, value) => {
      const base = write('base.json', runResult([ev('a', true)]));
      const { exit } = capture();
      await plune(base, base, flag, value);
      expect(exit).toHaveBeenCalledWith(2);
    },
  );

  it('AC-13: no environment variable and no flag moves «now» for the waiver expiry', async () => {
    const base = write('base.json', runResult([ev('a', true)]));
    const cur = write('cur.json', runResult([ev('a', false)]));
    const expired = path.join(tmp, 'expired.yaml');
    fs.writeFileSync(
      expired,
      'waivers:\n  - gate: regression\n    eval: a\n    reason: old\n    granted: "2020-01-01"\n    expires: "2020-01-30"\n',
    );
    const vars = ['PLUNE_NOW', 'PLUNE_TODAY', 'PLUNE_DATE', 'NOW', 'TODAY', 'FAKETIME', 'SOURCE_DATE_EPOCH'];
    for (const v of vars) vi.stubEnv(v, '2020-01-15');
    try {
      capture();
      await plune(base, cur, '--fail-on-regression', '--waivers', expired);
      expect(process.exitCode).toBe(1);
    } finally {
      vi.unstubAllEnvs();
    }
    const diff = createProgram().commands.find((c) => c.name() === 'diff')!;
    expect(diff.options.map((o) => o.long).filter((l) => /now|date|time|clock|today/i.test(l ?? ''))).toEqual([]);
    // The gate code reads no environment at all, so no variable can be added to it quietly.
    const here = path.dirname(fileURLToPath(import.meta.url));
    for (const f of ['../../../diff/gates.ts', '../../../diff/waivers.ts', '../../../diff/diff.ts', '../diff.ts']) {
      expect(fs.readFileSync(path.join(here, f), 'utf8')).not.toMatch(/process\.env|import\.meta\.env/);
    }
  });
});
