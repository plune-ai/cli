// A difference of two shares in plain words (MCP-D7). Pure and without imports, so it can be lifted into any edge.
// The interval is Newcombe's (Statistics in Medicine, 1998, method 10) over Wilson (1927) intervals of each share.
// It is advice, never a gate: nothing here sets an exit code. Shares are 0..1 inside; percentage points only at the
// edge of the output. Attempts of one row correlate, so the interval is a guide and not a proof.

/** The 97.5 % quantile of the normal distribution, fixed so a bound does not move with rounding. */
export const Z = 1.959963984540054;

/** Attempts needed on EACH side before a verdict is given. A side with none is never enough, whatever is asked. */
export const MIN_ATTEMPTS = 5;

export interface Proportion {
  passed: number;
  total: number;
}

export interface Interval {
  lower: number;
  upper: number;
}

/** The Wilson score interval of `passed` out of `total` (total above 0). */
export function wilson(passed: number, total: number): Interval & { share: number } {
  const share = passed / total;
  const z2 = Z * Z;
  const denom = 1 + z2 / total;
  const centre = (share + z2 / (2 * total)) / denom;
  const half = (Z * Math.sqrt((share * (1 - share)) / total + z2 / (4 * total * total))) / denom;
  return { share, lower: Math.max(0, centre - half), upper: Math.min(1, centre + half) };
}

/** current - base, with the Newcombe (method 10) bounds. Both sides need at least one attempt. */
export function newcombeDifference(
  current: Proportion,
  base: Proportion,
): Interval & { diff: number } {
  const a = wilson(current.passed, current.total);
  const b = wilson(base.passed, base.total);
  const diff = a.share - b.share;
  return {
    diff,
    lower: diff - Math.sqrt((a.share - a.lower) ** 2 + (b.upper - b.share) ** 2),
    upper: diff + Math.sqrt((a.upper - a.share) ** 2 + (b.share - b.lower) ** 2),
  };
}

/** `worse`: the whole interval is below 0; `better`: above 0; `no-difference`: it holds 0; `too-few`: not enough attempts. */
export type Word = 'worse' | 'better' | 'no-difference' | 'too-few';

export interface Comparison {
  word: Word;
  /** Attempts on each side. */
  current: number;
  base: number;
  /** The minimum that applied. */
  min: number;
  /** In percentage points; absent when the word is `too-few`. */
  diffPp?: number;
  lowerPp?: number;
  upperPp?: number;
  reason: string;
}

const pp = (n: number): number => Math.round(n * 1e4) / 1e2;
const sign = (n: number): string => (n > 0 ? `+${n}` : String(n));

export function compareProportions(
  current: Proportion,
  base: Proportion,
  min: number = MIN_ATTEMPTS,
): Comparison {
  // Zero attempts is never a share: a minimum of 0 (or a nonsense one) does not make it one.
  const floor = Number.isFinite(min) ? Math.max(1, min) : MIN_ATTEMPTS;
  const sides = { current: current.total, base: base.total, min: floor };
  if (current.total < floor || base.total < floor)
    return {
      word: 'too-few',
      ...sides,
      reason: `at least ${floor} attempts are needed on each side (current ${current.total}, baseline ${base.total})`,
    };
  const r = newcombeDifference(current, base);
  const [diffPp, lowerPp, upperPp] = [pp(r.diff), pp(r.lower), pp(r.upper)];
  const word: Word = r.upper < 0 ? 'worse' : r.lower > 0 ? 'better' : 'no-difference';
  return {
    word,
    ...sides,
    diffPp,
    lowerPp,
    upperPp,
    reason: `${current.passed}/${current.total} against ${base.passed}/${base.total}: ${sign(diffPp)} pp, 95% interval ${sign(lowerPp)} to ${sign(upperPp)} pp`,
  };
}
