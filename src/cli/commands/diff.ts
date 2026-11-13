// `plune diff` data layer: load two persisted RunResults and compute their diff. Pure read —
// never re-runs evals. The Action calls this on the `plune run --format json` output of the
// baseline (main) and the current (PR) commit (ADR-GA03).

import * as fs from 'node:fs';
import type { RunResult } from '../../types/results.js';
import { diffRuns, type RunDiff } from '../../diff/diff.js';
import { adviceFor } from '../../diff/advice.js';
import { evaluateGates, gatesEnabled, type GateOptions } from '../../diff/gates.js';
import { parseWaivers, WaiversFileError, type Waiver } from '../../diff/waivers.js';

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
  failOnRegression?: boolean;
  /** The gate limits as typed on the command line; each gate is off until its limit is given. */
  maxPassRateDropPercent?: string;
  maxCostUsd?: string;
  maxCostIncreasePercent?: string;
  maxTokens?: string;
  /** Path of the waivers file. */
  waivers?: string;
}

function limit(flag: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(n) || n < 0)
    throw new DiffInputError(`--${flag} must be a number of 0 or more (got "${raw}")`);
  return n;
}

function loadWaivers(file: string, now: Date): Waiver[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    throw new DiffInputError(`Cannot read waivers file: ${file}`);
  }
  try {
    return parseWaivers(raw, now);
  } catch (err) {
    if (err instanceof WaiversFileError) throw new DiffInputError(`${file}:
${err.message}`);
    throw err;
  }
}

export function handleDiff(opts: DiffOptions): RunDiff {
  const gateOpts: GateOptions = {
    ...(opts.failOnRegression === true ? { failOnRegression: true } : {}),
  };
  for (const [key, flag] of [
    ['maxPassRateDropPercent', 'max-pass-rate-drop-percent'],
    ['maxCostUsd', 'max-cost-usd'],
    ['maxCostIncreasePercent', 'max-cost-increase-percent'],
    ['maxTokens', 'max-tokens'],
  ] as const) {
    const n = limit(flag, opts[key]);
    if (n !== undefined) gateOpts[key] = n;
  }
  const baseline = loadRunResult(opts.baselinePath, 'baseline');
  const current = loadRunResult(opts.currentPath, 'current');
  // The system clock, read once: no flag, variable or file field moves it, so an expired waiver stays expired.
  const now = new Date();
  // A bad waivers file is an input error even when no gate is on, never ignored quietly.
  const waivers = opts.waivers === undefined ? [] : loadWaivers(opts.waivers, now);
  const diff = diffRuns(baseline, current);
  // Added after the diff is made and the gates are read from it, so the advice is nowhere an input of either.
  const advice = adviceFor(baseline, current);
  const withAdvice = advice === undefined ? diff : { ...diff, advice };
  if (!gatesEnabled(gateOpts)) return withAdvice;
  return { ...withAdvice, gates: evaluateGates(baseline, current, diff, gateOpts, waivers, now) };
}
