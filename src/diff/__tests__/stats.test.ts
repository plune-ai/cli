import * as fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MIN_ATTEMPTS, compareProportions, newcombeDifference, wilson } from '../stats.js';

interface Fixture {
  cases: {
    current: [number, number];
    base: [number, number];
    diff: number;
    lower: number;
    upper: number;
  }[];
}
// Made by an independent program (see `_meta` in the file), not by the formula under test.
const fixture = JSON.parse(
  fs.readFileSync(new URL('./fixtures/newcombe.json', import.meta.url), 'utf8'),
) as Fixture;

const p = (passed: number, total: number) => ({ passed, total });

describe('CLI · diff · advice · interval of a difference of two shares', () => {
  it('CLI · diff · advice · the bounds match the external fixture to 1e-9, 0/n and n/n included', () => {
    expect(fixture.cases.length).toBeGreaterThan(10);
    for (const c of fixture.cases) {
      const got = newcombeDifference(p(...c.current), p(...c.base));
      expect(got.diff).toBeCloseTo(c.diff, 12);
      expect(Math.abs(got.lower - c.lower)).toBeLessThan(1e-9);
      expect(Math.abs(got.upper - c.upper)).toBeLessThan(1e-9);
    }
    expect(fixture.cases.some((c) => c.current[0] === 0 || c.base[0] === c.base[1])).toBe(true);
    expect(fixture.cases.some((c) => c.current[1] !== c.base[1])).toBe(true);
  });

  it('CLI · diff · advice · a Wilson interval stays inside 0..1 at the ends', () => {
    expect(wilson(0, 5).lower).toBe(0);
    expect(wilson(5, 5).upper).toBeCloseTo(1, 12);
  });

  it('CLI · diff · advice · 9/10 → 4/10 is worse, 9/10 → 8/10 shows no difference', () => {
    expect(compareProportions(p(4, 10), p(9, 10)).word).toBe('worse');
    expect(compareProportions(p(8, 10), p(9, 10)).word).toBe('no-difference');
    expect(compareProportions(p(10, 10), p(4, 10)).word).toBe('better');
  });

  it('CLI · diff · advice · too few attempts is its own word, never "no difference", and names the minimum and the counts', () => {
    const r = compareProportions(p(0, 2), p(2, 2));
    expect(r.word).toBe('too-few');
    expect(r).toMatchObject({ min: MIN_ATTEMPTS, current: 2, base: 2 });
    expect(r.reason).toContain(`${MIN_ATTEMPTS}`);
    expect(r.reason).toMatch(/current 2.*baseline 2/);
    expect(compareProportions(p(5, 5), p(2, 4)).word).toBe('too-few'); // one side short is enough
  });

  it('CLI · diff · advice · a side with no attempts is too few, and a minimum of 0 does not unlock it', () => {
    for (const min of [undefined, 0, -3, Number.NaN]) {
      expect(compareProportions(p(0, 0), p(9, 10), min).word).toBe('too-few');
      expect(compareProportions(p(9, 10), p(0, 0), min).word).toBe('too-few');
    }
    expect(compareProportions(p(0, 0), p(0, 0), 0).word).toBe('too-few');
  });

  it('CLI · diff · advice · 2 repeats can never say "worse"', () => {
    expect(compareProportions(p(0, 2), p(2, 2)).word).toBe('too-few');
    expect(compareProportions(p(0, 4), p(4, 4)).word).toBe('too-few');
  });
});
