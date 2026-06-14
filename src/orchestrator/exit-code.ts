// Exit code from a finished RunResult (ADR-OR02 / CLI_SPEC §4.2). Pure.
// Config/load errors (exit 2) are handled by the CLI before/around the run, not here.

import type { RunResult } from '../types/results.js';

export function exitCodeFor(result: RunResult): 0 | 1 | 2 {
  const { failed, errored } = result.summary;
  if (failed > 0) return 1; // a quality regression
  if (errored > 0) return 2; // infrastructure only, no normal fails
  return 0;
}
