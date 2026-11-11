import { describe, expect, it } from 'vitest';
import { renderConsole } from '../console.js';
import { renderMarkdown } from '../markdown.js';
import { parseRunResult } from '../../types/run-result-schema.js';
import type { RowResult, RunResult } from '../../types/results.js';

function attempt(passed: boolean): NonNullable<RowResult['attempts']>['results'][number] {
  return {
    output: passed ? 'yes' : 'no',
    cached: false,
    usage: { input_tokens: 1, output_tokens: 1, cost_usd: 0.001 },
    latency_ms: 1,
    assertions: [{ type: 'exact-match', passed }],
  };
}

const sevenOfTen: RunResult = {
  schemaVersion: 1,
  plune_version: '0.1.0',
  started_at: '2026-06-11T09:00:00.000Z',
  finished_at: '2026-06-11T09:00:05.000Z',
  config_hash: 'c'.repeat(64),
  summary: { total: 2, passed: 1, failed: 1, errored: 0, cost_usd: 0.02, duration_ms: 10 },
  evals: [
    {
      id: 'flaky',
      tags: [],
      passed: false,
      rows: [
        {
          vars: { q: 'a' },
          output: 'yes',
          cached: false,
          usage: { input_tokens: 10, output_tokens: 10, cost_usd: 0.01 },
          latency_ms: 10,
          assertions: [{ type: 'exact-match', passed: true }],
          attempts: {
            runs: 10,
            pass_threshold: 0.7,
            passed: 7,
            failed: 3,
            errored: 0,
            results: [...Array(7).fill(attempt(true)), ...Array(3).fill(attempt(false))],
          },
        },
        {
          vars: { q: 'b' },
          output: 'no',
          cached: false,
          usage: { input_tokens: 10, output_tokens: 10, cost_usd: 0.01 },
          latency_ms: 10,
          assertions: [{ type: 'exact-match', passed: false }],
          attempts: {
            runs: 10,
            pass_threshold: 0.7,
            passed: 6,
            failed: 4,
            errored: 0,
            results: [...Array(6).fill(attempt(true)), ...Array(4).fill(attempt(false))],
          },
        },
      ],
    },
  ],
};

describe('CLI · run · repeats · reports', () => {
  it('the console shows passed attempts out of runs and the verdict for every repeated row', () => {
    const out = renderConsole(sevenOfTen);
    expect(out).toContain('7/10 passed (pass_threshold 0.7): passed');
    expect(out).toContain('6/10 passed (pass_threshold 0.7): failed');
    expect(out).toContain('{"q":"a"}');
  });

  it('markdown shows a repeats table', () => {
    const out = renderMarkdown(sevenOfTen);
    expect(out).toContain('## Repeats');
    expect(out).toContain('| flaky | {"q":"a"} | 7/10 | 0.7 | passed |');
    expect(out).toContain('| flaky | {"q":"b"} | 6/10 | 0.7 | failed |');
  });

  it('the published schema keeps attempts instead of dropping them', () => {
    const parsed = parseRunResult(sevenOfTen);
    expect(parsed.evals[0]!.rows[0]!.attempts).toEqual(sevenOfTen.evals[0]!.rows[0]!.attempts);
    expect(() =>
      parseRunResult({
        ...sevenOfTen,
        evals: [
          {
            ...sevenOfTen.evals[0]!,
            rows: [{ ...sevenOfTen.evals[0]!.rows[0]!, attempts: { runs: 'ten' } }],
          },
        ],
      }),
    ).toThrow();
  });
});
