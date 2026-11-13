// Markdown reporter (ADR-RP02). A summary table + a Failures section, suitable for PR comments.
// Failure output goes in a code fence sized longer than any backtick run inside it (so embedded
// fences don't break the document). Plain text — never colored.

import type { RunResult, RowResult } from '../types/results.js';
import { adviceOf, rowStatus } from '../types/results.js';
import { repeatsText, safeLine, truncate } from './helpers.js';

const DEFAULT_MAX_OUTPUT = 500;
const TICK = String.fromCharCode(96); // backtick

export interface MarkdownOptions {
  maxOutputChars?: number;
}

/** Wrap content in a backtick fence longer than any backtick run inside it. */
function fence(content: string): string {
  const runs = content.match(new RegExp(TICK + '+', 'g'));
  const longest = runs ? runs.reduce((m, r) => Math.max(m, r.length), 0) : 0;
  const bar = TICK.repeat(Math.max(3, longest + 1));
  return `${bar}\n${content}\n${bar}`;
}

export function renderMarkdown(result: RunResult, opts: MarkdownOptions = {}): string {
  const maxOut = opts.maxOutputChars ?? DEFAULT_MAX_OUTPUT;
  const { summary } = result;
  const out: string[] = [];

  if (result.dry_run === true) {
    // Nothing ran: a price and no verdict, so none of the words of a measured run (plune-ai/cli#244).
    out.push('# Plune dry run');
    out.push('');
    out.push('Nothing was measured: the rows were priced, not run.');
    out.push('');
    out.push('| Metric | Value |');
    out.push('| --- | --- |');
    out.push(`| Rows priced | ${summary.total} |`);
    out.push(`| Estimated cost (USD) | ${summary.cost_usd.toFixed(4)} |`);
    // Only a repeated row is named: its estimate is one run times `runs`.
    const repeated = result.evals.flatMap((ev) =>
      ev.rows.flatMap((row) => {
        const repeats = repeatsText(row);
        return repeats === undefined ? [] : [`- ${ev.id} ${JSON.stringify(row.vars)}: ${repeats}`];
      }),
    );
    if (repeated.length > 0) out.push('', ...repeated);
    return out.join('\n');
  }

  out.push('# Plune run');
  out.push('');
  out.push('| Metric | Value |');
  out.push('| --- | --- |');
  out.push(`| Total | ${summary.total} |`);
  out.push(`| Passed | ${summary.passed} |`);
  out.push(`| Failed | ${summary.failed} |`);
  out.push(`| Errored | ${summary.errored} |`);
  // plune#1245: only when not zero, so a report without them reads as it always has.
  if ((summary.blocked ?? 0) > 0) out.push(`| Blocked | ${summary.blocked} |`);
  if ((summary.skipped ?? 0) > 0) out.push(`| Skipped | ${summary.skipped} |`);
  out.push(`| Cost (USD) | ${summary.cost_usd.toFixed(4)} |`);
  out.push(`| Duration (ms) | ${summary.duration_ms} |`);
  out.push('');

  // Only when some eval repeats its rows (`runs` above 1), so a report without repeats is unchanged.
  const repeated = result.evals.flatMap((ev) =>
    ev.rows.flatMap((row) =>
      row.attempts !== undefined ? [{ id: ev.id, row, a: row.attempts }] : [],
    ),
  );
  if (repeated.length > 0) {
    out.push('## Repeats');
    out.push('');
    out.push('| Eval | Vars | Passed | pass_threshold | Status |');
    out.push('| --- | --- | --- | --- | --- |');
    for (const { id, row, a } of repeated) {
      const vars = JSON.stringify(row.vars).replace(/\|/g, '\\|');
      const passed = a.results.length === 0 ? `dry run × ${a.runs}` : `${a.passed}/${a.runs}`;
      out.push(`| ${id} | ${vars} | ${passed} | ${a.pass_threshold} | ${rowStatus(row)} |`);
    }
    out.push('');
  }

  // Heuristic findings of agentic rows: advice, not failures. Only when there is some.
  const advice = result.evals.flatMap((ev) =>
    ev.rows.flatMap((row) => adviceOf(row).map((a) => ({ id: ev.id, row, a }))),
  );
  if (advice.length > 0) {
    out.push('## Advice');
    out.push('');
    out.push('Heuristic findings: they do not change any status.');
    out.push('');
    for (const { id, row, a } of advice)
      out.push(`- ${id} ${JSON.stringify(row.vars)}: ${safeLine(a.type)}: ${safeLine(a.reason)}`);
    out.push('');
  }

  // A blocked or skipped row is neither a failure nor a pass: the table counts it, this list does not.
  const failures: { id: string; row: RowResult; state: 'failed' | 'errored' }[] = [];
  let allPassed = true;
  for (const ev of result.evals) {
    for (const row of ev.rows) {
      const state = rowStatus(row);
      if (state !== 'passed') allPassed = false;
      if (state === 'failed' || state === 'errored') failures.push({ id: ev.id, row, state });
    }
  }

  if (failures.length === 0) {
    if (allPassed) out.push('All evals passed.');
    return out.join('\n');
  }

  out.push('## Failures');
  out.push('');
  for (const f of failures) {
    out.push(`### ${f.id} — ${f.state}`);
    out.push(`- vars: ${JSON.stringify(f.row.vars)}`);
    if (f.row.error !== undefined) {
      out.push(`- error: ${f.row.error.message}`);
    } else {
      for (const a of f.row.assertions) {
        if (a.passed) continue;
        const reasonTxt = a.reason !== undefined ? ` — ${a.reason}` : '';
        const scoreTxt = a.score !== undefined ? ` (score ${a.score})` : '';
        out.push(`- ${a.type}${reasonTxt}${scoreTxt}`);
      }
      if (f.row.output !== null) {
        out.push('');
        out.push(fence(truncate(f.row.output, maxOut)));
      }
    }
    out.push('');
  }
  return out.join('\n');
}
