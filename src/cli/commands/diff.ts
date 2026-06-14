// `plune diff` data layer: load two persisted RunResults and compute their diff. Pure read —
// never re-runs evals. The Action calls this on the `plune run --format json` output of the
// baseline (main) and the current (PR) commit (ADR-GA03).

import * as fs from 'node:fs';
import type { RunResult } from '../../types/results.js';
import { diffRuns, type RunDiff } from '../../diff/diff.js';

export class DiffInputError extends Error {
  readonly code = 'DIFF_INPUT';
  constructor(message: string) {
    super(message);
    this.name = 'DiffInputError';
  }
}

// A loaded file must at least look like a RunResult — otherwise an old-schema, truncated, or
// hand-edited file would crash diffRuns (which reads result.evals). Mirrors report.ts.
function isRunResult(v: unknown): v is RunResult {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return Array.isArray(o['evals']) && typeof o['summary'] === 'object' && o['summary'] !== null;
}

function loadRunResult(file: string, label: string): RunResult {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    throw new DiffInputError(`Cannot read ${label} run file: ${file}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new DiffInputError(`${label} run file is not valid JSON: ${file}`);
  }
  if (!isRunResult(parsed)) {
    throw new DiffInputError(`${label} run file is not a Plune RunResult: ${file}`);
  }
  return parsed;
}

export interface DiffOptions {
  baselinePath: string;
  currentPath: string;
}

export function handleDiff(opts: DiffOptions): RunDiff {
  const baseline = loadRunResult(opts.baselinePath, 'baseline');
  const current = loadRunResult(opts.currentPath, 'current');
  return diffRuns(baseline, current);
}
