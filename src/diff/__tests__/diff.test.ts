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
});
