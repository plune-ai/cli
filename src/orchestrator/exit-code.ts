// Exit code from a finished RunResult (ADR-OR02 / CLI_SPEC §4.2). Pure.
// Config/load errors (exit 2) are handled by the CLI before/around the run, not here.

import type { RunResult } from '../types/results.js';
import { CACHE_MISS_CODE } from './run.js';

/** `--cache-strict` found rows with no cache entry: not a failed assertion (1), not an error (2). */
export const CACHE_STRICT_EXIT = 5;

/** One line per row left unanswered by `--cache-strict`: the eval and the row's variables. */
export function cacheMissRows(result: RunResult): string[] {
  return result.evals.flatMap((ev) =>
    ev.rows
      .filter((r) => r.error?.code === CACHE_MISS_CODE)
      .map((r) => `${ev.id} ${JSON.stringify(r.vars)}`),
  );
}

export function exitCodeFor(result: RunResult): 0 | 1 | 2 {
  const { failed, errored } = result.summary;
  if (failed > 0) return 1; // a quality regression
  if (errored > 0) return 2; // infrastructure only, no normal fails
  return 0;
}
