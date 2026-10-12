import { describe, expect, it } from 'vitest';
import { exitCodeFor } from '../exit-code.js';
import type { RunResult } from '../../types/results.js';

function result(passed: number, failed: number, errored: number): RunResult {
  return {
    schemaVersion: 1,
    plune_version: '0',
    started_at: '',
    finished_at: '',
    config_hash: '',
    summary: { total: passed + failed + errored, passed, failed, errored, cost_usd: 0, duration_ms: 0 },
    evals: [],
  };
}

describe('exitCodeFor (AC-10)', () => {
  it('returns 0 when all pass', () => {
    expect(exitCodeFor(result(3, 0, 0))).toBe(0);
  });
  it('returns 1 when any assertion failed', () => {
    expect(exitCodeFor(result(2, 1, 0))).toBe(1);
  });
  it('prioritizes 1 (failed) over 2 (errored) when both present', () => {
    expect(exitCodeFor(result(1, 1, 1))).toBe(1);
  });
  it('returns 2 when errored without any failed (infra, not a quality regression)', () => {
    expect(exitCodeFor(result(2, 0, 1))).toBe(2);
  });
  // plune#1245. ADR 0045 does not say what a row that was never judged means for the exit code, so
  // today's rule stands: only failed (1) and errored (2) move it. Open question on the issue.
  it('returns 0 when the only rows not passed are blocked or skipped', () => {
    const r = result(1, 0, 0);
    r.summary = { ...r.summary, total: 3, blocked: 1, skipped: 1 };
    expect(exitCodeFor(r)).toBe(0);
  });
});
