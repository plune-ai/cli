// Only attempts with a verdict are in a share; the rest is counted and named, and a dry run is not compared.

import { describe, expect, it } from 'vitest';
import { adviceFor } from '../advice.js';
import type { AgentRecord, EvalResult, RowResult, RunResult } from '../../types/results.js';

const POP = { rows: 1, rows_hash: 'r', assertions_hash: 'a', model: 'p/m' };

/** One row of `runs` attempts: `passed` passed, `failed` failed, the rest errored (a timeout). */
function repeated(passed: number, failed: number, runs: number, agent?: AgentRecord): RowResult {
  return {
    vars: {},
    output: 'x',
    cached: false,
    assertions: [{ type: 'exact-match', passed: true }],
    attempts: {
      runs,
      pass_threshold: 0.1,
      passed,
      failed,
      errored: runs - passed - failed,
      results: [],
    },
    ...(agent !== undefined ? { agent } : {}),
  };
}
const ev = (row: RowResult, runs = 10): EvalResult => ({
  id: 'e',
  tags: [],
  passed: true,
  rows: [row],
  measured: { ...POP, runs },
});
const run = (evals: EvalResult[], extra: Partial<RunResult> = {}): RunResult => ({
  schemaVersion: 1,
  plune_version: '0',
  started_at: '',
  finished_at: '',
  config_hash: '',
  summary: { total: 1, passed: 1, failed: 0, errored: 0, cost_usd: 0, duration_ms: 0 },
  evals,
  ...extra,
});
const agent = (swap?: { tool: string; sha256: string }[]): AgentRecord => ({
  server: 'fx',
  tools: [],
  steps: [],
  stop: { reason: 'complete' },
  collection: 'complete',
  ...(swap !== undefined ? { description_overrides: swap } : {}),
});

describe('CLI · diff · advice · only attempts with a verdict are counted', () => {
  it('CLI · diff · advice · a dry run is not compared, on either side, and the line says why', () => {
    const dry: RowResult = { ...repeated(0, 0, 10), inconclusive: 'skipped', output: null };
    const dryRun = run([ev(dry)], { dry_run: true });
    for (const [b, c] of [
      [run([ev(repeated(9, 1, 10))]), dryRun],
      [dryRun, run([ev(repeated(9, 1, 10))])],
    ] as const) {
      const a = adviceFor(b, c)!;
      expect(a.evals[0]!.comparison).toBeUndefined();
      expect(a.evals[0]!.unavailable!.join(' ')).toContain(
        'not compared: a dry run measures nothing',
      );
      expect(a.overall.comparison).toBeUndefined();
      expect(a.overall.unavailable!.join(' ')).toContain('a dry run measures nothing');
    }
  });

  it('CLI · diff · advice · 4 passed and 6 errored against 9/10 is not "worse": the 6 are not measured, and the line says so', () => {
    const a = adviceFor(run([ev(repeated(9, 1, 10))]), run([ev(repeated(4, 0, 10))]))!;
    const c = a.evals[0]!.comparison!;
    expect(c.word).toBe('too-few');
    expect(c.reason).toContain('not measured');
    expect(c.reason).toMatch(/current 6/);
    expect(a.overall.comparison!.word).not.toBe('worse');
  });

  it('CLI · diff · advice · with enough attempts left, errored ones still stay out of the share (40 of 40 against 90 of 100)', () => {
    const a = adviceFor(
      run([ev(repeated(90, 10, 100), 100)]),
      run([ev(repeated(40, 0, 100), 100)]),
    )!;
    const c = a.evals[0]!.comparison!;
    expect(c.word).not.toBe('worse');
    expect(c.current).toBe(40);
    expect(c.reason).toMatch(/not measured.*current 60/);
  });

  it('CLI · diff · advice · a plain row that errored, was blocked or skipped is not an attempt', () => {
    const mk = (status: 'passed' | 'failed' | 'errored' | 'blocked'): RowResult => ({
      vars: {},
      output: 'x',
      cached: false,
      assertions: [{ type: 'exact-match', passed: status === 'passed' }],
      ...(status === 'errored' ? { error: { code: 'X', message: 'm' } } : {}),
      ...(status === 'blocked' ? { inconclusive: 'blocked' as const } : {}),
    });
    const e = (rows: RowResult[]): EvalResult => ({
      id: 'e',
      tags: [],
      passed: true,
      rows,
      measured: { ...POP, rows: rows.length, runs: 1 },
    });
    // Repeats on one side only: nothing to compare, so no advice for the eval.
    const base = run([ev({ ...repeated(5, 0, 5) }, 5)]);
    const cur = run([
      e([
        mk('passed'),
        mk('passed'),
        mk('passed'),
        mk('passed'),
        mk('passed'),
        mk('errored'),
        mk('blocked'),
      ]),
    ]);
    expect(adviceFor(base, cur)).toBeUndefined();
  });
});

describe('CLI · diff · advice · the tool descriptions differed', () => {
  const SWAP = [{ tool: 'search', sha256: 'a'.repeat(64) }];
  it('CLI · diff · advice · the pass-rate lines say so when the descriptions differed between the runs', () => {
    const a = adviceFor(
      run([ev(repeated(9, 1, 10, agent()))]),
      run([ev(repeated(3, 7, 10, agent(SWAP)))]),
    )!;
    expect(a.evals[0]!.descriptionsDiffer).toBe(true);
    expect(a.overall.descriptionsDiffer).toBe(true);
  });
  it('CLI · diff · advice · and not when they did not', () => {
    const a = adviceFor(
      run([ev(repeated(9, 1, 10, agent(SWAP)))]),
      run([ev(repeated(3, 7, 10, agent(SWAP)))]),
    )!;
    expect(a.evals[0]!.descriptionsDiffer).toBeFalsy();
    expect(a.overall.descriptionsDiffer).toBeFalsy();
  });
});
