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

function repeatedRow(q: string, passed: number, runs: number): RowResult {
  return {
    vars: { q },
    output: 'yes',
    cached: false,
    usage: { input_tokens: 10, output_tokens: 10, cost_usd: 0.01 },
    latency_ms: 10,
    assertions: [{ type: 'exact-match', passed: passed > 0 }],
    attempts: {
      runs,
      pass_threshold: 0.6,
      passed,
      failed: runs - passed,
      errored: 0,
      results: [...Array(passed).fill(attempt(true)), ...Array(runs - passed).fill(attempt(false))],
    },
  };
}

const threeOfFive: RunResult = {
  ...sevenOfTen,
  summary: { total: 3, passed: 2, failed: 1, errored: 0, cost_usd: 0.03, duration_ms: 10 },
  evals: [
    {
      id: 'flaky',
      tags: [],
      passed: false,
      rows: [repeatedRow('c', 3, 5), repeatedRow('d', 5, 5), repeatedRow('e', 0, 5)],
    },
  ],
};

describe('CLI · run · repeats · reports', () => {
  it('the console shows passed attempts out of runs and the verdict for every repeated row', () => {
    const out = renderConsole(sevenOfTen);
    expect(out).toContain('7/10 passed (pass_threshold 0.7): passed · flaky 0.7');
    expect(out).toContain('6/10 passed (pass_threshold 0.7): failed · flaky 0.6');
    expect(out).toContain('{"q":"a"}');
  });

  it('markdown shows a repeats table', () => {
    const out = renderMarkdown(sevenOfTen);
    expect(out).toContain('## Repeats');
    expect(out).toContain('| flaky | {"q":"a"} | 7/10 | 0.7 | passed · flaky 0.7 |');
    expect(out).toContain('| flaky | {"q":"b"} | 6/10 | 0.7 | failed · flaky 0.6 |');
  });

  it('a row that passed some of its runs but not all is marked flaky with the share that passed', () => {
    expect(renderConsole(threeOfFive)).toContain(
      '3/5 passed (pass_threshold 0.6): passed · flaky 0.6',
    );
    expect(renderMarkdown(threeOfFive)).toContain(
      '| flaky | {"q":"c"} | 3/5 | 0.6 | passed · flaky 0.6 |',
    );
  });

  it('a row that passed all of its runs, or none, is not marked flaky', () => {
    for (const out of [renderConsole(threeOfFive), renderMarkdown(threeOfFive)]) {
      expect(out).toContain('5/5');
      expect(out).toContain('0/5');
      expect(out.match(/flaky 0/g)).toHaveLength(1);
    }
  });

  it('a run without repeats says once, under the summary, that stability was not measured', () => {
    const noRepeats: RunResult = {
      ...threeOfFive,
      evals: [
        {
          ...threeOfFive.evals[0]!,
          rows: threeOfFive.evals[0]!.rows.map(({ attempts: _a, ...r }) => r),
        },
      ],
    };
    const line = 'stability: not measured (runs: 1)';
    const con = renderConsole(noRepeats).split('\n');
    expect(con.filter((l) => l === line)).toHaveLength(1);
    expect(con.indexOf(line)).toBe(2); // right under the counts line
    const md = renderMarkdown(noRepeats).split('\n');
    expect(md.filter((l) => l === line)).toHaveLength(1);
    expect(md[md.indexOf(line) - 1]).toBe(''); // its own paragraph, not a row of the summary table
    expect(md[md.indexOf(line) - 2]).toMatch(/^\| Duration \(ms\) \|/);
    // With repeats there is no such line.
    expect(renderConsole(threeOfFive)).not.toContain('not measured');
    expect(renderMarkdown(threeOfFive)).not.toContain('not measured');
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
