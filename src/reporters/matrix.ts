// The model x eval matrix of a run that listed several models: one cell per (eval, model) result.
// Pure: it reads a RunResult, so `plune report` draws the same table without running anything.
// Rows are evals and columns are models, both in the order the config lists them.

import type { EvalResult, RunResult } from '../types/results.js';
import { baseEvalId, rowStatus } from '../types/results.js';
import { mdCell, safeLine } from './helpers.js';

export type CellState = 'pass' | 'fail' | 'error' | 'unmeasured';

export interface MatrixCell {
  /** The id of the result this cell shows, `<eval>@<model>`. */
  id: string;
  state: CellState;
  /** Passing runs over runs: one run per row without repeats, `runs` per row with them. */
  passed: number;
  total: number;
  cost_usd: number;
  /** Median over the runs that report one; undefined when none does. */
  latency_ms?: number;
}

export interface Matrix {
  models: { type: string; model: string }[];
  rows: { eval: string; cells: (MatrixCell | null)[] }[];
}

const STATE_ORDER: CellState[] = ['error', 'fail', 'unmeasured', 'pass'];

function median(xs: number[]): number | undefined {
  if (xs.length === 0) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export function cellOf(ev: EvalResult): MatrixCell {
  let passed = 0;
  let total = 0;
  let cost = 0;
  const latencies: number[] = [];
  const states = new Set<CellState>();
  for (const row of ev.rows) {
    const status = rowStatus(row);
    states.add(
      status === 'passed' ? 'pass' : status === 'failed' ? 'fail' : status === 'errored' ? 'error' : 'unmeasured',
    );
    cost += row.usage?.cost_usd ?? 0;
    const a = row.attempts;
    if (a !== undefined && a.results.length > 0) {
      passed += a.passed;
      total += a.runs;
      for (const r of a.results) if (r.latency_ms !== undefined) latencies.push(r.latency_ms);
    } else {
      passed += status === 'passed' ? 1 : 0;
      total += 1;
      if (row.latency_ms !== undefined) latencies.push(row.latency_ms);
    }
  }
  const state = STATE_ORDER.find((s) => states.has(s)) ?? 'pass';
  const latency = median(latencies);
  return {
    id: ev.id,
    state,
    passed,
    total,
    cost_usd: cost,
    ...(latency !== undefined ? { latency_ms: latency } : {}),
  };
}

/** The matrix of a result of several models, or undefined for a result of one (it reads as before). */
export function buildMatrix(result: RunResult): Matrix | undefined {
  if (!result.evals.some((e) => e.provider !== undefined)) return undefined;
  const models: Matrix['models'] = [];
  const rows = new Map<string, (MatrixCell | null)[]>();
  const cells: { eval: string; model: number; cell: MatrixCell }[] = [];
  for (const ev of result.evals) {
    const p = ev.provider ?? { type: '', model: '' };
    let col = models.findIndex((m) => m.model === p.model);
    if (col < 0) col = models.push({ type: p.type, model: p.model }) - 1;
    const id = baseEvalId(ev);
    if (!rows.has(id)) rows.set(id, []);
    cells.push({ eval: id, model: col, cell: cellOf(ev) });
  }
  for (const c of cells) {
    const row = rows.get(c.eval)!;
    while (row.length < models.length) row.push(null);
    row[c.model] = c.cell;
  }
  return {
    models,
    rows: [...rows].map(([id, cs]) => ({
      eval: id,
      cells: Array.from({ length: models.length }, (_, i) => cs[i] ?? null),
    })),
  };
}

export const CELL_LABEL: Record<CellState, string> = {
  pass: 'PASS',
  fail: 'FAIL',
  error: 'ERROR',
  unmeasured: 'NOT MEASURED',
};

export function formatLatency(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export const EMPTY_CELL = '—';

/** `PASS 7/10 · $0.0123 · 1.2s`; a dry run has only the price, and a cell never run is a dash. */
export function cellText(cell: MatrixCell | null, dry = false): string {
  if (cell === null) return EMPTY_CELL;
  const cost = `$${cell.cost_usd.toFixed(4)}`;
  if (dry) return cost;
  const head = cell.state === 'unmeasured' ? CELL_LABEL.unmeasured : `${CELL_LABEL[cell.state]} ${cell.passed}/${cell.total}`;
  return [head, cost, ...(cell.latency_ms !== undefined ? [formatLatency(cell.latency_ms)] : [])].join(' · ');
}

/** Markdown table lines of the matrix (no heading). A model or eval name is one plain line: it is text of the config. */
export function matrixMarkdown(m: Matrix, dry = false): string[] {
  return [
    `| Eval | ${m.models.map((x) => mdCell(x.model)).join(' | ')} |`,
    `| --- | ${m.models.map(() => '---').join(' | ')} |`,
    ...m.rows.map((r) => `| ${mdCell(r.eval)} | ${r.cells.map((c) => cellText(c, dry)).join(' | ')} |`),
  ];
}

/** Plain-text lines of the matrix, columns aligned. */
export function matrixConsole(m: Matrix, dry = false): string[] {
  const table = [['Eval', ...m.models.map((x) => safeLine(x.model))], ...m.rows.map((r) => [safeLine(r.eval), ...r.cells.map((c) => cellText(c, dry))])];
  const widths = table[0]!.map((_, i) => Math.max(...table.map((row) => [...row[i]!].length)));
  return table.map((row) =>
    row
      .map((c, i) => c + ' '.repeat(widths[i]! - [...c].length))
      .join('  ')
      .trimEnd(),
  );
}
