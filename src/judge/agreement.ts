// How well a judge agrees with a person, from pairs of verdicts (plune-ai/plune#2888). Pure: no I/O.
//
// "Positive" is `pass`. TPR is the share of the rows a person passed that the judge passed too; TNR the
// share of the rows a person failed that the judge failed too. Cohen's kappa is the agreement above what
// two raters with the same pass rates would reach by chance. Its 95% interval comes from a bootstrap with
// a fixed seed, so two runs on the same pairs print the same interval.

export interface Pair {
  /** What the person said. */
  human: boolean;
  /** What the judge said. */
  judge: boolean;
}

export interface Confusion {
  /** Both pass. */
  tp: number;
  /** The person passed, the judge failed. */
  fn: number;
  /** The person failed, the judge passed. */
  fp: number;
  /** Both fail. */
  tn: number;
}

export interface Interval {
  low: number;
  high: number;
}

export interface Agreement extends Confusion {
  n: number;
  /** Share of pairs where the two agree; `null` with no pairs. */
  agreement: number | null;
  /** `null` when the person passed nothing. */
  tpr: number | null;
  /** `null` when the person failed nothing. */
  tnr: number | null;
  /** `null` when chance agreement is 1 (both raters gave one answer only), where kappa has no value. */
  kappa: number | null;
  /** `null` when kappa has no value, or too few resamples gave one. */
  kappaInterval: Interval | null;
}

export function confusionOf(pairs: readonly Pair[]): Confusion {
  const c: Confusion = { tp: 0, fn: 0, fp: 0, tn: 0 };
  for (const { human, judge } of pairs) {
    if (human) c[judge ? 'tp' : 'fn'] += 1;
    else c[judge ? 'fp' : 'tn'] += 1;
  }
  return c;
}

const ratio = (a: number, b: number): number | null => (b === 0 ? null : a / b);

export function kappaOf({ tp, fn, fp, tn }: Confusion): number | null {
  const n = tp + fn + fp + tn;
  if (n === 0) return null;
  const observed = (tp + tn) / n;
  const chance = ((tp + fp) * (tp + fn) + (fn + tn) * (fp + tn)) / (n * n);
  return chance === 1 ? null : (observed - chance) / (1 - chance);
}

/** A small seeded generator (mulberry32): the same seed gives the same resamples on every machine. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const BOOTSTRAP_RESAMPLES = 2000;
export const BOOTSTRAP_SEED = 2888;

/**
 * The 95% percentile interval of kappa over resamples of the pairs, drawn with replacement. A resample
 * where kappa has no value (all one answer) is left out; when more than half are left out the interval
 * means little, and `null` is returned instead of a number that looks firmer than it is.
 */
export function kappaInterval(
  pairs: readonly Pair[],
  resamples = BOOTSTRAP_RESAMPLES,
  seed = BOOTSTRAP_SEED,
): Interval | null {
  const n = pairs.length;
  if (n === 0) return null;
  const next = seeded(seed);
  const values: number[] = [];
  for (let r = 0; r < resamples; r++) {
    const sample: Pair[] = [];
    for (let i = 0; i < n; i++) sample.push(pairs[Math.floor(next() * n)]!);
    const k = kappaOf(confusionOf(sample));
    if (k !== null) values.push(k);
  }
  if (values.length * 2 < resamples) return null;
  values.sort((a, b) => a - b);
  const at = (q: number): number => values[Math.min(values.length - 1, Math.floor(q * values.length))]!;
  return { low: at(0.025), high: at(0.975) };
}

export function agreementOf(pairs: readonly Pair[]): Agreement {
  const c = confusionOf(pairs);
  const n = pairs.length;
  const kappa = kappaOf(c);
  return {
    ...c,
    n,
    agreement: ratio(c.tp + c.tn, n),
    tpr: ratio(c.tp, c.tp + c.fn),
    tnr: ratio(c.tn, c.tn + c.fp),
    kappa,
    kappaInterval: kappa === null ? null : kappaInterval(pairs),
  };
}
