import { describe, expect, it } from 'vitest';
import { diffRuns } from '../../diff/diff.js';
import { COMMENT_BUDGET, renderDiff, renderDiffMarkdown, STICKY_MARKER } from '../diff.js';
import type { EvalResult, RunResult } from '../../types/results.js';

const SECRET = 'sk-or-v1-TOPSECRET-DO-NOT-LEAK';
const MODELS = [
  { type: 'anthropic', model: 'm-a' },
  { type: 'openai', model: 'm-b' },
];

function cell(base: string, model: (typeof MODELS)[number], ok: boolean): EvalResult {
  return {
    id: `${base}@${model.model}`,
    tags: [],
    passed: ok,
    provider: model,
    rows: [{ vars: {}, output: `out ${SECRET}`, cached: false, assertions: [{ type: 'exact-match', passed: ok }] }],
  };
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
/** Every eval on every model; `fails` lists the `<eval>@<model>` ids that fail. */
function grid(ids: string[], fails: string[] = []): RunResult {
  return run(ids.flatMap((id) => MODELS.map((m) => cell(id, m, !fails.includes(`${id}@${m.model}`)))));
}

describe('CLI · diff · model matrix · cells compare like evals', () => {
  it('a cell that passed and now fails is a regression of that cell only', () => {
    const d = diffRuns(grid(['x', 'y']), grid(['x', 'y'], ['y@m-b']));
    expect(d.summary).toMatchObject({ regressions: 1, stablePasses: 3, hasRegression: true });
    expect(d.evals.find((e) => e.status === 'regression')).toMatchObject({ id: 'y@m-b', eval: 'y', provider: MODELS[1] });
  });

  it('JSON carries the matrix: evals in config order, models in config order', () => {
    const d = diffRuns(grid(['x', 'y']), grid(['x', 'y'], ['y@m-b']));
    expect(d.matrix!.models).toEqual(MODELS);
    expect(d.matrix!.rows.map((r) => r.eval)).toEqual(['x', 'y']);
    expect(d.matrix!.rows[1]!.cells.map((c) => c?.status)).toEqual(['stable-pass', 'regression']);
    expect(JSON.parse(renderDiff(d, 'json')).matrix.rows[1].cells[1]).toMatchObject({ id: 'y@m-b', status: 'regression' });
  });

  it('a single-model diff has no matrix and no extra fields', () => {
    const one = (ok: boolean) => run([{ id: 'x', tags: [], passed: ok, rows: [{ vars: {}, output: '', cached: false, assertions: [{ type: 'exact-match', passed: ok }] }] }]);
    const d = diffRuns(one(true), one(false));
    expect(d).not.toHaveProperty('matrix');
    expect(d.evals[0]).toEqual({ id: 'x', status: 'regression', baseline: 'passed', current: 'failed' });
  });

  it('a cell the current run lacks is removed, and a new one is new-pass', () => {
    const d = diffRuns(grid(['x']), run([cell('x', MODELS[0], true), cell('z', MODELS[0], true)]));
    expect(d.evals.map((e) => [e.id, e.status])).toEqual([
      ['x@m-a', 'stable-pass'],
      ['x@m-b', 'removed'],
      ['z@m-a', 'new-pass'],
    ]);
    expect(d.matrix!.rows.find((r) => r.eval === 'z')!.cells).toEqual([expect.objectContaining({ status: 'new-pass' }), null]);
  });
});

describe('CLI · diff · model matrix · markdown', () => {
  it('shows a matrix of the changed and failing cells; stable passes collapse into one counted line', () => {
    const d = diffRuns(grid(['x', 'y', 'z'], ['z@m-a']), grid(['x', 'y', 'z'], ['y@m-b', 'z@m-a']));
    const md = renderDiffMarkdown(d);
    expect(md.startsWith(STICKY_MARKER)).toBe(true);
    expect(md).toContain('| Eval | m-a | m-b |');
    expect(md).toMatch(/\| y \| ✅ \| 🔴 regression/);
    expect(md).toMatch(/\| z \| ⚪ pre-existing fail \| ✅ \|/);
    expect(md).not.toMatch(/\| x \|/);
    expect(md).toContain('4 stable passes not listed');
  });

  it('with nothing but stable passes there is no table, only the count line', () => {
    const md = renderDiffMarkdown(diffRuns(grid(['x']), grid(['x'])));
    expect(md).not.toContain('| Eval |');
    expect(md).toContain('2 stable passes not listed');
  });

  it('never carries row output or an environment secret', () => {
    process.env['OPENROUTER_API_KEY'] = SECRET;
    try {
      const d = diffRuns(grid(['x']), grid(['x'], ['x@m-a']));
      for (const f of ['console', 'json', 'markdown'] as const) expect(renderDiff(d, f)).not.toContain(SECRET);
    } finally {
      delete process.env['OPENROUTER_API_KEY'];
    }
  });
});

describe('CLI · diff · model matrix · the comment budget', () => {
  const ids = Array.from({ length: 60 }, (_, i) => `eval-${String(i).padStart(2, '0')}`);
  // Every eval fails on both models now; the first one regressed on m-a, the last only improved on m-b.
  const base = grid(ids, ids.flatMap((i) => [`${i}@m-a`, `${i}@m-b`]).filter((c) => c !== 'eval-00@m-a'));
  const cur = grid(ids, ids.flatMap((i) => [`${i}@m-a`, `${i}@m-b`]));
  const d = diffRuns(base, cur);

  it('the budget is below the 65 536 characters of a comment (not confirmed by documentation)', () => {
    expect(COMMENT_BUDGET).toBeLessThan(65_536);
  });

  it('cuts whole table rows, keeps the marker first and ends with the count of cells left out', () => {
    const md = renderDiffMarkdown(d, 3000);
    expect(md.length).toBeLessThanOrEqual(3000);
    expect(md.startsWith(STICKY_MARKER)).toBe(true);
    const table = md.split('\n').filter((l) => l.startsWith('| eval-'));
    expect(table.length).toBeGreaterThan(0);
    expect(table.length).toBeLessThan(60);
    for (const row of table) expect(row.endsWith('|')).toBe(true);
    const left = md.match(/_(\d+) more cells in the job summary_/);
    expect(left).not.toBeNull();
    const shownCells = table.join('\n').match(/pre-existing fail|regression|improvement/g)!.length;
    expect(shownCells + Number(left![1])).toBe(120 - 1 + 1);
  });

  it('keeps the most important rows: the regression survives the cut though it is the last row', () => {
    const everyA = ids.map((i) => `${i}@m-a`);
    const regressed = diffRuns(grid(ids, everyA), grid(ids, [...everyA, 'eval-59@m-b']));
    const md = renderDiffMarkdown(regressed, 2500);
    expect(md).toMatch(/\| eval-59 \|.*🔴 regression/);
    expect(md).toContain('more cells in the job summary');
  });

  it('under the budget nothing is cut and no count line appears', () => {
    const md = renderDiffMarkdown(d);
    expect(md).not.toContain('more cell');
    expect(md.length).toBeLessThanOrEqual(COMMENT_BUDGET);
  });
});
