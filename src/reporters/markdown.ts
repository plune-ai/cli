// Markdown reporter (ADR-RP02). A summary table + a Failures section, suitable for PR comments.
// Failure output goes in a code fence sized longer than any backtick run inside it (so embedded
// fences don't break the document). Plain text — never colored.

import type { RunResult, RowResult } from '../types/results.js';
import { rowStatus } from '../types/results.js';
import { truncate } from './helpers.js';

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
