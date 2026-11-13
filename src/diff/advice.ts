// The advice of `plune diff` (MCP-D7): what the numbers say in words, and the experiment on tool descriptions. A report
// and nothing more: no state of an eval, no summary count, no gate and no exit code reads anything in here. Pure.
//
// Only eval ids, tool names, counts and numbers leave this module: no row, argument, result or environment value.

import type { AgentRecord, EvalResult, RowResult, RunResult } from '../types/results.js';
import { rowStatus } from '../types/results.js';
import { populationDiffs } from './gates.js';
import { compareProportions, type Comparison, type Proportion } from './stats.js';

export interface EvalComparison {
  id: string;
  /** Absent when the two sides cannot be compared; `unavailable` says why. */
  comparison?: Comparison;
  unavailable?: string[];
}

export interface Experiment {
  /** The substitutions of each run: tool names with the SHA-256 of the text. */
  baseline: string[];
  current: string[];
  /** Why the section could not be built (the populations differ), one line each. */
  unavailable?: string[];
  evals: {
    id: string;
    /** First tool called, by name, per row (the attempt the row shows); `(none)` for a row that called nothing. */
    firstTool: { baseline: Record<string, number>; current: Record<string, number> };
    /** Share of attempts that passed `first-tool`; absent when the eval has no such check. */
    hit?: { baseline: Proportion; current: Proportion; comparison: Comparison };
  }[];
}

export interface DiffAdvice {
  /** Always the same sentence: this section never changes an exit code. */
  note: string;
  evals: EvalComparison[];
  overall: { comparison?: Comparison; unavailable?: string[] };
  experiment?: Experiment;
}

export const ADVICE_NOTE =
  'Advice only: nothing here changes the exit code, the state of an eval or a gate.';

/** Passed attempts of all attempts of an eval: a repeated row counts each run, a plain row one. */
function attemptsOf(e: EvalResult): Proportion {
  let [passed, total] = [0, 0];
  for (const row of e.rows) {
    if (row.attempts !== undefined) {
      passed += row.attempts.passed;
      total += row.attempts.runs;
    } else {
      passed += rowStatus(row) === 'passed' ? 1 : 0;
      total += 1;
    }
  }
  return { passed, total };
}

const hasRepeats = (e: EvalResult): boolean =>
  (e.measured?.runs ?? 1) > 1 || e.rows.some((r) => r.attempts !== undefined);

const only = (run: RunResult, e: EvalResult): RunResult => ({ ...run, evals: [e] });

function evalComparisons(baseline: RunResult, current: RunResult): EvalComparison[] {
  const base = new Map(baseline.evals.map((e) => [e.id, e]));
  const out: EvalComparison[] = [];
  for (const cur of current.evals) {
    const b = base.get(cur.id);
    if (b === undefined || !hasRepeats(b) || !hasRepeats(cur)) continue;
    // The shares of two different datasets, assertions or models are not shares of the same thing.
    const diffs = populationDiffs(only(baseline, b), only(current, cur));
    out.push(
      diffs.length > 0
        ? { id: cur.id, unavailable: diffs }
        : { id: cur.id, comparison: compareProportions(attemptsOf(cur), attemptsOf(b)) },
    );
  }
  return out;
}

function overallComparison(baseline: RunResult, current: RunResult): DiffAdvice['overall'] {
  const diffs = populationDiffs(baseline, current);
  if (diffs.length > 0) return { unavailable: diffs };
  const sum = (run: RunResult): Proportion =>
    run.evals
      .map(attemptsOf)
      .reduce((a, p) => ({ passed: a.passed + p.passed, total: a.total + p.total }), {
        passed: 0,
        total: 0,
      });
  return { comparison: compareProportions(sum(current), sum(baseline)) };
}

// The descriptions the model was shown in place of the server's, as the rows of the eval record them.
const swaps = (e: EvalResult): string[] =>
  [
    ...new Set(
      e.rows.flatMap((r) =>
        ((r.agent as AgentRecord | undefined)?.description_overrides ?? []).map(
          (s) => `${s.tool}=${s.sha256}`,
        ),
      ),
    ),
  ].sort();

function firstToolCounts(e: EvalResult): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of e.rows) {
    const agent = row.agent as AgentRecord | undefined;
    if (agent === undefined) continue;
    const first = agent.steps.flatMap((s) => s.calls)[0]?.name ?? '(none)';
    out[first] = (out[first] ?? 0) + 1;
  }
  return out;
}

/** Passed `first-tool` checks of all attempts of an eval, or undefined when it has none. */
function firstToolHits(e: EvalResult): Proportion | undefined {
  let [passed, total] = [0, 0];
  const count = (assertions: RowResult['assertions']): void => {
    for (const a of assertions) {
      if (a.type !== 'first-tool') continue;
      total++;
      if (a.passed) passed++;
    }
  };
  for (const row of e.rows) {
    if (row.attempts !== undefined) row.attempts.results.forEach((r) => count(r.assertions));
    else count(row.assertions);
  }
  return total === 0 ? undefined : { passed, total };
}

/**
 * The experiment on descriptions: two runs of the same evals that differ in the descriptions the model was shown. It is
 * built only when the populations are the same; otherwise the section says how they differ and nothing is compared.
 */
function experiment(baseline: RunResult, current: RunResult): Experiment | undefined {
  const base = new Map(baseline.evals.map((e) => [e.id, e]));
  const agentic = current.evals.filter(
    (e) => e.rows.some((r) => r.agent !== undefined) && base.has(e.id),
  );
  const differs = agentic.filter((e) => swaps(e).join('\n') !== swaps(base.get(e.id)!).join('\n'));
  if (differs.length === 0) return undefined;
  const list = (run: RunResult): string[] => [...new Set(run.evals.flatMap(swaps))].sort();
  const head = { baseline: list(baseline), current: list(current) };
  const populations = populationDiffs(baseline, current);
  if (populations.length > 0) return { ...head, unavailable: populations, evals: [] };
  return {
    ...head,
    evals: differs.map((cur) => {
      const b = base.get(cur.id)!;
      const [hb, hc] = [firstToolHits(b), firstToolHits(cur)];
      return {
        id: cur.id,
        firstTool: { baseline: firstToolCounts(b), current: firstToolCounts(cur) },
        ...(hb !== undefined && hc !== undefined
          ? { hit: { baseline: hb, current: hc, comparison: compareProportions(hc, hb) } }
          : {}),
      };
    }),
  };
}

/** The advice for two runs, or undefined when there is nothing to say (no eval with repeats and no experiment). */
export function adviceFor(baseline: RunResult, current: RunResult): DiffAdvice | undefined {
  const evals = evalComparisons(baseline, current);
  const exp = experiment(baseline, current);
  if (evals.length === 0 && exp === undefined) return undefined;
  return {
    note: ADVICE_NOTE,
    evals,
    overall: overallComparison(baseline, current),
    ...(exp !== undefined ? { experiment: exp } : {}),
  };
}
