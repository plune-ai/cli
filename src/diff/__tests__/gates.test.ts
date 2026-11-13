import { describe, expect, it } from 'vitest';
import { diffRuns } from '../diff.js';
import { evaluateGates, MIN_PASS_RATE_ATTEMPTS, type GateOptions } from '../gates.js';
import { parseWaivers, MAX_WAIVER_REASON, WaiversFileError, type Waiver } from '../waivers.js';
import type { EvalResult, RowResult, RunResult, Usage } from '../../types/results.js';
import { dryRunRow } from '../../orchestrator/run.js';

// --- fixtures: only the fields the gates read ---

const NOW = new Date('2026-11-13T12:00:00Z');

type Measured = NonNullable<EvalResult['measured']>;
const POP: Measured = { runs: 1, rows: 10, rows_hash: 'rows-a', assertions_hash: 'checks-a', model: 'openai/m' };

function row(passed: boolean, usage?: Usage, extra: Partial<RowResult> = {}): RowResult {
  return {
    vars: {},
    output: 'x',
    cached: false,
    ...(usage !== undefined ? { usage } : {}),
    assertions: [{ type: 'exact-match', passed }],
    ...extra,
  };
}

const priced = (cost_usd: number, tokens = 10): Usage => ({
  input_tokens: tokens,
  output_tokens: tokens,
  cost_usd,
  priced: true,
});

/** An eval of `total` rows, `passed` of them passing, each with `usage`. */
function ev(
  id: string,
  passed: number,
  total = 10,
  opts: { measured?: Measured | null; usage?: Usage } = {},
): EvalResult {
  const rows = Array.from({ length: total }, (_, i) => row(i < passed, opts.usage ?? priced(0.01)));
  const measured = opts.measured === null ? {} : { measured: opts.measured ?? { ...POP, rows: total } };
  return { id, tags: [], rows, passed: passed === total, ...measured };
}

function run(evals: EvalResult[]): RunResult {
  return {
    schemaVersion: 1,
    plune_version: '0',
    started_at: '',
    finished_at: '',
    config_hash: '',
    summary: { total: 0, passed: 0, failed: 0, errored: 0, cost_usd: 0, duration_ms: 0 },
    evals,
  };
}

function gates(base: RunResult, cur: RunResult, opts: GateOptions, waivers: Waiver[] = [], now = NOW) {
  return evaluateGates(base, cur, diffRuns(base, cur), opts, waivers, now);
}
const gate = (r: ReturnType<typeof gates>, name: string) => r.gates.find((g) => g.gate === name)!;

describe('CLI · diff · gates · pass-rate population rule', () => {
  it('AC-1: the same evals, rows, repeats, model and checks: the rate is compared and a drop over the limit fails', () => {
    const base = run([ev('a', 10), ev('b', 10)]);
    const cur = run([ev('a', 10), ev('b', 7)]);
    const r = gates(base, cur, { maxPassRateDropPercent: 10 });
    expect(gate(r, 'pass-rate')).toMatchObject({ state: 'failed', value: 15, threshold: 10 });
    expect(r.exitCode).toBe(1);
    expect(gate(gates(base, cur, { maxPassRateDropPercent: 15 }), 'pass-rate').state).toBe('passed');
  });

  it('AC-2: an eval added in the current run makes the rate unmeasured and is named; a per-eval regression still exits 1', () => {
    const base = run([ev('a', 10), ev('b', 10)]);
    const cur = run([ev('a', 10), ev('b', 9), ev('x', 10)]);
    const r = gates(base, cur, { maxPassRateDropPercent: 50 });
    expect(gate(r, 'pass-rate').state).toBe('unmeasured');
    expect(gate(r, 'pass-rate').details).toContain('eval "x" added');
    expect(r.exitCode).toBe(3);
    const withRegression = gates(base, cur, { failOnRegression: true, maxPassRateDropPercent: 50 });
    expect(gate(withRegression, 'regression').state).toBe('failed');
    expect(withRegression.exitCode).toBe(1);
  });

  it('a removed eval changes the population as well', () => {
    const r = gates(run([ev('a', 10), ev('b', 10)]), run([ev('a', 10)]), { maxPassRateDropPercent: 5 });
    expect(gate(r, 'pass-rate').details).toEqual(['eval "b" removed']);
  });

  it.each([
    ['other dataset rows', { rows_hash: 'rows-b' }, 'eval "a": dataset rows differ (10 → 10)'],
    ['another number of repeats', { runs: 3 }, 'eval "a": runs per row differ (1 → 3)'],
    ['another model', { model: 'openai/other' }, 'eval "a": model differs (openai/m → openai/other)'],
    ['another set of checks', { assertions_hash: 'checks-b' }, 'eval "a": assertions differ'],
  ])('AC-3: %s make the rate unmeasured and name the reason', (_name, change, reason) => {
    const r = gates(run([ev('a', 10)]), run([ev('a', 10, 10, { measured: { ...POP, ...change } })]), {
      maxPassRateDropPercent: 5,
    });
    expect(gate(r, 'pass-rate')).toMatchObject({ state: 'unmeasured', details: [reason] });
    expect(r.exitCode).toBe(3);
  });

  it('a model recorded on one side only is a difference; unrecorded on both is the same model', () => {
    const { model: _m, ...noModel } = POP;
    const one = gates(run([ev('a', 10)]), run([ev('a', 10, 10, { measured: noModel })]), { maxPassRateDropPercent: 5 });
    expect(gate(one, 'pass-rate').details).toEqual(['eval "a": model differs (openai/m → not recorded)']);
    const both = gates(run([ev('a', 10, 10, { measured: noModel })]), run([ev('a', 10, 10, { measured: noModel })]), {
      maxPassRateDropPercent: 5,
    });
    expect(gate(both, 'pass-rate').state).toBe('passed');
  });

  it('AC-4: a result without `measured` (an older plune) on either side: the rate is unmeasured', () => {
    for (const [b, c, side] of [
      [ev('a', 10, 10, { measured: null }), ev('a', 10), 'the baseline'],
      [ev('a', 10), ev('a', 10, 10, { measured: null }), 'the current run'],
    ] as const) {
      const r = gates(run([b]), run([c]), { maxPassRateDropPercent: 5 });
      expect(gate(r, 'pass-rate').state).toBe('unmeasured');
      expect(gate(r, 'pass-rate').details).toEqual([`eval "a": population not recorded in ${side} (a run by an older plune)`]);
    }
  });

  it(`AC-5: fewer than ${MIN_PASS_RATE_ATTEMPTS} attempts on a side: unmeasured, not passed`, () => {
    expect(MIN_PASS_RATE_ATTEMPTS).toBeGreaterThanOrEqual(10);
    const r = gates(run([ev('a', 3, 3)]), run([ev('a', 3, 3)]), { maxPassRateDropPercent: 5 });
    expect(gate(r, 'pass-rate')).toMatchObject({ state: 'unmeasured' });
    expect(gate(r, 'pass-rate').reason).toMatch(/fewer than 10 attempts/);
  });

  it('two empty results can never give a measured rate', () => {
    const r = gates(run([]), run([]), { failOnRegression: true, maxPassRateDropPercent: 5 });
    expect(gate(r, 'pass-rate').state).toBe('unmeasured');
    expect(gate(r, 'regression').state).toBe('unmeasured');
    expect(r.exitCode).toBe(3);
  });

  it('repeats count every attempt: attempts.passed of attempts.runs', () => {
    const repeated = (passed: number): EvalResult => ({
      id: 'a',
      tags: [],
      passed: true,
      measured: { ...POP, runs: 10, rows: 1 },
      rows: [
        {
          ...row(true, priced(0.01)),
          attempts: { runs: 10, pass_threshold: 0.5, passed, failed: 10 - passed, errored: 0, results: [] },
        },
      ],
    });
    const r = gates(run([repeated(10)]), run([repeated(6)]), { maxPassRateDropPercent: 30 });
    expect(gate(r, 'pass-rate')).toMatchObject({ state: 'failed', value: 40 });
  });
});

/** A dry run of the same suite, built the way `plune run --dry-run` builds it: every row priced, none judged. */
function dryRun(evals: EvalResult[]): RunResult {
  const priceOnly = (e: EvalResult): EvalResult => ({
    ...e,
    passed: false,
    rows: e.rows.map((r) => dryRunRow(r.vars, r.usage ?? priced(0.01))),
  });
  return { ...run(evals.map(priceOnly)), dry_run: true };
}

describe('CLI · diff · gates · a dry run measured nothing (#252)', () => {
  const measured = run([ev('a', 10)]);

  it('as the current run: the pass rate is unmeasured (exit 3), not 0 of 10, and the reason names the dry run', () => {
    const r = gates(measured, dryRun([ev('a', 10)]), { maxPassRateDropPercent: 5 });
    expect(gate(r, 'pass-rate')).toMatchObject({
      state: 'unmeasured',
      reason: 'the current run is a dry run: nothing was measured',
    });
    expect(r.exitCode).toBe(3);
  });

  it('as the baseline: unmeasured as well, not a green gate over a baseline of 0 of 10', () => {
    const r = gates(dryRun([ev('a', 10)]), measured, { maxPassRateDropPercent: 5 });
    expect(gate(r, 'pass-rate')).toMatchObject({
      state: 'unmeasured',
      reason: 'the baseline is a dry run: nothing was measured',
    });
    expect(r.exitCode).toBe(3);
  });

  it('names the dry run first, even when the two files also differ in evals and have too few attempts', () => {
    const r = gates(measured, dryRun([ev('a', 3, 3), ev('b', 3, 3)]), { maxPassRateDropPercent: 5 });
    expect(gate(r, 'pass-rate').reason).toBe('the current run is a dry run: nothing was measured');
    expect(gate(r, 'pass-rate').details).toBeUndefined();
  });

  it('a waiver on the pass rate does not lift it', () => {
    const w = waiver({ gate: 'pass-rate', eval: undefined });
    const r = gates(measured, dryRun([ev('a', 10)]), { maxPassRateDropPercent: 5 }, [w]);
    expect(gate(r, 'pass-rate').state).toBe('unmeasured');
    expect(r.exitCode).toBe(3);
    expect(r.waivers.unused).toEqual([w]);
  });

  it('the eval-by-eval diff and the regression gate read the same dry run as unmeasured', () => {
    const cur = dryRun([ev('a', 10)]);
    expect(diffRuns(measured, cur).evals.map((e) => e.status)).toEqual(['unmeasured']);
    const r = gates(measured, cur, { failOnRegression: true });
    expect(gate(r, 'regression').state).toBe('unmeasured');
    expect(r.exitCode).toBe(3);
  });
});

describe('CLI · diff · gates · regression', () => {
  it('a deterministic regression gates whatever happens around it (item 2)', () => {
    const r = gates(run([ev('a', 10)]), run([ev('a', 9), ev('new', 10)]), { failOnRegression: true });
    expect(gate(r, 'regression')).toMatchObject({ state: 'failed' });
    expect(gate(r, 'regression').reason).toContain('a');
  });

  it('no regression and every eval measured: passed, exit 0', () => {
    const r = gates(run([ev('a', 10)]), run([ev('a', 10)]), { failOnRegression: true });
    expect(gate(r, 'regression').state).toBe('passed');
    expect(r.exitCode).toBe(0);
  });

  it('AC-14: an eval whose rows are all blocked or skipped is unmeasured, not passed', () => {
    const blocked: EvalResult = {
      id: 'a',
      tags: [],
      passed: true,
      rows: [{ ...row(true), inconclusive: 'blocked' }, { ...row(true), inconclusive: 'skipped' }],
    };
    const d = diffRuns(run([ev('a', 10)]), run([blocked]));
    expect(d.evals[0]!.status).toBe('unmeasured');
    const r = gates(run([ev('a', 10)]), run([blocked]), { failOnRegression: true });
    expect(gate(r, 'regression').state).toBe('unmeasured');
    expect(r.exitCode).toBe(3);
  });
});

describe('CLI · diff · gates · cost and tokens', () => {
  it('--max-cost-usd: measured over the limit fails, under it passes', () => {
    const base = run([ev('a', 10)]);
    const cur = run([ev('a', 10, 10, { usage: priced(0.05) })]); // $0.50
    expect(gate(gates(base, cur, { maxCostUsd: 0.4 }), 'cost')).toMatchObject({ state: 'failed', value: 0.5, threshold: 0.4 });
    expect(gate(gates(base, cur, { maxCostUsd: 1 }), 'cost').state).toBe('passed');
  });

  it('AC-6: a row with priced false or without priced makes both cost gates unmeasured (exit 3), never 0', () => {
    for (const usage of [
      { input_tokens: 1, output_tokens: 1, cost_usd: 0, priced: false },
      { input_tokens: 1, output_tokens: 1, cost_usd: 0 },
    ]) {
      const cur = run([{ ...ev('a', 10), rows: [...ev('a', 9, 9).rows, row(true, usage)] }]);
      const r = gates(run([ev('a', 10)]), cur, { maxCostUsd: 100, maxCostIncreasePercent: 1000 });
      expect(gate(r, 'cost').state).toBe('unmeasured');
      expect(gate(r, 'cost-increase').state).toBe('unmeasured');
      expect(gate(r, 'cost').reason).toMatch(/no known price/);
      expect(r.exitCode).toBe(3);
    }
  });

  it('a row with no usage at all is unmeasured for cost and tokens', () => {
    const cur = run([{ ...ev('a', 10), rows: [row(true)] }]);
    const r = gates(run([ev('a', 10)]), cur, { maxCostUsd: 100, maxTokens: 1e9 });
    expect(gate(r, 'cost').reason).toMatch(/no usage/);
    expect(gate(r, 'tokens').state).toBe('unmeasured');
  });

  it('a baseline without prices makes the relative gate unmeasured, not the absolute one', () => {
    const base = run([ev('a', 10, 10, { usage: { input_tokens: 1, output_tokens: 1, cost_usd: 0 } })]);
    const r = gates(base, run([ev('a', 10)]), { maxCostUsd: 100, maxCostIncreasePercent: 10 });
    expect(gate(r, 'cost').state).toBe('passed');
    expect(gate(r, 'cost-increase')).toMatchObject({ state: 'unmeasured' });
    expect(gate(r, 'cost-increase').reason).toMatch(/^baseline: /);
  });

  it('AC-7: a run answered entirely from the cache costs what it spent plus what the cache saved', () => {
    const fromCache: EvalResult = {
      ...ev('a', 10),
      rows: Array.from({ length: 10 }, () =>
        row(true, { input_tokens: 10, output_tokens: 10, cost_usd: 0, priced: true }, {
          cached: true,
          cache_saved: { input_tokens: 10, output_tokens: 10, cost_usd: 0.05 },
        }),
      ),
    };
    const r = gates(run([ev('a', 10)]), run([fromCache]), { maxCostUsd: 0.4, maxCostIncreasePercent: 10 });
    expect(gate(r, 'cost')).toMatchObject({ state: 'failed', value: 0.5 });
    expect(gate(r, 'cost-increase')).toMatchObject({ state: 'failed', value: 400 });
  });

  it('--max-cost-increase-percent: compares with the baseline', () => {
    const base = run([ev('a', 10)]); // $0.10
    const cur = run([ev('a', 10, 10, { usage: priced(0.012) })]); // $0.12
    expect(gate(gates(base, cur, { maxCostIncreasePercent: 10 }), 'cost-increase')).toMatchObject({
      state: 'failed',
      value: 20,
    });
    expect(gate(gates(base, cur, { maxCostIncreasePercent: 20 }), 'cost-increase').state).toBe('passed');
  });

  it('AC-8: a zero-cost baseline gives unmeasured for the relative gate, not an infinite increase or a pass', () => {
    const base = run([ev('a', 10, 10, { usage: priced(0) })]);
    const r = gates(base, run([ev('a', 10)]), { maxCostIncreasePercent: 10 });
    expect(gate(r, 'cost-increase')).toMatchObject({ state: 'unmeasured' });
    expect(gate(r, 'cost-increase').reason).toMatch(/baseline cost is 0/);
    expect(r.exitCode).toBe(3);
  });

  it('AC-9: --max-tokens over the limit fails (exit 1); no token data gives 3', () => {
    const cur = run([ev('a', 10)]); // 10 rows × 20 tokens
    expect(gates(run([ev('a', 10)]), cur, { maxTokens: 199 }).exitCode).toBe(1);
    expect(gate(gates(run([ev('a', 10)]), cur, { maxTokens: 200 }), 'tokens')).toMatchObject({ state: 'passed', value: 200 });
    const noTokens = run([{ ...ev('a', 10), rows: [row(true)] }]);
    expect(gates(run([ev('a', 10)]), noTokens, { maxTokens: 200 }).exitCode).toBe(3);
  });

  it('a run with no rows measures no cost and no tokens', () => {
    const r = gates(run([]), run([]), { maxCostUsd: 1, maxTokens: 1 });
    expect(gate(r, 'cost').state).toBe('unmeasured');
    expect(gate(r, 'tokens').state).toBe('unmeasured');
  });

  it('only the gates asked for are reported; none asked for gives exit 0', () => {
    const r = gates(run([ev('a', 10)]), run([ev('a', 0)]), {});
    expect(r.gates).toEqual([]);
    expect(r.exitCode).toBe(0);
    expect(gates(run([ev('a', 10)]), run([ev('a', 10)]), { maxTokens: 1e9 }).gates.map((g) => g.gate)).toEqual(['tokens']);
  });
});

const waiver = (w: Partial<Waiver> = {}): Waiver => ({
  gate: 'regression',
  eval: 'a',
  reason: 'known flake, fix in progress',
  granted: '2026-11-10',
  expires: '2026-11-20',
  ...w,
});

describe('CLI · diff · gates · waivers', () => {
  const base = run([ev('a', 10)]);
  const cur = run([ev('a', 9)]);

  it('AC-10: a valid regression waiver lifts exit 1 and the report shows it as waived', () => {
    const w = waiver();
    const r = gates(base, cur, { failOnRegression: true }, [w]);
    expect(gate(r, 'regression')).toMatchObject({ state: 'waived', value: 1 });
    expect(r.waivers.applied).toEqual([w]);
    expect(r.exitCode).toBe(0);
  });

  it('AC-10: the same regression with an expired waiver exits 1 and the report lists it as expired', () => {
    const w = waiver({ granted: '2026-11-01', expires: '2026-11-12' });
    const r = gates(base, cur, { failOnRegression: true }, [w]);
    expect(gate(r, 'regression').state).toBe('failed');
    expect(r.waivers.expired).toEqual([w]);
    expect(r.exitCode).toBe(1);
  });

  it('a waiver holds until the end of its expiry day in UTC', () => {
    const w = waiver({ expires: '2026-11-13' });
    expect(gates(base, cur, { failOnRegression: true }, [w], new Date('2026-11-13T23:59:59Z')).exitCode).toBe(0);
    expect(gates(base, cur, { failOnRegression: true }, [w], new Date('2026-11-14T00:00:00Z')).exitCode).toBe(1);
  });

  it('a regression waiver covers its own eval only', () => {
    const r = gates(base, cur, { failOnRegression: true }, [waiver({ eval: 'other' })]);
    expect(gate(r, 'regression').state).toBe('failed');
    expect(r.waivers.unused).toHaveLength(1);
  });

  it('AC-11: a valid waiver never lifts unmeasured (3); a waiver for a gate that did not fail is unused', () => {
    const noPrice = run([ev('a', 10, 10, { usage: { input_tokens: 1, output_tokens: 1, cost_usd: 0 } })]);
    const cost = waiver({ gate: 'cost', eval: undefined });
    const regression = waiver();
    const r = gates(base, noPrice, { failOnRegression: true, maxCostUsd: 1 }, [cost, regression]);
    expect(gate(r, 'cost').state).toBe('unmeasured');
    expect(r.exitCode).toBe(3);
    expect(r.waivers.unused).toEqual([cost, regression]);
    expect(r.waivers.applied).toEqual([]);
  });

  it('a regression waived while another eval is unmeasured still exits 3', () => {
    const errored: EvalResult = { ...ev('b', 0, 1), rows: [{ ...row(false), error: { code: 'X', message: 'down' } }] };
    const r = gates(run([ev('a', 10), ev('b', 10)]), run([ev('a', 9), errored]), { failOnRegression: true }, [waiver()]);
    expect(gate(r, 'regression').state).toBe('unmeasured');
    expect(r.exitCode).toBe(3);
  });

  it('waivers lift a measured pass-rate, cost or tokens failure', () => {
    const pricey = run([ev('a', 10, 10, { usage: priced(1, 1000) })]);
    const r = gates(base, pricey, { maxCostUsd: 1, maxCostIncreasePercent: 1, maxTokens: 1, maxPassRateDropPercent: 0 }, [
      waiver({ gate: 'cost', eval: undefined }),
      waiver({ gate: 'tokens', eval: undefined }),
    ]);
    expect(r.gates.map((g) => [g.gate, g.state])).toEqual([
      ['pass-rate', 'passed'],
      ['cost', 'waived'],
      ['cost-increase', 'waived'],
      ['tokens', 'waived'],
    ]);
    expect(r.exitCode).toBe(0);
    const drop = gates(base, cur, { maxPassRateDropPercent: 5 }, [waiver({ gate: 'pass-rate', eval: undefined })]);
    expect(gate(drop, 'pass-rate').state).toBe('waived');
  });
});

describe('CLI · diff · gates · waivers file', () => {
  const file = (entry: string) => `waivers:\n  - ${entry.trim().split('\n').join('\n    ')}\n`;
  const ok = `gate: regression
eval: a
reason: known flake
granted: "2026-11-10"
expires: "2026-11-20"`;

  it('reads a valid file', () => {
    expect(parseWaivers(file(ok), NOW)).toEqual([
      { gate: 'regression', eval: 'a', reason: 'known flake', granted: '2026-11-10', expires: '2026-11-20' },
    ]);
    expect(parseWaivers('waivers: []\n', NOW)).toEqual([]);
    expect(parseWaivers(file(ok.replace(/"/g, '')), NOW)).toHaveLength(1);
  });

  it.each([
    ['no expires', ok.replace(/\nexpires.*/, ''), /waivers\[0\].*expires is required/],
    ['more than 30 days', ok.replace('2026-11-20', '2026-12-11'), /waivers\[0\].*at most 30 days/],
    ['reversed dates', ok.replace('2026-11-20', '2026-11-09'), /waivers\[0\].*expires must be after granted/],
    ['a reason over the limit', ok.replace('known flake', 'x'.repeat(MAX_WAIVER_REASON + 1)), /reason is longer than 200/],
    ['an empty reason', ok.replace('known flake', '""'), /reason is required/],
    ['an unknown gate', ok.replace('gate: regression', 'gate: latency'), /waivers\[0\].*gate must be one of/],
    ['a regression without eval', ok.replace(/\neval: a/, ''), /eval is required for gate regression/],
    ['eval on another gate', ok.replace('gate: regression', 'gate: cost'), /eval applies to gate regression only/],
    ['not a date', ok.replace('"2026-11-10"', '"2026-02-30"'), /granted must be a date/],
    ['granted in the future', ok.replace('2026-11-10', '2026-12-01').replace('2026-11-20', '2026-12-20'), /granted is in the future/],
    ['an unknown key', `${ok}\nexpire: "2026-11-20"`, /unknown key "expire"/],
  ])('AC-12: %s is an input error naming the entry', (_name, entry, message) => {
    expect(() => parseWaivers(file(entry), NOW)).toThrow(WaiversFileError);
    expect(() => parseWaivers(file(entry), NOW)).toThrow(message);
  });

  it.each([
    ['not YAML', 'waivers: [\n'],
    ['no waivers list', 'other: 1\n'],
    ['an entry that is not a mapping', 'waivers:\n  - just text\n'],
    ['an empty file', ''],
  ])('%s is an input error', (_name, text) => {
    expect(() => parseWaivers(text, NOW)).toThrow(WaiversFileError);
  });

  it('a waiver that expired is still a valid file entry (reported as expired, not an error)', () => {
    expect(parseWaivers(file(ok), new Date('2027-01-01T00:00:00Z'))).toHaveLength(1);
  });
});
