/**
 * The score and the verdict of a conformance run, from the verdicts alone: a saved result scores the same today as
 * the day it was made, whatever the catalog has gained since. Every selected check lands in exactly one bucket, so
 * the buckets add up to the run, and every number of the summary can be traced to ids.
 *
 * - The score counts only `MUST` checks of the profile: `floor(1000 * passed / applicable) / 10`, where
 *   `applicable = passed + failed + could-not-run`.
 * - `not-applicable`, `pending` (not in the profile, or no result yet) and `could-not-run` for `needs-input` stay out
 *   of the denominator.
 * - `SHOULD`, `MAY` and advice are advisories, probes are controls: neither moves the score or the verdict.
 * - Verdict: `failed` on a failure; else `incomplete` when something could not run, or nothing was measured
 *   (`applicable = 0`, score null); else `passed`.
 */

import { MCP_EXIT } from '../exit-codes.js';
import { CATALOG, type CatalogEntry } from './catalog.js';
import type { Verdict } from './outcome.js';
import { PROFILE, type Profile } from './profile.js';

export type RunVerdict = 'passed' | 'failed' | 'incomplete';

export interface Buckets {
  passed: string[];
  failed: string[];
  /** Could not run, for any reason but `needs-input`: in the denominator. */
  couldNotRun: string[];
  /** Could not run for want of an input the user gives: out of the denominator. */
  needsInput: string[];
  notApplicable: string[];
  /** Not in the profile, or no result yet: the verdict is shown, the score does not read it. */
  pending: string[];
  /** `SHOULD`, `MAY` and advice: printed, never scored. */
  advisories: string[];
  /** Probes other checks rest on: printed, never scored. */
  controls: string[];
}

export interface Summary extends Buckets {
  /** Null when nothing was measured. */
  score: number | null;
  applicable: number;
  verdict: RunVerdict;
}

export const BUCKETS: readonly (keyof Buckets)[] = [
  'passed',
  'failed',
  'couldNotRun',
  'needsInput',
  'notApplicable',
  'pending',
  'advisories',
  'controls',
];

export const floorScore = (passed: number, applicable: number): number | null =>
  applicable === 0 ? null : Math.floor((1000 * passed) / applicable) / 10;

function bucketOf(entry: CatalogEntry, v: Verdict, counted: ReadonlySet<string>): keyof Buckets {
  if (entry.kind === 'control') return 'controls';
  if (entry.kind === 'advice' || entry.level !== 'MUST') return 'advisories';
  if (!counted.has(entry.id) || v.state === 'pending') return 'pending';
  if (v.state === 'not-applicable') return 'notApplicable';
  if (v.state === 'could-not-run') return v.reason === 'needs-input' ? 'needsInput' : 'couldNotRun';
  return v.state;
}

/**
 * The summary of these verdicts. A verdict whose id the catalog does not have is refused: a result is read with the
 * catalog it was made with or a later one, and ids are never removed.
 */
export function summarize(
  verdicts: readonly Verdict[],
  catalog: readonly CatalogEntry[] = CATALOG,
  profile: Profile = PROFILE,
): Summary {
  const byId = new Map(catalog.map((e) => [e.id, e]));
  const counted = new Set(profile.checks);
  const b: Buckets = {
    passed: [],
    failed: [],
    couldNotRun: [],
    needsInput: [],
    notApplicable: [],
    pending: [],
    advisories: [],
    controls: [],
  };
  for (const v of verdicts) {
    const entry = byId.get(v.id);
    if (entry === undefined) throw new Error(`no check "${v.id}" in the catalog`);
    b[bucketOf(entry, v, counted)].push(v.id);
  }
  const applicable = b.passed.length + b.failed.length + b.couldNotRun.length;
  const verdict: RunVerdict =
    b.failed.length > 0
      ? 'failed'
      : b.couldNotRun.length > 0 || applicable === 0
        ? 'incomplete'
        : 'passed';
  return { ...b, score: floorScore(b.passed.length, applicable), applicable, verdict };
}

export const exitCodeOf = (verdict: RunVerdict): 0 | 1 | 3 =>
  verdict === 'passed' ? MCP_EXIT.ok : verdict === 'failed' ? MCP_EXIT.violations : MCP_EXIT.unmeasured;

/**
 * The line that explains the score: `Score 91.6 = 22 of 24 | failed: a | could-not-run: b (timeout) | outside the
 * score: not-applicable 12, pending 6, needs-input 3`. `reasons` gives the reason of a could-not-run id.
 */
export function summaryLine(s: Summary, reasons: ReadonlyMap<string, string> = new Map()): string {
  const parts = [`Score ${s.score === null ? 'none' : s.score.toFixed(1)} = ${s.passed.length} of ${s.applicable}`];
  if (s.failed.length > 0) parts.push(`failed: ${s.failed.join(', ')}`);
  if (s.couldNotRun.length > 0)
    parts.push(
      `could-not-run: ${s.couldNotRun.map((id) => (reasons.has(id) ? `${id} (${reasons.get(id)})` : id)).join(', ')}`,
    );
  const outside = (
    [
      ['not-applicable', s.notApplicable],
      ['pending', s.pending],
      ['needs-input', s.needsInput],
      ['advisories', s.advisories],
      ['controls', s.controls],
    ] as const
  )
    .filter(([, ids]) => ids.length > 0)
    .map(([name, ids]) => `${name} ${ids.length}`);
  if (outside.length > 0) parts.push(`outside the score: ${outside.join(', ')}`);
  return parts.join(' | ');
}
