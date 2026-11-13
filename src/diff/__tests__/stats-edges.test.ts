import { describe, expect, it } from 'vitest';
import { compareProportions, fmtPp, wordFor } from '../stats.js';

const p = (passed: number, total: number) => ({ passed, total });

describe('CLI · diff · advice · edges of the verdict', () => {
  it('CLI · diff · advice · counts that are not whole numbers, are negative or exceed the total are "too few", with no NaN in the text', () => {
    const bad = [
      p(Number.NaN, 10),
      p(1.5, 10),
      p(-1, 10),
      p(11, 10),
      p(3, Number.NaN),
      p(3, Infinity),
      p(0, -2),
    ];
    for (const x of bad) {
      for (const [cur, base] of [
        [x, p(9, 10)],
        [p(9, 10), x],
      ] as const) {
        const r = compareProportions(cur, base);
        expect(r.word).toBe('too-few');
        expect(r.reason).not.toMatch(/NaN|Infinity|undefined/);
      }
    }
  });

  it('CLI · diff · advice · an interval that touches 0 exactly is "no difference", from either side', () => {
    expect(wordFor(0, 0.25)).toBe('no-difference');
    expect(wordFor(-0.25, 0)).toBe('no-difference');
    expect(wordFor(1e-13, 0.2)).toBe('no-difference');
    expect(wordFor(1e-6, 0.2)).toBe('better');
    expect(wordFor(-0.2, -1e-6)).toBe('worse');
  });

  it('CLI · diff · advice · a bound that rounds to 0 is shown with one more figure when the word is better or worse, never as "0"', () => {
    expect(fmtPp(0.000012, true)).toBe('+0.0012');
    expect(fmtPp(-0.000012, true)).toBe('-0.0012');
    expect(fmtPp(0.000012, false)).toBe('0');
    expect(fmtPp(0.25, true)).toBe('+25');
    expect(fmtPp(-0.1234, true)).toBe('-12.34');
    expect(fmtPp(0, false)).toBe('0');
  });

  it('CLI · diff · advice · attempts that were not measured are named on the line', () => {
    const r = compareProportions(
      { passed: 9, total: 10, unmeasured: 0 },
      { passed: 4, total: 4, unmeasured: 6 },
    );
    expect(r.word).toBe('too-few');
    expect(r.reason).toContain('not measured');
    expect(r.reason).toMatch(/current 0.*baseline 6/);
  });
});
