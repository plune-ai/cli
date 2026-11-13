// Diff reporter (ADR-GA03; mirrors ADR-RP02 pure-renderers). Renders a RunDiff to
// console | json | markdown. The markdown form is the PR-comment body: it leads with a hidden
// sticky marker so the Action can find-and-update a single comment (AC-3.2). It carries only eval
// ids + statuses — no row outputs, no secrets (AC-5.3). Pure; never colored.

import type { RunDiff, EvalDiffStatus } from '../diff/diff.js';
import type { GateName, GateState } from '../diff/gates.js';
import type { Waiver } from '../diff/waivers.js';

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
  unmeasured: '⚠️ not measured',
  removed: '➖ removed',
};

const GATE_STATE: Record<GateState, { mark: string; text: string }> = {
  passed: { mark: '✅', text: 'passed' },
  failed: { mark: '❌', text: 'failed' },
  unmeasured: { mark: '⚠️', text: 'not measured' },
  waived: { mark: '🟡', text: 'waived' },
};

// The headline: a regression first (unless a waiver lifted it), then a failed gate, then evals never
// measured (plune#2414), then a gate not measured, and only then green.
function headline(d: RunDiff): { mark: string; text: string } | null {
  const gates = d.gates?.gates ?? [];
  const named = (state: GateState): string[] => gates.filter((g) => g.state === state).map((g) => g.gate);
  const regression = gates.find((g) => g.gate === 'regression');
  if (d.summary.hasRegression && regression?.state !== 'waived')
    return { mark: '❌', text: `${d.summary.regressions} regression(s)` };
  if (named('failed').length > 0) return { mark: '❌', text: `gate failed: ${named('failed').join(', ')}` };
  if (d.summary.unmeasured > 0) return { mark: '⚠️', text: `${d.summary.unmeasured} eval(s) not measured` };
  if (named('unmeasured').length > 0) return { mark: '⚠️', text: `not measured: ${named('unmeasured').join(', ')}` };
  if (named('waived').length > 0) return { mark: '✅', text: `gates passed (${named('waived').length} waived)` };
  return null;
}

const capital = (t: string): string => t.charAt(0).toUpperCase() + t.slice(1);

function amount(gate: GateName, n: number | undefined): string {
  if (n === undefined) return '—';
  if (gate === 'pass-rate') return `${n} pp`;
  if (gate === 'cost') return `$${n}`;
  if (gate === 'cost-increase') return `${n}%`;
  return String(n);
}

// A waiver's reason is the repository's own text: kept on one line.
const oneLine = (t: string): string => t.replace(/\s*[\r\n]+\s*/g, ' ');
const cell = (t: string): string => oneLine(t).replace(/\|/g, '\\|');
const target = (w: Waiver, quote: (t: string) => string): string =>
  w.eval === undefined ? w.gate : `${w.gate} of ${quote(w.eval)}`;

function waiverLines(d: RunDiff, quote: (t: string) => string, text: (t: string) => string): string[][] {
  const { applied, expired, unused } = d.gates!.waivers;
  return [
    applied.map((w) => `${target(w, quote)} until ${w.expires}: ${text(w.reason)}`),
    expired.map((w) => `${target(w, quote)} on ${w.expires}: ${text(w.reason)}`),
    unused.map((w) => `${target(w, quote)} until ${w.expires}: ${text(w.reason)}`),
  ];
}

function gatesMarkdown(d: RunDiff): string[] {
  if (d.gates === undefined) return [];
  const out = ['### Gates', '', '| Gate | State | Value | Threshold | Reason |', '| --- | --- | --- | --- | --- |'];
  for (const g of d.gates.gates) {
    const s = GATE_STATE[g.state];
    out.push(
      `| ${g.gate} | ${s.mark} ${s.text} | ${amount(g.gate, g.value)} | ${amount(g.gate, g.threshold)} | ${cell(g.reason)} |`,
    );
  }
  out.push('');
  const details = d.gates.gates.flatMap((g) => (g.details ?? []).map((x) => `- ${g.gate}: ${x}`));
  const [applied, expired, unused] = waiverLines(d, (t) => `\`${t}\``, oneLine);
  const lines = [
    ...details,
    ...applied!.map((l) => `- Waived: ${l}`),
    ...expired!.map((l) => `- Expired: ${l}`),
    ...unused!.map((l) => `- Unused: ${l}`),
  ];
  if (lines.length > 0) out.push(...lines, '');
  return out;
}

function gatesConsole(d: RunDiff): string[] {
  if (d.gates === undefined) return [];
  const out = ['Gates:'];
  for (const g of d.gates.gates) {
    const value = g.value === undefined ? '' : `: ${amount(g.gate, g.value)}`;
    const limit = g.threshold === undefined ? '' : ` (limit ${amount(g.gate, g.threshold)})`;
    out.push(`  ${g.gate}: ${GATE_STATE[g.state].text}, ${g.reason}${value}${limit}`);
    for (const x of g.details ?? []) out.push(`    ${x}`);
  }
  const [applied, expired, unused] = waiverLines(d, (t) => t, oneLine);
  out.push(
    ...applied!.map((l) => `  waived: ${l}`),
    ...expired!.map((l) => `  expired waiver: ${l}`),
    ...unused!.map((l) => `  unused waiver: ${l}`),
  );
  return out;
}

function summaryLine(d: RunDiff): string {
  const s = d.summary;
  return [
    `${s.regressions} regression(s)`,
    `${s.improvements} improvement(s)`,
    `${s.newFails} new-fail`,
    `${s.preExistingFails} pre-existing-fail`,
    `${s.errored} errored`,
    `${s.removed} removed`,
    `${s.unmeasured} not measured`,
    `${s.stablePasses} stable`,
  ].join(' · ');
}

export function renderDiffMarkdown(d: RunDiff): string {
  const out: string[] = [STICKY_MARKER, '## Plune eval diff', ''];
  const head = headline(d);
  out.push(head ? `### ${head.mark} ${capital(head.text)}` : '### ✅ No regressions');
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
  out.push(...gatesMarkdown(d));
  out.push(`_${summaryLine(d)}_`);
  return out.join('\n');
}

function renderDiffConsole(d: RunDiff): string {
  const head = headline(d);
  const out: string[] = [`Plune eval diff: ${head ? head.text : 'no regressions'}`];
  for (const e of d.evals) {
    if (e.status === 'stable-pass') continue;
    out.push(`  ${e.id}: ${e.baseline} -> ${e.current} [${e.status}]`);
  }
  out.push(...gatesConsole(d));
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
