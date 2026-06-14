// JSON reporter: the RunResult, verbatim (the same shape as .plune/last-run.json).

import type { RunResult } from '../types/results.js';

export function renderJson(result: RunResult): string {
  return JSON.stringify(result, null, 2);
}
