import { describe, expect, it } from 'vitest';
import { diffRuns } from '../diff.js';
import { adviceFor } from '../advice.js';
import { evaluateGates } from '../gates.js';
import { handleDiff } from '../../cli/commands/diff.js';
import type { AgentRecord, EvalResult, RowResult, RunResult } from '../../types/results.js';

type Measured = NonNullable<EvalResult['measured']>;
const POP: Measured = {
  runs: 10,
  rows: 1,
  rows_hash: 'rows-a',
  assertions_hash: 'checks-a',
  model: 'openai/m',
};

/** One row of `runs` attempts, `passed` of them passing; the row itself passes, so no eval changes state. */
function repeated(
  passed: number,
  runs: number,
  firstTool?: { hits: number; first: string; swap?: { tool: string; sha256: string }[] },
): RowResult {
  const results = Array.from({ length: runs }, (_, i) => ({
    output: 'x',
    cached: false,
    assertions: firstTool === undefined ? [] : [{ type: 'first-tool', passed: i < firstTool.hits }],
  }));
  const agent: AgentRecord | undefined =
    firstTool === undefined
      ? undefined
      : {
          server: 'fx',
          tools: [],
          steps: [
            {
              index: 1,
              text: '',
              usage: { input_tokens: 0, output_tokens: 0, cost_usd: 0 },
              calls: [
                { id: 'c', name: firstTool.first, args: {}, executed: true, is_error: false },
              ],
            },
          ],
          stop: { reason: 'complete' },
          collection: 'complete',
          ...(firstTool.swap !== undefined ? { description_overrides: firstTool.swap } : {}),
        };
  return {
    vars: {},
    output: 'x',
    cached: false,
    assertions: [{ type: 'exact-match', passed: true }],
    attempts: { runs, pass_threshold: 0.1, passed, failed: runs - passed, errored: 0, results },
    ...(agent !== undefined ? { agent } : {}),
  };
}

function ev(id: string, row: RowResult, measured: Partial<Measured> | null = {}): EvalResult {
  return {
    id,
    tags: [],
    passed: true,
    rows: [row],
    ...(measured === null
      ? {}
      : { measured: { ...POP, runs: row.attempts?.runs ?? 1, ...measured } }),
  };
}

function run(evals: EvalResult[]): RunResult {
  return {
    schemaVersion: 1,
    plune_version: '0',
    started_at: '',
    finished_at: '',
    config_hash: '',
    summary: {
      total: evals.length,
      passed: evals.length,
      failed: 0,
      errored: 0,
      cost_usd: 0,
      duration_ms: 0,
    },
    evals,
  };
}

const word = (base: [number, number], cur: [number, number]) =>
  adviceFor(run([ev('e', repeated(...base))]), run([ev('e', repeated(...cur))]))!.evals[0]!
    .comparison!.word;

describe('CLI · diff · advice · words for a pass rate', () => {
  it('CLI · diff · advice · 9/10 → 4/10 is worse, 9/10 → 8/10 shows no difference, 2/2 → 0/2 is too few (AC-3)', () => {
    expect(word([9, 10], [4, 10])).toBe('worse');
    expect(word([9, 10], [8, 10])).toBe('no-difference');
    expect(word([2, 2], [0, 2])).toBe('too-few');
    expect(word([4, 10], [9, 10])).toBe('better');
  });

  it('CLI · diff · advice · a side with no attempts is too few, not "no difference" (AC-2)', () => {
    const none = {
      ...repeated(9, 10),
      attempts: { ...repeated(9, 10).attempts!, runs: 0, passed: 0, failed: 0, results: [] },
    };
    const base = ev('e', none, { runs: 10 });
    const a = adviceFor(run([base]), run([ev('e', repeated(9, 10))]))!;
    // The baseline eval has no attempts at all.
    expect(a.evals[0]!.comparison!.word).toBe('too-few');
    expect(a.evals[0]!.comparison!.reason).toContain('at least 5');
  });

  it('CLI · diff · advice · an eval without repeats on either side is not compared, and a diff with nothing to say has no advice', () => {
    const plain: EvalResult = {
      id: 'e',
      tags: [],
      passed: true,
      rows: [
        {
          vars: {},
          output: 'x',
          cached: false,
          assertions: [{ type: 'exact-match', passed: true }],
        },
      ],
      measured: { ...POP, runs: 1 },
    };
    expect(adviceFor(run([plain]), run([plain]))).toBeUndefined();
    expect(adviceFor(run([plain]), run([ev('e', repeated(9, 10))]))).toBeUndefined();
  });

  it('CLI · diff · advice · the overall share is compared only when the populations are the same, and says how they differ (AC-4)', () => {
    const same = adviceFor(run([ev('e', repeated(9, 10))]), run([ev('e', repeated(4, 10))]))!;
    expect(same.overall.comparison!.word).toBe('worse');
    const other = adviceFor(
      run([ev('e', repeated(9, 10))]),
      run([ev('e', repeated(4, 10), { rows_hash: 'rows-b' })]),
    )!;
    expect(other.overall.comparison).toBeUndefined();
    expect(other.overall.unavailable).toEqual(['eval "e": dataset rows differ (1 → 1)']);
    // The same eval is not compared either: its two sides are not the same dataset.
    expect(other.evals[0]).toMatchObject({
      id: 'e',
      unavailable: ['eval "e": dataset rows differ (1 → 1)'],
    });
    expect(other.evals[0]!.comparison).toBeUndefined();
    const added = adviceFor(
      run([ev('e', repeated(9, 10))]),
      run([ev('e', repeated(4, 10)), ev('f', repeated(4, 10))]),
    )!;
    expect(added.overall.unavailable).toEqual(['eval "f" added']);
  });

  it('CLI · diff · advice · a run by an older plune (population not recorded) is not compared', () => {
    const a = adviceFor(run([ev('e', repeated(9, 10), null)]), run([ev('e', repeated(4, 10))]))!;
    expect(a.overall.comparison).toBeUndefined();
    expect(a.evals[0]!.comparison).toBeUndefined();
  });
});

describe('CLI · diff · advice · the experiment on descriptions', () => {
  const SWAP = [{ tool: 'search', sha256: 'a'.repeat(64) }];
  const base = (hits: number, first = 'list') =>
    run([ev('e', repeated(hits, 10, { hits, first }))]);
  const cur = (hits: number, first = 'search', measured: Partial<Measured> = {}) =>
    run([ev('e', repeated(hits, 10, { hits, first, swap: SWAP }), measured)]);

  it('CLI · diff · advice · same population, different swaps: first-tool distribution and hit share with an interval (AC-11)', () => {
    const x = adviceFor(base(3), cur(9))!.experiment!;
    expect(x.unavailable).toBeUndefined();
    expect(x.baseline).toEqual([]);
    expect(x.current).toEqual([`search=${'a'.repeat(64)}`]);
    expect(x.evals).toHaveLength(1);
    expect(x.evals[0]!.firstTool).toEqual({ baseline: { list: 1 }, current: { search: 1 } });
    expect(x.evals[0]!.hit!.baseline).toEqual({ passed: 3, total: 10 });
    expect(x.evals[0]!.hit!.comparison.word).toBe('better');
  });

  it('CLI · diff · advice · a different population gives no experiment, and says why (AC-11)', () => {
    const x = adviceFor(base(3), cur(9, 'search', { rows_hash: 'rows-b' }))!.experiment!;
    expect(x.evals).toEqual([]);
    expect(x.unavailable).toEqual(['eval "e": dataset rows differ (1 → 1)']);
  });

  it('CLI · diff · advice · without a swap on either side there is no experiment section', () => {
    expect(
      adviceFor(base(3), run([ev('e', repeated(9, 10, { hits: 9, first: 'list' }))]))!.experiment,
    ).toBeUndefined();
  });

  it('CLI · diff · advice · an eval with no first-tool check has the distribution only', () => {
    const noCheck = (r: RunResult) => ({
      ...r,
      evals: r.evals.map((e) => ({
        ...e,
        rows: e.rows.map((row) => ({
          ...row,
          attempts: {
            ...row.attempts!,
            results: row.attempts!.results.map((a) => ({ ...a, assertions: [] })),
          },
        })),
      })),
    });
    const x = adviceFor(noCheck(base(3)), noCheck(cur(9)))!.experiment!;
    expect(x.evals[0]!.hit).toBeUndefined();
    expect(x.evals[0]!.firstTool.current).toEqual({ search: 1 });
  });
});

describe('CLI · diff · advice · changes no exit code, state or count (AC-5)', () => {
  const worse = (): [RunResult, RunResult] => [
    run([ev('e', repeated(9, 10))]),
    run([ev('e', repeated(4, 10))]),
  ];

  it('CLI · diff · advice · "worse" leaves the summary, every eval state and the gates exactly as they are without it', () => {
    const [b, c] = worse();
    const diff = diffRuns(b, c);
    const advice = adviceFor(b, c)!;
    expect(advice.evals[0]!.comparison!.word).toBe('worse');
    expect(diff.summary).toMatchObject({ regressions: 0, unmeasured: 0, hasRegression: false });
    expect(diff.evals[0]!.status).toBe('stable-pass');
    const gates = evaluateGates(
      b,
      c,
      diff,
      { failOnRegression: true },
      [],
      new Date('2026-11-13T00:00:00Z'),
    );
    expect(gates.exitCode).toBe(0);
  });

  it('CLI · diff · advice · the advice is not an input of the gates: the same gates with and without it', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plune-advice-'));
    try {
      const [b, c] = worse();
      const files = { b: path.join(dir, 'b.json'), c: path.join(dir, 'c.json') };
      fs.writeFileSync(files.b, JSON.stringify(b));
      fs.writeFileSync(files.c, JSON.stringify(c));
      const withAdvice = handleDiff({
        baselinePath: files.b,
        currentPath: files.c,
        failOnRegression: true,
      });
      expect(withAdvice.advice?.evals[0]?.comparison?.word).toBe('worse');
      const bare = handleDiff({
        baselinePath: files.b,
        currentPath: files.b,
        failOnRegression: true,
      });
      expect(withAdvice.gates!.exitCode).toBe(0);
      expect(withAdvice.gates!.exitCode).toBe(bare.gates!.exitCode);
      expect(withAdvice.summary).toEqual({ ...bare.summary });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
