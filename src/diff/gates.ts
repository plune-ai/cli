// The gates of `plune diff` (MCP-D5). Pure: two RunResults, their diff, the limits asked for, the waivers and
// the clock in; a state per gate and the exit code out. The rule throughout: a value that is missing never
// gives green. A gate whose value cannot be measured is `unmeasured` (exit 3), and no waiver lifts that.

import type { EvalResult, RowResult, RunResult } from '../types/results.js';
import { rowStatus } from '../types/results.js';
import type { RunDiff } from './diff.js';
import { isExpired, type Waiver, type WaiverGate } from './waivers.js';

/** Below this many attempts on either side an overall pass rate says too little to gate on. */
export const MIN_PASS_RATE_ATTEMPTS = 10;

export type GateName = 'regression' | 'pass-rate' | 'cost' | 'cost-increase' | 'tokens';
export type GateState = 'passed' | 'failed' | 'unmeasured' | 'waived';

export interface GateResult {
  gate: GateName;
  state: GateState;
  reason: string;
  /** Regressions (count), pass-rate drop (percentage points), cost (USD), cost increase (%), tokens. */
  value?: number;
  threshold?: number;
  /** Each difference that made the pass rate unmeasured, or each eval that was not measured. */
  details?: string[];
}

/** Each gate is on only when its limit is given. */
export interface GateOptions {
  failOnRegression?: boolean;
  maxPassRateDropPercent?: number;
  maxCostUsd?: number;
  maxCostIncreasePercent?: number;
  maxTokens?: number;
}

export interface GatesReport {
  /** 0 all measured and nothing failed (waived failures included); 1 a measured failure; 3 something unmeasured. */
  exitCode: 0 | 1 | 3;
  gates: GateResult[];
  waivers: { applied: Waiver[]; expired: Waiver[]; unused: Waiver[] };
}

export function gatesEnabled(o: GateOptions): boolean {
  return (
    o.failOnRegression === true ||
    o.maxPassRateDropPercent !== undefined ||
    o.maxCostUsd !== undefined ||
    o.maxCostIncreasePercent !== undefined ||
    o.maxTokens !== undefined
  );
}

const WAIVER_OF: Record<GateName, WaiverGate> = {
  regression: 'regression',
  'pass-rate': 'pass-rate',
  cost: 'cost',
  'cost-increase': 'cost',
  tokens: 'tokens',
};

const round = (n: number): number => Math.round(n * 1e6) / 1e6;
// Floating sums (0.1 + 0.2) must not fail a gate that sits exactly on its limit.
const over = (value: number, limit: number): boolean => value - limit > 1e-9;

function regressionGate(diff: RunDiff, current: RunResult, waived: (id: string) => boolean): GateResult {
  const regressed = diff.evals.filter((e) => e.status === 'regression').map((e) => e.id);
  const open = regressed.filter((id) => !waived(id));
  const counts = { value: open.length, threshold: 0 };
  if (open.length > 0) return { gate: 'regression', state: 'failed', reason: `passed → failed: ${open.join(', ')}`, ...counts };
  const unmeasured = diff.evals.filter((e) => e.status === 'errored' || e.status === 'unmeasured').map((e) => e.id);
  if (unmeasured.length > 0)
    return { gate: 'regression', state: 'unmeasured', reason: `${unmeasured.length} eval(s) not measured`, details: unmeasured };
  if (current.evals.length === 0)
    return { gate: 'regression', state: 'unmeasured', reason: 'the current run has no evals' };
  if (regressed.length > 0)
    return {
      gate: 'regression',
      state: 'waived',
      reason: `passed → failed, waived: ${regressed.join(', ')}`,
      value: regressed.length,
      threshold: 0,
    };
  return { gate: 'regression', state: 'passed', reason: 'no eval went from passed to failed', ...counts };
}

/** Every way the two runs measured different things, one line each; empty when the populations match. */
export function populationDiffs(baseline: RunResult, current: RunResult): string[] {
  const base = new Map(baseline.evals.map((e) => [e.id, e]));
  const cur = new Map(current.evals.map((e) => [e.id, e]));
  const out: string[] = [];
  for (const id of base.keys()) if (!cur.has(id)) out.push(`eval "${id}" removed`);
  for (const id of cur.keys()) if (!base.has(id)) out.push(`eval "${id}" added`);
  for (const [id, b] of base) {
    const c = cur.get(id);
    if (c === undefined) continue;
    const [mb, mc] = [b.measured, c.measured];
    if (mb === undefined || mc === undefined) {
      const side = mb === undefined && mc === undefined ? 'either run' : mb === undefined ? 'the baseline' : 'the current run';
      out.push(`eval "${id}": population not recorded in ${side} (a run by an older plune)`);
      continue;
    }
    if (mb.rows !== mc.rows || mb.rows_hash !== mc.rows_hash)
      out.push(`eval "${id}": dataset rows differ (${mb.rows} → ${mc.rows})`);
    if (mb.runs !== mc.runs) out.push(`eval "${id}": runs per row differ (${mb.runs} → ${mc.runs})`);
    if (mb.model !== mc.model)
      out.push(`eval "${id}": model differs (${mb.model ?? 'not recorded'} → ${mc.model ?? 'not recorded'})`);
    if (mb.assertions_hash !== mc.assertions_hash) out.push(`eval "${id}": assertions differ`);
  }
  return out;
}

/** Passed attempts of all attempts: a repeated row counts each run, a plain row one. */
function attempts(run: RunResult): { passed: number; total: number } {
  let passed = 0;
  let total = 0;
  for (const row of run.evals.flatMap((e) => e.rows)) {
    if (row.attempts !== undefined) {
      passed += row.attempts.passed;
      total += row.attempts.runs;
    } else {
      passed += rowStatus(row) === 'passed' ? 1 : 0;
      total += 1;
    }
  }
  return { passed, total };
}

function passRateGate(baseline: RunResult, current: RunResult, limit: number): GateResult {
  const threshold = limit;
  // A dry run priced its rows and judged none (#252): its rate is 0 of N by construction, which read as
  // a drop when it was the current run and as a green gate when it was the baseline.
  const dry =
    baseline.dry_run === true ? 'baseline' : current.dry_run === true ? 'current run' : undefined;
  if (dry !== undefined)
    return {
      gate: 'pass-rate',
      state: 'unmeasured',
      reason: `the ${dry} is a dry run: nothing was measured`,
      threshold,
    };
  const diffs = populationDiffs(baseline, current);
  if (diffs.length > 0)
    return {
      gate: 'pass-rate',
      state: 'unmeasured',
      reason: 'the two runs did not measure the same population',
      threshold,
      details: diffs,
    };
  const [b, c] = [attempts(baseline), attempts(current)];
  if (b.total < MIN_PASS_RATE_ATTEMPTS || c.total < MIN_PASS_RATE_ATTEMPTS)
    return {
      gate: 'pass-rate',
      state: 'unmeasured',
      reason: `fewer than ${MIN_PASS_RATE_ATTEMPTS} attempts (baseline ${b.total}, current ${c.total})`,
      threshold,
    };
  const drop = round(((b.passed / b.total) - (c.passed / c.total)) * 100);
  return {
    gate: 'pass-rate',
    state: over(drop, limit) ? 'failed' : 'passed',
    reason: `pass rate ${b.passed}/${b.total} → ${c.passed}/${c.total}`,
    value: drop,
    threshold,
  };
}

type Measure = { value: number } | { missing: string };

/** Sum over every row, or why it cannot be measured: a row with no usage, or (for cost) no known price. */
function measure(run: RunResult, of: (row: RowResult, e: EvalResult) => number | string): Measure {
  let value = 0;
  let rows = 0;
  for (const e of run.evals)
    for (const row of e.rows) {
      const v = of(row, e);
      if (typeof v === 'string') return { missing: v };
      value += v;
      rows += 1;
    }
  return rows === 0 ? { missing: 'no rows' } : { value: round(value) };
}

// What the run cost: spent plus what the cache saved, so a run replayed from the cache is not free.
const cost = (run: RunResult): Measure =>
  measure(run, (row, e) =>
    row.usage === undefined
      ? `eval "${e.id}" has a row with no usage`
      : row.usage.priced !== true
        ? `eval "${e.id}" has a row with no known price`
        : row.usage.cost_usd + (row.cache_saved?.cost_usd ?? 0),
  );

const tokens = (run: RunResult): Measure =>
  measure(run, (row, e) =>
    row.usage === undefined ? `eval "${e.id}" has a row with no usage` : row.usage.input_tokens + row.usage.output_tokens,
  );

function limitGate(gate: GateName, m: Measure, limit: number, reason: string): GateResult {
  if ('missing' in m) return { gate, state: 'unmeasured', reason: `current run: ${m.missing}`, threshold: limit };
  return { gate, state: over(m.value, limit) ? 'failed' : 'passed', reason, value: m.value, threshold: limit };
}

function costIncreaseGate(baseline: RunResult, current: RunResult, limit: number): GateResult {
  const [b, c] = [cost(baseline), cost(current)];
  const unmeasured = (reason: string): GateResult => ({ gate: 'cost-increase', state: 'unmeasured', reason, threshold: limit });
  if ('missing' in b) return unmeasured(`baseline: ${b.missing}`);
  if ('missing' in c) return unmeasured(`current run: ${c.missing}`);
  if (b.value === 0) return unmeasured('baseline cost is 0: there is no increase to measure');
  const increase = round(((c.value - b.value) / b.value) * 100);
  return {
    gate: 'cost-increase',
    state: over(increase, limit) ? 'failed' : 'passed',
    reason: `cost $${b.value} → $${c.value}`,
    value: increase,
    threshold: limit,
  };
}

/**
 * The state of each gate asked for. `now` is the clock the waivers' expiry is read against: the caller passes
 * the system time, and nothing in a flag, the environment or the file can move it.
 */
export function evaluateGates(
  baseline: RunResult,
  current: RunResult,
  diff: RunDiff,
  opts: GateOptions,
  waivers: Waiver[],
  now: Date,
): GatesReport {
  const active = waivers.filter((w) => !isExpired(w, now));
  const used = new Set<Waiver>();
  const take = (gate: WaiverGate, evalId?: string): boolean => {
    const w = active.find((x) => x.gate === gate && (gate !== 'regression' || x.eval === evalId));
    if (w !== undefined) used.add(w);
    return w !== undefined;
  };

  const gates: GateResult[] = [];
  if (opts.failOnRegression === true) gates.push(regressionGate(diff, current, (id) => take('regression', id)));
  if (opts.maxPassRateDropPercent !== undefined) gates.push(passRateGate(baseline, current, opts.maxPassRateDropPercent));
  if (opts.maxCostUsd !== undefined)
    gates.push(limitGate('cost', cost(current), opts.maxCostUsd, 'cost of the current run, cache savings included'));
  if (opts.maxCostIncreasePercent !== undefined)
    gates.push(costIncreaseGate(baseline, current, opts.maxCostIncreasePercent));
  if (opts.maxTokens !== undefined)
    gates.push(limitGate('tokens', tokens(current), opts.maxTokens, 'input + output tokens of the current run'));

  // A waiver lifts a measured failure only: never `unmeasured`, never an input error.
  for (const g of gates)
    if (g.gate !== 'regression' && g.state === 'failed' && take(WAIVER_OF[g.gate])) g.state = 'waived';

  const exitCode = gates.some((g) => g.state === 'failed') ? 1 : gates.some((g) => g.state === 'unmeasured') ? 3 : 0;
  return {
    exitCode,
    gates,
    waivers: {
      applied: waivers.filter((w) => used.has(w)),
      expired: waivers.filter((w) => isExpired(w, now)),
      unused: active.filter((w) => !used.has(w)),
    },
  };
}
