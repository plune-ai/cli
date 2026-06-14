// Diff reporter (ADR-GA03; mirrors ADR-RP02 pure-renderers). Renders a RunDiff to
// console | json | markdown. The markdown form is the PR-comment body: it leads with a hidden
// sticky marker so the Action can find-and-update a single comment (AC-3.2). It carries only eval
// ids + statuses — no row outputs, no secrets (AC-5.3). Pure; never colored.

import type { RunDiff, EvalDiffStatus } from '../diff/diff.js';

export const STICKY_MARKER = '<!-- plune-eval-diff -->';
export type DiffFormat = 'console' | 'json' | 'markdown';

const BADGE: Record<EvalDiffStatus, string> = {
  regression: '🔴 regression',
  improvement: '🟢 improvement',
  'pre-existing-fail': '⚪ pre-existing fail',
  'new-fail': '🆕 new fail',
  'new-pass': '🟢 new pass',
  'stable-pass': '✅ stable',
  errored: '⚠️ errored',
  removed: '➖ removed',
};

function summaryLine(d: RunDiff): string {
  const s = d.summary;
  return [
    `${s.regressions} regression(s)`,
    `${s.improvements} improvement(s)`,
    `${s.newFails} new-fail`,
    `${s.preExistingFails} pre-existing-fail`,
    `${s.errored} errored`,
    `${s.removed} removed`,
    `${s.stablePasses} stable`,
  ].join(' · ');
}

export function renderDiffMarkdown(d: RunDiff): string {
  const out: string[] = [STICKY_MARKER, '## Plune eval diff', ''];
  out.push(
    d.summary.hasRegression
      ? `### ❌ ${d.summary.regressions} regression(s)`
      : '### ✅ No regressions',
  );
  out.push('');

  // Stable passes are summarized, not listed — only changes are worth a row.
  const notable = d.evals.filter((e) => e.status !== 'stable-pass');
  if (notable.length > 0) {
    out.push('| Eval | Baseline → Current | Change |');
    out.push('| --- | --- | --- |');
    for (const e of notable) {
      out.push(`| ${e.id} | ${e.baseline} → ${e.current} | ${BADGE[e.status]} |`);
    }
    out.push('');
  }
  out.push(`_${summaryLine(d)}_`);
  return out.join('\n');
}

function renderDiffConsole(d: RunDiff): string {
  const out: string[] = [
    d.summary.hasRegression
      ? `Plune eval diff: ${d.summary.regressions} regression(s)`
      : 'Plune eval diff: no regressions',
  ];
  for (const e of d.evals) {
    if (e.status === 'stable-pass') continue;
    out.push(`  ${e.id}: ${e.baseline} -> ${e.current} [${e.status}]`);
  }
  out.push(summaryLine(d));
  return out.join('\n');
}

function renderDiffJson(d: RunDiff): string {
  return JSON.stringify(d, null, 2);
}

export function renderDiff(d: RunDiff, format: DiffFormat = 'console'): string {
  if (format === 'json') return renderDiffJson(d);
  if (format === 'markdown') return renderDiffMarkdown(d);
  return renderDiffConsole(d);
}
