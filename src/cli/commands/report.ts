// `plune report` data source: load the last persisted RunResult. Pure read — never re-runs evals.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RunResult } from '../../types/results.js';

export class ReportNotFoundError extends Error {
  readonly code = 'NO_SAVED_RUN';
  constructor(message: string) {
    super(message);
    this.name = 'ReportNotFoundError';
  }
}

export interface ReportOptions {
  cwd?: string;
}

// A parsed last-run.json must at least look like a RunResult — otherwise an old-schema, truncated,
// or hand-edited file would crash the renderer (which reads result.summary / result.evals).
function isRunResult(v: unknown): v is RunResult {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o['summary'] === 'object' && o['summary'] !== null && Array.isArray(o['evals']);
}

export function handleReport(opts: ReportOptions = {}): RunResult {
  const cwd = opts.cwd ?? process.cwd();
  const file = path.join(cwd, '.plune', 'last-run.json');
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    throw new ReportNotFoundError('No saved run found. Run "plune run" first.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ReportNotFoundError('Saved run is unreadable. Run "plune run" again.');
  }
  if (!isRunResult(parsed)) {
    throw new ReportNotFoundError('Saved run is malformed. Run "plune run" again.');
  }
  return parsed;
}
