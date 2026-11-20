// Shared presentation helpers for the console/markdown renderers.

import type { RowResult, RunResult } from '../types/results.js';
import { rowStatus } from '../types/results.js';
import { noCommands } from '../mcp-testing/report/human.js';

/**
 * A text that came from a server or a file, as one plain line: line breaks become a space, so it cannot start a
 * heading or a list item of its own, and a leading `::` or `##[` cannot read as a CI workflow command.
 */
export const safeLine = (t: string): string => noCommands(t.replace(/\s*[\r\n]+\s*/g, ' ').trim());

/** `safeLine` for a cell of a Markdown table: a `|` in it does not split the cell. */
export const mdCell = (t: string): string => safeLine(t).replace(/\|/g, '\\|');

/** Shorten `s` to at most `maxChars`, appending a marker when it was cut. */
export function truncate(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars) + '… (truncated)';
}

/**
 * The repeats line of a row whose eval sets `runs` above 1 (`7/10 passed (pass_threshold 0.7): passed · flaky 0.7`),
 * or undefined for a row without repeats, whose report then reads exactly as before.
 */
export function repeatsText(row: RowResult): string | undefined {
  const a = row.attempts;
  if (a === undefined) return undefined;
  if (a.results.length === 0) return `dry run: estimate × ${a.runs} runs`;
  return `${a.passed}/${a.runs} passed (pass_threshold ${a.pass_threshold}): ${rowStatus(row)}${flakyText(a)}`;
}

/**
 * ` · flaky 0.6` for a row that passed some of its runs but not all (the share that passed, at most two
 * decimals), else empty: a row that passed every run, or none, is stable.
 */
export function flakyText(a: { passed: number; runs: number }): string {
  if (a.passed <= 0 || a.passed >= a.runs) return '';
  return ` · flaky ${Number((a.passed / a.runs).toFixed(2))}`;
}

/** The line a measured run without repeats prints once under its summary: one run cannot tell a flaky case. */
export const NOT_MEASURED_STABILITY = 'stability: not measured (runs: 1)';

/** True when no row of the run was repeated (every eval ran with `runs: 1`). */
export const noRepeats = (result: RunResult): boolean =>
  result.evals.every((ev) => ev.rows.every((row) => row.attempts === undefined));
