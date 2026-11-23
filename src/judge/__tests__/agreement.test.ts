import { describe, expect, it } from 'vitest';
import {
  agreementOf,
  confusionOf,
  kappaInterval,
  kappaOf,
  seeded,
  type Pair,
} from '../agreement.js';

/** `tp` pairs both pass, `fn` person pass judge fail, `fp` person fail judge pass, `tn` both fail. */
function pairs(tp: number, fn: number, fp: number, tn: number): Pair[] {
  const of = (n: number, human: boolean, judge: boolean): Pair[] => Array.from({ length: n }, () => ({ human, judge }));
  return [...of(tp, true, true), ...of(fn, true, false), ...of(fp, false, true), ...of(tn, false, false)];
}

describe('judge agreement', () => {
  it('TP=20, FN=5, FP=10, TN=15 gives TPR 0.80, TNR 0.60, agreement 0.70 and kappa 0.40', () => {
    const a = agreementOf(pairs(20, 5, 10, 15));
    expect(a).toMatchObject({ n: 50, tp: 20, fn: 5, fp: 10, tn: 15 });
    expect(a.tpr).toBeCloseTo(0.8, 10);
    expect(a.tnr).toBeCloseTo(0.6, 10);
    expect(a.agreement).toBeCloseTo(0.7, 10);
    // Observed 0.70, chance 0.50: (0.70 - 0.50) / (1 - 0.50).
    expect(a.kappa).toBeCloseTo(0.4, 10);
    expect(a.kappaInterval!.low).toBeLessThan(0.4);
    expect(a.kappaInterval!.high).toBeGreaterThan(0.4);
  });

  it('full agreement gives kappa 1, agreement at the level of chance gives kappa 0', () => {
    expect(kappaOf(confusionOf(pairs(25, 0, 0, 25)))).toBe(1);
    // Each rater passes half, independently of the other.
    expect(kappaOf(confusionOf(pairs(10, 10, 10, 10)))).toBeCloseTo(0, 10);
  });

  it('one class only, or no pairs: n/a, never NaN or a throw', () => {
    const allPass = agreementOf(pairs(30, 0, 0, 0));
    expect(allPass.kappa).toBeNull();
    expect(allPass.kappaInterval).toBeNull();
    expect(allPass.tnr).toBeNull();
    expect(allPass.tpr).toBe(1);

    const none = agreementOf([]);
    expect(none).toMatchObject({ n: 0, agreement: null, tpr: null, tnr: null, kappa: null, kappaInterval: null });
    expect(kappaInterval([])).toBeNull();
  });

  it('the same error rates on 200 pairs give a narrower interval than on 50', () => {
    const width = (p: Pair[]): number => {
      const iv = agreementOf(p).kappaInterval!;
      return iv.high - iv.low;
    };
    expect(width(pairs(80, 20, 40, 60))).toBeLessThan(width(pairs(20, 5, 10, 15)));
  });

  it('with the fixed seed two runs print the same interval; another seed draws other resamples', () => {
    const p = pairs(20, 5, 10, 15);
    expect(kappaInterval(p)).toEqual(kappaInterval(p));
    const a = seeded(1);
    const b = seeded(2);
    expect([a(), a()]).not.toEqual([b(), b()]);
    expect(seeded(7)()).toBe(seeded(7)());
  });

  it('no interval when most resamples have one answer only', () => {
    // Every resample of one pair is that pair again: one answer on each side, no kappa in any of them.
    expect(kappaInterval(pairs(1, 0, 0, 0), 200)).toBeNull();
    // Two pairs, one of each: about half the resamples hold one answer only, and the rest give kappa 1.
    const iv = kappaInterval(pairs(1, 0, 0, 1), 2000);
    expect(iv === null || (iv.low === 1 && iv.high === 1)).toBe(true);
  });
});
