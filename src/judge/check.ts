// `plune judge-check`: does the judge of an eval agree with a person? Pure: the run and
// the labels come in as values, the report goes out as text. Nothing is changed by the result: no threshold and
// no judge prompt moves because of what it says.

import { agreementOf, type Agreement } from './agreement.js';
import { JudgeCheckError, matchLabels, type Label, type Matched } from './labels.js';
import { baseEvalId, type EvalResult, type RunResult } from '../types/results.js';

/** `kappa` meets `min`, allowing for float rounding: an exact 0.4 that sums to 0.3999999999999999 meets 0.4. */
export const meetsKappa = (kappa: number | null, min: number): boolean => kappa !== null && kappa >= min - 1e-9;

/** Checks whose verdict a model gives. */
export const JUDGE_TYPES: readonly string[] = ['llm-judge', 'faithfulness', 'answer-relevance', 'context-precision'];
/** Fewer labelled rows than this, and the figures are named as not reliable. */
export const MIN_RELIABLE_N = 30;
export const DEFAULT_MAX_INTERVAL_WIDTH = 0.4;

export interface CheckOptions {
  /** Position of the check in a row, from 1; by default the one check a model judges. */
  check?: number;
  /** Only this eval (its id, or its id without `@<model>`). */
  evalId?: string;
  maxIntervalWidth?: number;
  /** Exit 1 when the kappa of an eval is below this or has no value. */
  minKappa?: number;
}

export interface EvalCheck {
  evalId: string;
  check: number;
  checkType: string;
  matched: Matched;
  agreement: Agreement;
  warnings: string[];
}

export interface CheckReport {
  evals: EvalCheck[];
  /** Labels whose eval is not in the run. */
  otherEvals: string[];
  /** 1 when `minKappa` is set and an eval falls short of it. */
  exitCode: 0 | 1;
}

/** The checks of the eval in order, from the row with the most: a row's checks stop at the first that errors. */
function checkTypes(ev: EvalResult): string[] {
  const row = ev.rows.reduce<EvalResult['rows'][number] | undefined>(
    (best, r) => (r.assertions.length > (best?.assertions.length ?? 0) ? r : best),
    undefined,
  );
  return row === undefined ? [] : row.assertions.map((a) => a.type);
}

function pickCheck(ev: EvalResult, wanted: number | undefined): number {
  const types = checkTypes(ev);
  // Every row stopped at an error before this check: the run holds no verdict of it to compare.
  const erred = ev.rows.every((r) => r.error != null) ? '; every row stopped at an error, so later checks have no verdict' : '';
  if (wanted !== undefined) {
    if (wanted > types.length)
      throw new JudgeCheckError(
        `eval ${ev.id} has ${types.length} ${types.length === 1 ? 'check' : 'checks'} in a row; --check ${wanted} is not one${erred}`,
      );
    return wanted - 1;
  }
  const judged = types.flatMap((t, i) => (JUDGE_TYPES.includes(t) ? [i] : []));
  if (judged.length === 1) return judged[0]!;
  const list = types.map((t, i) => `${i + 1} ${t}`).join(', ');
  throw new JudgeCheckError(
    judged.length === 0
      ? `eval ${ev.id} has no check a model judges; name the one to compare with --check <n> (${list || 'no checks'})${erred}`
      : `eval ${ev.id} has ${judged.length} checks a model judges; name one with --check <n> (${list})`,
  );
}

/**
 * The model that answered the eval, when it also judged a check of type `checkType`.
 * The run judges every model check with the model of the cell, even an `llm-judge` that names a
 * `provider` of its own (plune-ai/cli#373), so the type is enough; read the run's judge once it records one.
 */
function selfJudge(ev: EvalResult, checkType: string): string | undefined {
  if (!JUDGE_TYPES.includes(checkType)) return undefined;
  return ev.provider?.model ?? ev.measured?.model?.split('/').slice(1).join('/');
}

export function judgeCheck(run: RunResult, labels: readonly Label[], options: CheckOptions = {}): CheckReport {
  const maxWidth = options.maxIntervalWidth ?? DEFAULT_MAX_INTERVAL_WIDTH;
  const labelled = new Set(labels.map((l) => l.eval));
  const evals = run.evals.filter((ev) =>
    options.evalId === undefined
      ? labelled.has(ev.id)
      : ev.id === options.evalId || baseEvalId(ev) === options.evalId,
  );
  if (evals.length === 0) {
    throw new JudgeCheckError(
      options.evalId === undefined
        ? 'no eval of the run has a label in the file'
        : `the run has no eval ${JSON.stringify(options.evalId)}`,
    );
  }

  const out: EvalCheck[] = [];
  let exitCode: 0 | 1 = 0;
  for (const ev of evals) {
    const check = pickCheck(ev, options.check);
    const checkType = checkTypes(ev)[check]!;
    const matched = matchLabels(ev, check, checkType, labels);
    const agreement = agreementOf(matched.pairs);
    const warnings: string[] = [];
    if (agreement.n < MIN_RELIABLE_N) {
      warnings.push(
        `${agreement.n} labelled rows, fewer than ${MIN_RELIABLE_N}: these figures are not reliable yet`,
      );
    }
    const iv = agreement.kappaInterval;
    if (agreement.kappa !== null && (iv === null || iv.high - iv.low > maxWidth)) {
      warnings.push(
        iv === null
          ? 'the 95% interval of kappa could not be estimated: most resamples had one answer only'
          : `the 95% interval of kappa is ${(iv.high - iv.low).toFixed(2)} wide, more than ${maxWidth}: label more rows before trusting the number`,
      );
    }
    if (agreement.kappa === null && agreement.n > 0) {
      warnings.push('kappa has no value: the person and the judge each gave one answer only');
    }
    const self = selfJudge(ev, checkType);
    if (self !== undefined) {
      warnings.push(`the judge is ${self}, the model that wrote the answers: a model tends to favour its own text`);
    }
    if (options.minKappa !== undefined && !meetsKappa(agreement.kappa, options.minKappa)) exitCode = 1;
    out.push({ evalId: ev.id, check, checkType, matched, agreement, warnings });
  }
  const inRun = new Set(run.evals.map((ev) => ev.id));
  const otherEvals = [...labelled].filter((id) => !inRun.has(id)).sort();
  return { evals: out, otherEvals, exitCode };
}

const fmt = (v: number | null): string => (v === null ? 'n/a' : v.toFixed(2));

export function formatJudgeCheck(report: CheckReport, minKappa?: number): string {
  const lines: string[] = [];
  for (const e of report.evals) {
    const a = e.agreement;
    const m = e.matched;
    const skipped = (
      [
        [m.unlabelled, 'not labelled yet'],
        [m.stale, 'answer changed since the label'],
        [m.missing, 'not in this run'],
        [m.notJudged, 'no verdict of this check'],
        [m.repeated, 'on a row whose vars repeat in the run'],
        [m.conflicting, 'labelled both pass and fail'],
      ] as const
    )
      .filter(([n]) => n > 0)
      .map(([n, what]) => `${n} ${what}`);
    lines.push(`Judge check: ${e.evalId}, check ${e.check + 1} (${e.checkType})`);
    lines.push(`  labelled rows: ${a.n}${skipped.length > 0 ? ` (left out: ${skipped.join(', ')})` : ''}`);
    lines.push('                 person pass  person fail');
    lines.push(`    judge pass   ${String(a.tp).padStart(11)}  ${String(a.fp).padStart(11)}`);
    lines.push(`    judge fail   ${String(a.fn).padStart(11)}  ${String(a.tn).padStart(11)}`);
    const iv = a.kappaInterval === null ? '' : ` (95% ${fmt(a.kappaInterval.low)} to ${fmt(a.kappaInterval.high)})`;
    lines.push(`  agreement ${fmt(a.agreement)} · TPR ${fmt(a.tpr)} · TNR ${fmt(a.tnr)} · kappa ${fmt(a.kappa)}${iv}`);
    for (const w of e.warnings) lines.push(`  warning: ${w}`);
    if (minKappa !== undefined) {
      lines.push(`  --min-kappa ${minKappa}: ${meetsKappa(a.kappa, minKappa) ? 'met' : 'not met'}`);
    }
    lines.push('');
  }
  if (report.otherEvals.length > 0) {
    lines.push(`Labels of evals not in this run: ${report.otherEvals.join(', ')}`, '');
  }
  return lines.join('\n');
}
