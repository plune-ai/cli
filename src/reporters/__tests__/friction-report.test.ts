import { describe, expect, it } from 'vitest';
import { renderConsole } from '../console.js';
import { renderMarkdown } from '../markdown.js';
import { exitCodeFor } from '../../orchestrator/exit-code.js';
import { parseRunResult } from '../../types/run-result-schema.js';
import type { RunResult } from '../../types/results.js';

// Friction signals ride on the row as advice: the row is judged by its assertions only, and says so in every format.
const SIGNALS = [
  {
    type: 'identical-retry',
    tool: 'search',
    steps: [1, 2],
    count: 1,
    reason:
      'search was called again 1 time(s) with the same arguments right after itself (steps 1, 2); this may be fine if the first call failed',
  },
  {
    type: 'pagination-continuation',
    tool: 'list',
    steps: [2, 3],
    count: 1,
    reason:
      'list continued through a list with a new page or cursor 1 time(s) (steps 2, 3); this is not a repeat',
  },
  {
    type: 'search-after-id',
    tool: 'search',
    steps: [1, 4],
    count: 1,
    paths: ['items[].id'],
    reason:
      'search was called again after an earlier step had already returned identifiers (at items[].id; steps 1, 4); this may be fine',
  },
  {
    type: 'friction-unmeasured',
    tool: 'search',
    steps: [1, 4],
    count: 1,
    reason:
      'search: not measured, the answer is not JSON, so identifiers were not looked for (steps 1, 4); this is not the same as finding none',
  },
];

const run = (passed: boolean): RunResult => ({
  schemaVersion: 1,
  plune_version: '0',
  started_at: '2026-11-13T09:00:00.000Z',
  finished_at: '2026-11-13T09:00:01.000Z',
  config_hash: 'c'.repeat(64),
  summary: {
    total: 1,
    passed: passed ? 1 : 0,
    failed: passed ? 0 : 1,
    errored: 0,
    cost_usd: 0,
    duration_ms: 1,
  },
  evals: [
    {
      id: 'agentic',
      tags: [],
      passed,
      rows: [
        {
          vars: { q: 'a' },
          output: 'done',
          cached: false,
          assertions: [{ type: 'tool-called', passed }],
          agent: {
            server: 'fx',
            tools: [],
            steps: [],
            stop: { reason: 'complete' },
            collection: 'complete',
            advice: SIGNALS,
          },
        },
      ],
    },
  ],
});

describe('CLI · run · friction · in the report of a row', () => {
  it('CLI · run · friction · each signal is named on its row in console and Markdown, and a passing row stays passed with exit 0', () => {
    const r = run(true);
    const text = renderConsole(r);
    const md = renderMarkdown(r);
    for (const s of SIGNALS) {
      expect(text).toContain(`advice ${s.type}: ${s.reason}`);
      expect(md).toContain(`${s.type}: ${s.reason}`);
    }
    expect(text).toContain('PASS agentic');
    expect(md).toContain('All evals passed.');
    expect(exitCodeFor(r)).toBe(0);
  });

  it('CLI · run · friction · a failing row stays failing with exit 1: the signals decide nothing either way', () => {
    const r = run(false);
    expect(renderConsole(r)).toContain('FAIL agentic');
    expect(exitCodeFor(r)).toBe(1);
  });

  it('CLI · run · friction · the RunResult schema keeps tool, steps, count and paths of every signal', () => {
    const kept = parseRunResult(run(true)).evals[0]!.rows[0]!.agent!.advice!;
    expect(kept).toEqual(SIGNALS);
  });
});
