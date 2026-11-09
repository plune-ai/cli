import { describe, expect, it } from 'vitest';
import { diffRuns } from '../diff.js';
import type { RunResult, EvalResult, RowResult } from '../../types/results.js';

// --- minimal RunResult fixtures (only the fields diffRuns reads) ---

function row(opts: { fail?: boolean; errored?: boolean } = {}): RowResult {
  if (opts.errored) {
    return {
      vars: {},
      output: null,
      cached: false,
      error: { code: 'PROVIDER_TRANSIENT_EXHAUSTED', message: 'down' },
      assertions: [],
    };
  }
  return {
    vars: {},
    output: 'x',
    cached: false,
    assertions: [{ type: 'exact-match', passed: !opts.fail }],
  };
}

function ev(id: string, status: 'passed' | 'failed' | 'errored'): EvalResult {
  const r = row(status === 'failed' ? { fail: true } : status === 'errored' ? { errored: true } : {});
  return { id, tags: [], rows: [r], passed: status === 'passed' };
}

function run(evals: EvalResult[]): RunResult {
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

describe('diffRuns', () => {
  it('classifies pass→fail as a regression (AC-2.2)', () => {
    const d = diffRuns(run([ev('a', 'passed')]), run([ev('a', 'failed')]));
    expect(d.evals).toEqual([{ id: 'a', status: 'regression', baseline: 'passed', current: 'failed' }]);
    expect(d.summary.regressions).toBe(1);
    expect(d.summary.hasRegression).toBe(true);
  });

  it('fail→fail is pre-existing-fail, NOT a regression (AC-2.3)', () => {
    const d = diffRuns(run([ev('a', 'failed')]), run([ev('a', 'failed')]));
    expect(d.evals[0]!.status).toBe('pre-existing-fail');
    expect(d.summary.hasRegression).toBe(false);
  });

  it('fail→pass is an improvement (AC-2.4)', () => {
    const d = diffRuns(run([ev('a', 'failed')]), run([ev('a', 'passed')]));
    expect(d.evals[0]!.status).toBe('improvement');
  });

  it('a new eval that fails is new-fail and does NOT gate (AC-2.5)', () => {
    const d = diffRuns(run([]), run([ev('a', 'failed')]));
    expect(d.evals[0]!.status).toBe('new-fail');
    expect(d.summary.hasRegression).toBe(false);
  });

  it('a new eval that passes is new-pass', () => {
    const d = diffRuns(run([]), run([ev('a', 'passed')]));
    expect(d.evals[0]!.status).toBe('new-pass');
  });

  it('pass→pass is stable-pass', () => {
    const d = diffRuns(run([ev('a', 'passed')]), run([ev('a', 'passed')]));
    expect(d.evals[0]!.status).toBe('stable-pass');
  });

  it('a current errored eval is "errored", never a regression (AC-2.6)', () => {
    const d = diffRuns(run([ev('a', 'passed')]), run([ev('a', 'errored')]));
    expect(d.evals[0]!.status).toBe('errored');
    expect(d.summary.hasRegression).toBe(false);
  });

  // plune#2414 — an eval with no verdict is counted, so a gate can refuse to call it green.
  it('counts as unmeasured a current errored eval and a baseline errored one that fails now', () => {
    const d = diffRuns(
      run([ev('a', 'passed'), ev('b', 'errored'), ev('c', 'errored'), ev('d', 'errored'), ev('e', 'passed')]),
      run([ev('a', 'errored'), ev('b', 'errored'), ev('c', 'failed'), ev('d', 'passed'), ev('e', 'passed')]),
    );
    expect(d.summary.unmeasured).toBe(3); // a, b, c
    expect(d.evals.find((e) => e.id === 'c')!.status).toBe('pre-existing-fail'); // status names stay
    expect(d.evals.find((e) => e.id === 'd')!.status).toBe('improvement'); // measured now and green
    expect(d.summary.hasRegression).toBe(false);
  });

  it('a new eval that errors is unmeasured; every eval measured gives 0', () => {
    expect(diffRuns(run([]), run([ev('a', 'errored')])).summary.unmeasured).toBe(1);
    expect(diffRuns(run([ev('a', 'failed')]), run([ev('a', 'failed')])).summary.unmeasured).toBe(0);
  });

  it('an eval removed in current is "removed"', () => {
    const d = diffRuns(run([ev('a', 'passed')]), run([]));
    expect(d.evals[0]!.status).toBe('removed');
  });

  it('keys on eval id; row order does not create phantom regressions', () => {
    const base = run([ev('a', 'passed'), ev('b', 'passed')]);
    const cur = run([ev('b', 'passed'), ev('a', 'passed')]); // reordered
    const d = diffRuns(base, cur);
    expect(d.summary.hasRegression).toBe(false);
    expect(d.summary.stablePasses).toBe(2);
  });

  it('summary counts each bucket', () => {
    const base = run([ev('reg', 'passed'), ev('imp', 'failed'), ev('pre', 'failed'), ev('gone', 'passed')]);
    const cur = run([ev('reg', 'failed'), ev('imp', 'passed'), ev('pre', 'failed'), ev('new', 'failed')]);
    const d = diffRuns(base, cur);
    expect(d.summary).toMatchObject({
      regressions: 1,
      improvements: 1,
      preExistingFails: 1,
      newFails: 1,
      removed: 1,
      hasRegression: true,
    });
  });

  // plune#1245 — the diff reads rows with the same classifier as the summary (ADR 0045 order), so a
  // row the runner says was never judged cannot turn into a regression through its assertions.
  it('a blocked row whose assertions failed is not a regression', () => {
    const blocked: EvalResult = { id: 'a', tags: [], rows: [{ ...row({ fail: true }), inconclusive: 'blocked' }], passed: true };
    const d = diffRuns(run([ev('a', 'passed')]), run([blocked]));
    expect(d.evals[0]!.current).not.toBe('failed');
    expect(d.summary.hasRegression).toBe(false);
  });
});
