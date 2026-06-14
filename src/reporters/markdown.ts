// Markdown reporter (ADR-RP02). A summary table + a Failures section, suitable for PR comments.
// Failure output goes in a code fence sized longer than any backtick run inside it (so embedded
// fences don't break the document). Plain text — never colored.

import type { RunResult, RowResult } from '../types/results.js';
import { truncate } from './helpers.js';

const DEFAULT_MAX_OUTPUT = 500;
const TICK = String.fromCharCode(96); // backtick

export interface MarkdownOptions {
  maxOutputChars?: number;
}

function classify(row: RowResult): 'passed' | 'failed' | 'errored' {
  if (row.error !== undefined) return 'errored';
  if (row.assertions.some((a) => !a.passed)) return 'failed';
  return 'passed';
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
  out.push(`| Cost (USD) | ${summary.cost_usd.toFixed(4)} |`);
  out.push(`| Duration (ms) | ${summary.duration_ms} |`);
  out.push('');

  const failures: { id: string; row: RowResult; state: 'failed' | 'errored' }[] = [];
  for (const ev of result.evals) {
    for (const row of ev.rows) {
      const state = classify(row);
      if (state !== 'passed') failures.push({ id: ev.id, row, state });
    }
  }

  if (failures.length === 0) {
    out.push('All evals passed.');
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
