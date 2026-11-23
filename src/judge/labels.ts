// Human pass/fail labels of eval rows, in the file ADR 0084 of the platform describes (plune-ai/plune#2889):
// one JSON object per line, keyed by the eval and the hash of the row's `vars`, tied to one answer by the
// hash of its `output`. Pure: text in, values out.

import { canonicalJson } from '../util/canonical-json.js';
import { sha256 } from '../util/hash.js';
import { baseEvalId, type EvalResult, type RowResult, type RunResult } from '../types/results.js';
import type { Pair } from './agreement.js';

export class JudgeCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JudgeCheckError';
  }
}

export interface Label {
  eval: string;
  vars_hash: string;
  output_hash: string;
  /** `null` while nobody has labelled the row yet. */
  human: 'pass' | 'fail' | null;
  by: string;
  at: string;
  note?: string;
}

/** The hash a label keys a row by: its canonical `vars`, the same canonical form as `measured.rows_hash`. */
export const varsHashOf = (vars: Record<string, unknown>): string => sha256(canonicalJson(vars));
export const outputHashOf = (output: string): string => sha256(output);

const HEX64 = /^[0-9a-f]{64}$/i;
const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** The labels of a file. A line that is not a label stops the check with its number: nothing is skipped silently. */
export function parseLabels(text: string): Label[] {
  const labels: Label[] = [];
  text
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .forEach((line, i) => {
      if (line.trim() === '') return;
      const where = `labels line ${i + 1}`;
      let v: unknown;
      try {
        v = JSON.parse(line);
      } catch {
        throw new JudgeCheckError(`${where} is not JSON`);
      }
      if (!isObj(v)) throw new JudgeCheckError(`${where} is not an object`);
      if (typeof v.eval !== 'string' || v.eval === '') throw new JudgeCheckError(`${where}: eval is missing`);
      for (const k of ['vars_hash', 'output_hash'] as const) {
        if (typeof v[k] !== 'string' || !HEX64.test(v[k]))
          throw new JudgeCheckError(`${where}: ${k} is not a sha256 in hex`);
      }
      if (v.human !== 'pass' && v.human !== 'fail' && v.human !== null)
        throw new JudgeCheckError(`${where}: human is "pass", "fail" or null`);
      const by = typeof v.by === 'string' ? v.by : '';
      const at = typeof v.at === 'string' ? v.at : '';
      if (v.human !== null && (by === '' || at === ''))
        throw new JudgeCheckError(`${where}: a label says who gave it and when (by, at)`);
      labels.push({
        eval: v.eval,
        vars_hash: (v.vars_hash as string).toLowerCase(),
        output_hash: (v.output_hash as string).toLowerCase(),
        human: v.human,
        by,
        at,
        ...(typeof v.note === 'string' ? { note: v.note } : {}),
      });
    });
  return labels;
}

/** A labels file to fill in: one line per row of the run that has an answer, `human` left `null`. */
export function labelTemplate(run: RunResult, evalId?: string): string {
  const evals = run.evals.filter((ev) => evalId === undefined || ev.id === evalId || baseEvalId(ev) === evalId);
  if (evals.length === 0) throw new JudgeCheckError(`the run has no eval ${JSON.stringify(evalId)}`);
  const lines: string[] = [];
  for (const ev of evals) {
    for (const row of ev.rows) {
      if (row.output === null) continue;
      // `vars` and `output` are there to read while labelling; the check keys on the two hashes only.
      // The judge's own verdict is left out on purpose, so it does not lead the person.
      lines.push(
        JSON.stringify({
          eval: ev.id,
          vars_hash: varsHashOf(row.vars),
          output_hash: outputHashOf(row.output),
          human: null,
          by: '',
          at: '',
          vars: row.vars,
          output: row.output,
        }),
      );
    }
  }
  return lines.join('\n') + (lines.length > 0 ? '\n' : '');
}

/** What became of each label when it was matched with the run. */
export interface Matched {
  pairs: Pair[];
  /** `human` still null. */
  unlabelled: number;
  /** The row is in the run, but its answer changed since the label was given. */
  stale: number;
  /** No row of the run has this eval and these vars. */
  missing: number;
  /** The row has no verdict of the check: it errored, was never judged, or has fewer checks. */
  notJudged: number;
  /** Two labels of one row that disagree with each other. */
  conflicting: number;
  /** The run has several rows with these vars: which one the label read cannot be told. */
  repeated: number;
}

/**
 * Pairs a person's labels with the verdict of one check of one eval. `check` is the position of the check
 * in the row (from 0), the order the run lists them: shared `defaults.assertions` first, then the eval's own.
 */
export function matchLabels(
  ev: EvalResult,
  check: number,
  checkType: string,
  labels: readonly Label[],
): Matched {
  const rows = new Map<string, RowResult>();
  const repeats = new Set<string>();
  for (const row of ev.rows) {
    const hash = varsHashOf(row.vars);
    if (rows.has(hash)) repeats.add(hash);
    rows.set(hash, row);
  }
  const m: Matched = { pairs: [], unlabelled: 0, stale: 0, missing: 0, notJudged: 0, conflicting: 0, repeated: 0 };

  const byRow = new Map<string, Set<'pass' | 'fail'>>();
  for (const l of labels) {
    if (l.eval !== ev.id) continue;
    if (l.human === null) {
      m.unlabelled += 1;
      continue;
    }
    const row = rows.get(l.vars_hash);
    if (row === undefined) {
      m.missing += 1;
      continue;
    }
    if (repeats.has(l.vars_hash)) {
      m.repeated += 1;
      continue;
    }
    // No answer this time (the provider failed): nothing to compare, not a changed answer.
    if (row.output === null) {
      m.notJudged += 1;
      continue;
    }
    if (outputHashOf(row.output) !== l.output_hash) {
      m.stale += 1;
      continue;
    }
    const seen = byRow.get(l.vars_hash) ?? new Set();
    seen.add(l.human);
    byRow.set(l.vars_hash, seen);
  }
  for (const [hash, said] of byRow) {
    if (said.size > 1) {
      m.conflicting += 1;
      continue;
    }
    const row = rows.get(hash)!;
    const verdict = row.assertions[check];
    // A run stops a row's checks at the first one that errors, so the verdicts before it keep their place
    // and the rest are absent. A saved run writes `inconclusive: null` on a judged row: null counts as judged.
    const judged = row.inconclusive == null && verdict?.type === checkType;
    if (!judged) {
      m.notJudged += 1;
      continue;
    }
    m.pairs.push({ human: said.has('pass'), judge: verdict.passed });
  }
  return m;
}
