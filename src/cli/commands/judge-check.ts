// `plune judge-check <labels.jsonl>`: reads a saved run and a person's labels, prints how
// well the judge agrees. Local only: no platform, no network, no model call. `--init` writes the labels file
// to fill in from the run.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { judgeCheck, formatJudgeCheck, type CheckOptions } from '../../judge/check.js';
import { JudgeCheckError, labelTemplate, parseLabels } from '../../judge/labels.js';
import { parseRunResult } from '../../types/run-result-schema.js';
import type { RunResult } from '../../types/results.js';

export interface JudgeCheckFlags {
  run?: string;
  check?: string;
  eval?: string;
  minKappa?: string;
  maxIntervalWidth?: string;
  init?: boolean;
  force?: boolean;
}

function number(flag: string, raw: string | undefined, min: number, max: number): number | undefined {
  if (raw === undefined) return undefined;
  const v = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(v) || v < min || v > max)
    throw new JudgeCheckError(`${flag} is a number from ${min} to ${max}, not ${JSON.stringify(raw)}`);
  return v;
}

function readRun(cwd: string, file: string): RunResult {
  let text: string;
  try {
    text = fs.readFileSync(path.resolve(cwd, file), 'utf8');
  } catch {
    throw new JudgeCheckError(`cannot read the run ${file}: run "plune run" first, or name one with --run`);
  }
  try {
    return parseRunResult(JSON.parse(text.replace(/^﻿/, ''))) as RunResult;
  } catch {
    throw new JudgeCheckError(`${file} is not a run that plune run writes`);
  }
}

/** Runs the command; returns the exit code. Throws `JudgeCheckError` for what the person can fix (exit 2). */
export async function handleJudgeCheck(
  labelsFile: string,
  flags: JudgeCheckFlags,
  cwd: string,
  write: (text: string) => void,
): Promise<0 | 1> {
  const run = readRun(cwd, flags.run ?? path.join('.plune', 'last-run.json'));
  const target = path.resolve(cwd, labelsFile);

  if (flags.init === true) {
    if (!flags.force && fs.existsSync(target))
      throw new JudgeCheckError(`${labelsFile} exists: it may hold labels; --force writes over it`);
    const text = labelTemplate(run, flags.eval);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text, 'utf8');
    const n = text === '' ? 0 : text.split('\n').length - 1;
    write(
      `Wrote ${labelsFile}: ${n} rows to label. Set "human" to "pass" or "fail", with "by" and "at", then run plune judge-check ${labelsFile}.\n`,
    );
    return 0;
  }

  let text: string;
  try {
    text = fs.readFileSync(target, 'utf8');
  } catch {
    throw new JudgeCheckError(`cannot read the labels ${labelsFile}: --init writes one from the run`);
  }
  const options: CheckOptions = {};
  const check = number('--check', flags.check, 1, Number.MAX_SAFE_INTEGER);
  if (check !== undefined) {
    if (!Number.isInteger(check)) throw new JudgeCheckError(`--check is a whole number, not ${flags.check}`);
    options.check = check;
  }
  const minKappa = number('--min-kappa', flags.minKappa, -1, 1);
  if (minKappa !== undefined) options.minKappa = minKappa;
  const width = number('--max-interval-width', flags.maxIntervalWidth, 0, 2);
  if (width !== undefined) options.maxIntervalWidth = width;
  if (flags.eval !== undefined) options.evalId = flags.eval;

  const report = judgeCheck(run, parseLabels(text), options);
  write(formatJudgeCheck(report, options.minKappa));
  return report.exitCode;
}
