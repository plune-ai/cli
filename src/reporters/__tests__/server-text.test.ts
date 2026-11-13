// Names and texts that come from a server must stay on their own line and never read as a workflow command or a heading.

import { describe, expect, it } from 'vitest';
import { renderConsole } from '../console.js';
import { renderMarkdown } from '../markdown.js';
import { renderDiff } from '../diff.js';
import { adviceFor } from '../../diff/advice.js';
import { diffRuns } from '../../diff/diff.js';
import type { AgentRecord, EvalResult, RowResult, RunResult } from '../../types/results.js';

const EVIL = ['search\n### x', 'a\n::error::boom', '::error::start'];

const lines = (t: string) => t.split('\n');
const bad = (t: string) => lines(t).filter((l) => /^\s*(::|### x)/.test(l));

function agent(extra: Partial<AgentRecord>): AgentRecord {
  return {
    server: 'fx',
    tools: [],
    steps: [],
    stop: { reason: 'complete' },
    collection: 'complete',
    ...extra,
  };
}
const result = (row: RowResult): RunResult => ({
  schemaVersion: 1,
  plune_version: '0',
  started_at: '',
  finished_at: '',
  config_hash: '',
  summary: { total: 1, passed: 1, failed: 0, errored: 0, cost_usd: 0, duration_ms: 0 },
  evals: [{ id: 'e', tags: [], passed: true, rows: [row] }],
});

describe('CLI · run · friction · text from a server in the report of a row', () => {
  for (const evil of EVIL) {
    it(`CLI · run · friction · ${JSON.stringify(evil)} in an advice reason cannot start a command or a heading`, () => {
      const row: RowResult = {
        vars: {},
        output: 'x',
        cached: false,
        assertions: [{ type: 'tool-called', passed: true }],
        agent: agent({
          advice: [
            { type: 'identical-retry', tool: evil, reason: `${evil} was called again\n${evil}` },
          ],
        }),
      };
      expect(bad(renderConsole(result(row)))).toEqual([]);
      expect(bad(renderMarkdown(result(row)))).toEqual([]);
      expect(renderConsole(result(row))).toContain('identical-retry');
    });
  }
});

function repeated(swap: string, first: string): EvalResult {
  const row: RowResult = {
    vars: {},
    output: 'x',
    cached: false,
    assertions: [{ type: 'exact-match', passed: true }],
    attempts: {
      runs: 10,
      pass_threshold: 0.1,
      passed: 9,
      failed: 1,
      errored: 0,
      results: Array.from({ length: 10 }, () => ({
        output: 'x',
        cached: false,
        assertions: [{ type: 'first-tool', passed: true }],
      })),
    },
    agent: agent({
      description_overrides: [{ tool: swap, sha256: 'a'.repeat(64) }],
      steps: [
        {
          index: 1,
          text: '',
          usage: { input_tokens: 0, output_tokens: 0, cost_usd: 0 },
          calls: [{ id: 'c', name: first, args: {}, executed: true, is_error: false }],
        },
      ],
    }),
  };
  return {
    id: 'e',
    tags: [],
    passed: true,
    rows: [row],
    measured: { runs: 10, rows: 1, rows_hash: 'r', assertions_hash: 'a', model: 'p/m' },
  };
}
const run = (e: EvalResult): RunResult => ({ ...result(e.rows[0]!), evals: [e] });

describe('CLI · diff · advice · text from a server in the report of a diff', () => {
  for (const evil of EVIL) {
    it(`CLI · diff · advice · ${JSON.stringify(evil)} as a tool name stays on one line in every format`, () => {
      const base = run(repeated('other', 'list'));
      const cur = run(repeated(evil, evil));
      const advice = adviceFor(base, cur)!;
      expect(advice.experiment).toBeDefined();
      const d = { ...diffRuns(base, cur), advice };
      for (const fmt of ['console', 'markdown'] as const) {
        const text = renderDiff(d, fmt);
        expect(bad(text), fmt).toEqual([]);
        expect(text).toContain('Experiment with descriptions');
      }
    });
  }

  it('CLI · diff · advice · the pass-rate line says that the descriptions differed', () => {
    const base = run(repeated('other', 'list'));
    const cur = run(repeated('search', 'search'));
    const d = { ...diffRuns(base, cur), advice: adviceFor(base, cur)! };
    for (const fmt of ['console', 'markdown'] as const)
      expect(renderDiff(d, fmt), fmt).toMatch(
        /descriptions of the tools differed between the runs/,
      );
  });
});
