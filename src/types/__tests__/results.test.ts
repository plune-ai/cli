import { describe, it, expect } from 'vitest';
import type {
  RunResult,
  EvalResult,
  RowResult,
  AssertionResultRecord,
} from '../results.js';

describe('RunResult shape (AC-02)', () => {
  it('carries every documented field with correct types', () => {
    const assertion: AssertionResultRecord = {
      type: 'llm-judge',
      passed: true,
      score: 0.9,
      reason: 'looks good',
    };

    const row: RowResult = {
      vars: { prompt: 'hello' },
      output: 'world',
      cached: false,
      usage: { input_tokens: 10, output_tokens: 5, cost_usd: 0.001 },
      latency_ms: 42,
      assertions: [assertion],
    };

    const evalResult: EvalResult = {
      id: 'eval-1',
      tags: ['smoke'],
      rows: [row],
      passed: true,
    };

    const result: RunResult = {
      schemaVersion: 1,
      plune_version: '0.1.0',
      started_at: '2026-01-01T00:00:00.000Z',
      finished_at: '2026-01-01T00:01:00.000Z',
      config_hash: 'deadbeef',
      summary: {
        total: 1,
        passed: 1,
        failed: 0,
        errored: 0,
        cost_usd: 0.001,
        duration_ms: 1000,
      },
      evals: [evalResult],
    };

    expect(result.schemaVersion).toBe(1);
    expect(result.plune_version).toBe('0.1.0');
    expect(result.started_at).toBe('2026-01-01T00:00:00.000Z');
    expect(result.finished_at).toBe('2026-01-01T00:01:00.000Z');
    expect(result.config_hash).toBe('deadbeef');
    expect(result.summary.total).toBe(1);
    expect(result.summary.passed).toBe(1);
    expect(result.summary.failed).toBe(0);
    expect(result.summary.errored).toBe(0);
    expect(result.summary.cost_usd).toBe(0.001);
    expect(result.summary.duration_ms).toBe(1000);
    expect(result.evals).toHaveLength(1);
  });

  it('allows RowResult with errored fields absent (optional fields)', () => {
    const row: RowResult = {
      vars: {},
      output: null,
      cached: false,
      assertions: [],
    };
    expect(row.output).toBeNull();
    expect(row.usage).toBeUndefined();
    expect(row.latency_ms).toBeUndefined();
    expect(row.error).toBeUndefined();
  });

  it('allows AssertionResultRecord with optional fields absent', () => {
    const a: AssertionResultRecord = { type: 'exact-match', passed: false };
    expect(a.score).toBeUndefined();
    expect(a.reason).toBeUndefined();
  });
});
