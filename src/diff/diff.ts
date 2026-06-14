// Pure baseline-vs-current comparison for two RunResults (ADR-GA03).
//
// This module has NO I/O and imports only frozen public types — it is the pure-core enabler
// that keeps the GitHub Action a thin edge (constitution §5). `RunDiff` is INTENTIONALLY not
// added to the frozen public barrel (types/public.ts): the contract the Action couples to is
// the stdout of `plune diff`, not this TS type.

import type { RunResult, EvalResult, RowResult } from '../types/results.js';

export type EvalStatus = 'passed' | 'failed' | 'errored';
export type EvalPresence = EvalStatus | 'absent';

export type EvalDiffStatus =
  | 'regression' // baseline passed → current failed (the only status that gates — AC-2.2/AC-4)
  | 'improvement' // baseline not-passing → current passed
  | 'pre-existing-fail' // failed on both — NOT a regression (AC-2.3)
  | 'new-fail' // absent in baseline → current failed; surfaced but does NOT gate (AC-2.5)
  | 'new-pass' // absent in baseline → current passed
  | 'stable-pass' // passed on both
  | 'errored' // current errored — execution error, never a regression (AC-2.6)
  | 'removed'; // present in baseline, absent in current

export interface EvalDiff {
  id: string;
  status: EvalDiffStatus;
  baseline: EvalPresence;
  current: EvalPresence;
}

export interface RunDiffSummary {
  regressions: number;
  improvements: number;
  preExistingFails: number;
  newFails: number;
  newPasses: number;
  stablePasses: number;
  errored: number;
  removed: number;
  hasRegression: boolean;
}

export interface RunDiff {
  evals: EvalDiff[];
  summary: RunDiffSummary;
}

// Row-level status. Mirrors the orchestrator's classify() (orchestrator/run.ts) so the diff's
// notion of pass/fail/errored stays consistent with how the run itself was scored. Kept inline
// (not imported from run.ts) to keep this module pure and dependency-free.
function rowStatus(r: RowResult): EvalStatus {
  if (r.error !== undefined) return 'errored';
  if (r.assertions.some((a) => !a.passed)) return 'failed';
  return 'passed';
}

// Eval-level status, lifted from its rows with the same precedence as exit-code.ts:
// a genuine assertion failure dominates an infra error, which dominates pass.
function evalStatus(e: EvalResult): EvalStatus {
  const statuses = e.rows.map(rowStatus);
  if (statuses.includes('failed')) return 'failed';
  if (statuses.includes('errored')) return 'errored';
  return 'passed';
}

function classify(baseline: EvalPresence, current: EvalPresence): EvalDiffStatus {
  if (current === 'errored') return 'errored'; // AC-2.6 — infra, never a regression
  if (baseline === 'absent') return current === 'passed' ? 'new-pass' : 'new-fail';
  if (current === 'absent') return 'removed';
  // baseline ∈ {passed, failed, errored}; current ∈ {passed, failed}
  if (baseline === 'passed') return current === 'passed' ? 'stable-pass' : 'regression';
  // baseline failed or errored → there was no green baseline to regress from
  return current === 'passed' ? 'improvement' : 'pre-existing-fail';
}

export function diffRuns(baseline: RunResult, current: RunResult): RunDiff {
  const baseMap = new Map<string, EvalStatus>(baseline.evals.map((e) => [e.id, evalStatus(e)]));
  const curMap = new Map<string, EvalStatus>(current.evals.map((e) => [e.id, evalStatus(e)]));
  const ids = [...new Set([...baseMap.keys(), ...curMap.keys()])];

  const evals: EvalDiff[] = ids.map((id) => {
    const baselineP: EvalPresence = baseMap.get(id) ?? 'absent';
    const currentP: EvalPresence = curMap.get(id) ?? 'absent';
    return { id, status: classify(baselineP, currentP), baseline: baselineP, current: currentP };
  });

  const count = (s: EvalDiffStatus): number => evals.filter((e) => e.status === s).length;
  const summary: RunDiffSummary = {
    regressions: count('regression'),
    improvements: count('improvement'),
    preExistingFails: count('pre-existing-fail'),
    newFails: count('new-fail'),
    newPasses: count('new-pass'),
    stablePasses: count('stable-pass'),
    errored: count('errored'),
    removed: count('removed'),
    hasRegression: count('regression') > 0,
  };

  return { evals, summary };
}
