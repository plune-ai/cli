import { describe, expect, it } from 'vitest';
import { STATUS_PRIORITY, aggregateStatus, type RowStatus } from '../results.js';

// The whole pairwise table, written out by hand: the row is the first child, the column the second.
// It is not derived from STATUS_PRIORITY, so a reordered table fails here.
const ORDER: RowStatus[] = ['passed', 'failed', 'errored', 'blocked', 'skipped'];
const TABLE: Record<RowStatus, RowStatus[]> = {
  //         passed     failed    errored    blocked    skipped
  passed: ['passed', 'failed', 'errored', 'blocked', 'passed'],
  failed: ['failed', 'failed', 'failed', 'failed', 'failed'],
  errored: ['errored', 'failed', 'errored', 'errored', 'errored'],
  blocked: ['blocked', 'failed', 'errored', 'blocked', 'blocked'],
  skipped: ['passed', 'failed', 'errored', 'blocked', 'skipped'],
};

describe('aggregateStatus — the status of a parent from its children', () => {
  for (const a of ORDER) {
    ORDER.forEach((b, i) => {
      const want = TABLE[a][i]!;
      it(`${a} + ${b} → ${want}, in both orders`, () => {
        expect(aggregateStatus([a, b])).toBe(want);
        expect(aggregateStatus([b, a])).toBe(want);
      });
    });
  }

  it('no children → skipped: nothing was judged', () => {
    expect(aggregateStatus([])).toBe('skipped');
  });

  it('one child → that child', () => {
    for (const s of ORDER) expect(aggregateStatus([s])).toBe(s);
  });

  it('does not depend on the order of the children', () => {
    const children: RowStatus[] = ['skipped', 'passed', 'blocked', 'errored'];
    const rotations = children.map((_, i) => [...children.slice(i), ...children.slice(0, i)]);
    for (const r of [...rotations, [...children].reverse()]) expect(aggregateStatus(r)).toBe('errored');
  });

  it('does not depend on duplicates', () => {
    expect(aggregateStatus(['passed', 'passed', 'passed', 'blocked'])).toBe('blocked');
    expect(aggregateStatus(['skipped', 'skipped', 'passed'])).toBe('passed');
    expect(aggregateStatus(['failed', 'errored', 'errored', 'errored'])).toBe('failed');
  });

  it('the table names every status once, worst first', () => {
    expect(STATUS_PRIORITY).toEqual(['failed', 'errored', 'blocked', 'passed', 'skipped']);
  });
});
