/**
 * What one conformance check gives: one of the five states, and for `not-applicable` and `could-not-run` the reason.
 * The states are those of every `plune mcp` check (../result.ts); `could-not-run` is never a pass.
 */

import type { CheckState } from '../result.js';
import type { CatalogEntry, Era, Transport } from './catalog.js';

export type NotApplicableReason = 'era' | 'capability-not-declared' | 'transport' | 'no-auth';
/** `needs-input`: an input only the user can give is missing (a fixture); it keeps a check out of the score. */
export type CouldNotRunReason = 'timeout' | 'prerequisite-failed' | 'needs-input' | 'transport-error';

export type CheckOutcome =
  | { state: 'passed' | 'failed' | 'pending'; expected?: string; actual?: string; fix?: string }
  | { state: 'not-applicable'; reason: NotApplicableReason; actual?: string }
  | { state: 'could-not-run'; reason: CouldNotRunReason; actual?: string };

/** The state and reason of an outcome, as a saved result holds them: all that the score reads. */
export interface Verdict {
  id: string;
  state: CheckState;
  reason?: NotApplicableReason | CouldNotRunReason;
}

/** The revision's era: `2026-07-28` and later is modern (dates in this form sort as text). */
export const eraOf = (revision: string): Era => (revision >= '2026-07-28' ? 'modern' : 'legacy');

/** `not-applicable` when the check is for another era or transport; undefined when it applies. */
export function applicability(
  entry: CatalogEntry,
  on: { era: Era; transport: Transport },
): CheckOutcome | undefined {
  if (!entry.transports.includes(on.transport)) return { state: 'not-applicable', reason: 'transport' };
  if (!entry.eras.includes(on.era)) return { state: 'not-applicable', reason: 'era' };
  return undefined;
}
