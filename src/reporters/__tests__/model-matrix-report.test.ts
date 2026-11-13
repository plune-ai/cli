import { describe, expect, it } from 'vitest';
import { renderConsole } from '../console.js';
import { renderMarkdown } from '../markdown.js';
import { buildMatrix } from '../matrix.js';
import type { EvalResult, RowResult, RunResult } from '../../types/results.js';
import { mixed } from './fixtures.js';

const row = (ok: boolean, cost: number, latency: number, extra: Partial<RowResult> = {}): RowResult => ({
  vars: { q: 'a' },
  output: ok ? 'yes' : 'no',
  cached: false,
  usage: { input_tokens: 1, output_tokens: 1, cost_usd: cost },
  latency_ms: latency,
  assertions: [{ type: 'exact-match', passed: ok }],
  ...extra,
});

const repeated = (passed: number, runs: number, latency: number): RowResult => ({
  ...row(passed / runs >= 0.7, 0.01 * runs, latency * runs),
  attempts: {
    runs,
    pass_threshold: 0.7,
    passed,
    failed: runs - passed,
    errored: 0,
    results: Array.from({ length: runs }, (_, i) => ({
      output: 'x',
      cached: false,
      latency_ms: latency,
      usage: { input_tokens: 1, output_tokens: 1, cost_usd: 0.01 },
      assertions: [{ type: 'exact-match', passed: i < passed }],
    })),
  },
});

const cell = (base: string, model: string, rows: RowResult[], passed: boolean, type = 'anthropic'): EvalResult => ({
  id: `${base}@${model}`,
  tags: [],
  rows,
  passed,
  provider: { type, model },
});

function result(evals: EvalResult[], extra: Partial<RunResult> = {}): RunResult {
  return { ...mixed, summary: { ...mixed.summary, total: evals.length, cost_usd: 0.05 }, evals, ...extra };
}

const grid = result([
  cell('greet', 'm-a', [repeated(7, 10, 100)], true),
  cell('greet', 'm-b', [repeated(3, 10, 2000)], false, 'openai'),
  cell('math', 'm-a', [row(true, 0.002, 50), row(true, 0.002, 70), row(true, 0.002, 90)], true),
  cell('math', 'm-b', [row(false, 0.2, 1500)], false, 'openai'),
]);

describe('CLI · report · model matrix · buildMatrix', () => {
  it('rows are evals and columns are models, both in config order', () => {
    const m = buildMatrix(grid)!;
    expect(m.models.map((x) => x.model)).toEqual(['m-a', 'm-b']);
    expect(m.rows.map((r) => r.eval)).toEqual(['greet', 'math']);
  });

  it('a cell has state, pass share, cost and median latency; no repeats counts one run per row', () => {
    const m = buildMatrix(grid)!;
    expect(m.rows[0]!.cells[0]).toMatchObject({ state: 'pass', passed: 7, total: 10, latency_ms: 100 });
    expect(m.rows[0]!.cells[0]!.cost_usd).toBeCloseTo(0.1, 9);
    expect(m.rows[1]!.cells[0]).toMatchObject({ state: 'pass', passed: 3, total: 3, latency_ms: 70 });
    expect(m.rows[1]!.cells[1]).toMatchObject({ state: 'fail', passed: 0, total: 1 });
  });

  it('a cell that was not run (--bail, --only) is null', () => {
    const m = buildMatrix(result([grid.evals[0]!, grid.evals[2]!, grid.evals[3]!]))!;
    expect(m.rows[0]!.cells).toEqual([expect.objectContaining({ state: 'pass' }), null]);
  });

  it('is undefined for a single-model result', () => {
    expect(buildMatrix(mixed)).toBeUndefined();
  });
});

describe('CLI · report · model matrix · console and markdown', () => {
  it('markdown shows a table with a header of models and a dash for an empty cell', () => {
    const md = renderMarkdown(result([grid.evals[0]!, grid.evals[2]!, grid.evals[3]!]));
    expect(md).toContain('## Model matrix');
    expect(md).toContain('| Eval | m-a | m-b |');
    expect(md).toContain('| greet | PASS 7/10 · $0.1000 · 100ms | — |');
    expect(md).toContain('| math | PASS 3/3 · $0.0060 · 70ms | FAIL 0/1 · $0.2000 · 1.5s |');
  });

  it('console shows the same cells, one line per eval', () => {
    const out = renderConsole(grid);
    expect(out).toContain('Model matrix');
    expect(out).toMatch(/greet\s+PASS 7\/10 · \$0\.1000 · 100ms\s+FAIL 3\/10 · \$0\.1000 · 2\.0s/);
  });

  it('a result of one model reads exactly as before', () => {
    expect(renderConsole(mixed)).not.toContain('Model matrix');
    expect(renderMarkdown(mixed)).not.toContain('Model matrix');
  });

  it('an errored cell and an unmeasured one are named, not shown as a pass share only', () => {
    const errored = cell('x', 'm-a', [row(false, 0, 0, { output: null, error: { code: 'E', message: 'down' } })], false);
    const skipped = cell('x', 'm-b', [row(false, 0, 0, { inconclusive: 'skipped', assertions: [] })], false, 'openai');
    const md = renderMarkdown(result([errored, skipped]));
    expect(md).toContain('ERROR');
    expect(md).toContain('NOT MEASURED');
  });

  it('a dry run names the number of models and prices every cell', () => {
    const dry = result(
      grid.evals.map((e) => ({ ...e, passed: false, rows: [{ ...e.rows[0]!, output: null, inconclusive: 'skipped' as const, assertions: [], attempts: undefined }] })),
      { dry_run: true },
    );
    expect(renderConsole(dry)).toContain('across 2 models');
    const md = renderMarkdown(dry);
    expect(md).toContain('| Models | 2 |');
    expect(md).toContain('## Estimated cost per model');
  });

  it('an unrun single-model dry run is unchanged', () => {
    const dry = { ...mixed, dry_run: true as const };
    expect(renderConsole(dry)).not.toContain('across');
    expect(renderMarkdown(dry)).not.toContain('Models');
  });
});
