import { describe, expect, it } from 'vitest';
import {
  compareJson,
  ExpectedJsonError,
  validateExpected,
  MAX_EXPECTED_DEPTH,
  MAX_MATCH_STEPS,
} from '../compare.js';
import type { CompareMode, Mismatch } from '../compare.js';

const MODES: CompareMode[] = ['exact', 'unordered', 'contains'];

/** `path reason` of every mismatch, in order: enough to read a failure at a glance. */
const summary = (list: Mismatch[]): string[] => list.map((m) => `${m.path} ${m.reason}`);
const equal = (expected: unknown, actual: unknown, mode: CompareMode): boolean =>
  compareJson(expected, actual, { mode }).length === 0;

// --- A small seeded generator of JSON values: the properties below need no dependency ---

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const KEYS = ['a', 'b', 'c', 'd', 'e'];
const WORDS = ['', 'x', 'y', 'John Doe', 'user@plune.ai'];
const pick = <T>(rand: () => number, items: readonly T[]): T => items[Math.floor(rand() * items.length)]!;

/** Small alphabets on purpose: equal elements and equal keys must be common, or the matching is never tested. */
function genJson(rand: () => number, depth = 3): unknown {
  const kind = Math.floor(rand() * (depth > 0 ? 6 : 4));
  if (kind === 0) return null;
  if (kind === 1) return rand() < 0.5;
  if (kind === 2) return Math.floor(rand() * 4);
  if (kind === 3) return pick(rand, WORDS);
  if (kind === 4) return Array.from({ length: Math.floor(rand() * 4) }, () => genJson(rand, depth - 1));
  const obj: Record<string, unknown> = {};
  for (const key of KEYS) if (rand() < 0.5) obj[key] = genJson(rand, depth - 1);
  return obj;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** A deep copy with every array shuffled. */
function shuffled(value: unknown, rand: () => number): unknown {
  if (Array.isArray(value)) {
    const out = value.map((v) => shuffled(v, rand));
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shuffled(v, rand)]));
  return value;
}

/** A deep copy with keys dropped at random, at every depth. */
function withKeysRemoved(value: unknown, rand: () => number): unknown {
  if (Array.isArray(value)) return value.map((v) => withKeysRemoved(v, rand));
  if (isObject(value))
    return Object.fromEntries(
      Object.entries(value)
        .filter(() => rand() < 0.7)
        .map(([k, v]) => [k, withKeysRemoved(v, rand)]),
    );
  return value;
}

/** A copy that differs a little: a shuffle, a dropped key, or nothing. Gives pairs that pass some modes only. */
function nearby(value: unknown, rand: () => number): unknown {
  const r = rand();
  if (r < 0.3) return value;
  if (r < 0.6) return shuffled(value, rand);
  if (r < 0.8) return withKeysRemoved(value, rand);
  return genJson(rand, 2);
}

const RUNS = 300;

describe('json-verify · compare · the three modes at each JSON type', () => {
  it.each<[string, unknown]>([
    ['null', null],
    ['true', true],
    ['false', false],
    ['a number', 12.5],
    ['zero', 0],
    ['a string', 'John Doe'],
    ['an empty string', ''],
    ['an empty array', []],
    ['an array', [1, 'a', null, [2]]],
    ['an empty object', {}],
    ['an object', { a: 1, b: { c: [true] } }],
  ])('%s equals itself in every mode', (_name, value) => {
    for (const mode of MODES) expect(compareJson(value, value, { mode }), mode).toEqual([]);
  });

  it.each<[string, unknown, unknown]>([
    ['null against false', null, false],
    ['a number against its string', 1, '1'],
    ['zero against null', 0, null],
    ['an array against an object', [], {}],
    ['an object against null', {}, null],
    ['a string against an array of it', 'a', ['a']],
  ])('%s is a type mismatch in every mode', (_name, expected, actual) => {
    for (const mode of MODES)
      expect(compareJson(expected, actual, { mode }), mode).toEqual([{ path: '$', reason: 'type', expected, actual }]);
  });

  it.each<[string, unknown, unknown]>([
    ['booleans', true, false],
    ['numbers', 1, 2],
    ['strings', 'a', 'A'],
  ])('different %s are a value mismatch in every mode', (_name, expected, actual) => {
    for (const mode of MODES)
      expect(compareJson(expected, actual, { mode }), mode).toEqual([{ path: '$', reason: 'value', expected, actual }]);
  });

  it('the default mode is exact', () => {
    expect(summary(compareJson({ a: 1 }, { a: 1, b: 2 }))).toEqual(['$.b extra-key']);
  });
});

describe('json-verify · compare · objects', () => {
  it('a missing key is named with its path, in every mode', () => {
    for (const mode of MODES)
      expect(compareJson({ a: { b: 1 } }, { a: {} }, { mode }), mode).toEqual([
        { path: '$.a.b', reason: 'missing-key', expected: 1 },
      ]);
  });

  it('an extra key fails exact and unordered, and is fine in contains', () => {
    const extra = [{ path: '$.b', reason: 'extra-key', actual: 2 }];
    expect(compareJson({ a: 1 }, { a: 1, b: 2 }, { mode: 'exact' })).toEqual(extra);
    expect(compareJson({ a: 1 }, { a: 1, b: 2 }, { mode: 'unordered' })).toEqual(extra);
    expect(compareJson({ a: 1 }, { a: 1, b: 2 }, { mode: 'contains' })).toEqual([]);
  });

  it('the order of keys never matters', () => {
    for (const mode of MODES) expect(equal({ a: 1, b: 2 }, { b: 2, a: 1 }, mode), mode).toBe(true);
  });

  it('a key present with null is not a missing key', () => {
    expect(summary(compareJson({ a: 1 }, { a: null }, { mode: 'contains' }))).toEqual(['$.a type']);
  });

  it('an inherited property is not a key of the answer', () => {
    expect(summary(compareJson({ toString: 1 }, {}, { mode: 'contains' }))).toEqual(['$.toString missing-key']);
  });

  it('a key that is not a plain name is quoted in the path', () => {
    expect(summary(compareJson({ 'a b': { '0': 1 } }, { 'a b': { '0': 2 } }))).toEqual(['$["a b"]["0"] value']);
  });

  it('mismatches come in the order of the expected keys, then the extra keys of the answer', () => {
    const got = compareJson({ z: 1, a: { k: 1 }, m: 1 }, { y: 0, m: 2, a: { k: 2, x: 0 }, z: 1 });
    expect(summary(got)).toEqual(['$.a.k value', '$.a.x extra-key', '$.m value', '$.y extra-key']);
  });
});

describe('json-verify · compare · arrays', () => {
  it('exact: the order matters', () => {
    expect(summary(compareJson([1, 2], [2, 1]))).toEqual(['$[0] value', '$[1] value']);
  });

  it('exact: a shorter answer misses elements, a longer one has extra elements', () => {
    expect(compareJson([1, 2, 3], [1])).toEqual([
      { path: '$[1]', reason: 'missing-element', expected: 2 },
      { path: '$[2]', reason: 'missing-element', expected: 3 },
    ]);
    expect(compareJson([1], [1, 2])).toEqual([{ path: '$[1]', reason: 'extra-element', actual: 2 }]);
  });

  it('unordered: any order, the same elements with the same counts', () => {
    expect(equal([1, 2, 2, 'a'], [2, 'a', 1, 2], 'unordered')).toBe(true);
    expect(compareJson([1, 2, 2], [2, 1, 1], { mode: 'unordered' })).toEqual([
      { path: '$[2]', reason: 'no-match', expected: 2 },
      { path: '$[2]', reason: 'extra-element', actual: 1 },
    ]);
  });

  it('unordered: a longer answer is not equal', () => {
    expect(summary(compareJson([1], [1, 1], { mode: 'unordered' }))).toEqual(['$[1] extra-element']);
  });

  it('unordered: extra keys inside an element still fail', () => {
    expect(equal([{ a: 1 }], [{ a: 1, b: 2 }], 'unordered')).toBe(false);
  });

  it('contains: every expected element is found, extras are fine, order is free', () => {
    expect(equal([3, 1], [1, 2, 3], 'contains')).toBe(true);
    expect(compareJson([1, 4], [1, 2, 3], { mode: 'contains' })).toEqual([
      { path: '$[1]', reason: 'no-match', expected: 4 },
    ]);
  });

  it('contains: one element of the answer serves one expected element only', () => {
    expect(summary(compareJson([1, 1], [1, 2], { mode: 'contains' }))).toEqual(['$[1] no-match']);
  });

  it('contains: the mode goes down into the elements', () => {
    expect(equal({ rows: [{ id: 2 }] }, { rows: [{ id: 1, x: 0 }, { id: 2, x: 0 }], n: 2 }, 'contains')).toBe(true);
  });

  it('1 does not match "1" or true inside an array', () => {
    for (const mode of ['unordered', 'contains'] as const) {
      expect(equal([1], ['1'], mode), mode).toBe(false);
      expect(equal([1], [true], mode), mode).toBe(false);
      expect(equal([null], [0], mode), mode).toBe(false);
    }
  });
});

describe('json-verify · compare · matching of elements that fit more than one way', () => {
  it('a partial object that fits two elements does not take the only one another needs', () => {
    // First-fit gives {a:1} the first element and leaves {a:1,b:2} with nothing.
    expect(equal([{ a: 1 }, { a: 1, b: 2 }], [{ a: 1, b: 2 }, { a: 1 }], 'contains')).toBe(true);
    expect(equal([{ a: 1 }, { a: 1, b: 2 }], [{ a: 1, b: 2 }, { a: 1, c: 3 }, { z: 0 }], 'contains')).toBe(true);
  });

  it('a chain of three is re-assigned as far as it needs', () => {
    const expected = [{ a: 1 }, { b: 2 }, { c: 3 }];
    const actual = [
      { a: 1, b: 2, c: 3 },
      { a: 1, b: 2 },
      { a: 1 },
    ];
    expect(equal(expected, actual, 'contains')).toBe(true);
  });

  it('when no assignment covers all, exactly the uncovered count is reported', () => {
    const got = compareJson([{ a: 1 }, { a: 1 }, { b: 2 }], [{ a: 1, b: 2 }, { b: 2 }, { c: 0 }], { mode: 'contains' });
    expect(summary(got)).toEqual(['$[1] no-match']);
  });

  it('nested arrays are matched with the same rule', () => {
    expect(equal([[1, 2], [2]], [[2], [2, 1]], 'unordered')).toBe(true);
    expect(equal([[2], [1, 2]], [[2, 1, 0], [2, 0]], 'contains')).toBe(true);
  });

  it('a large array of scalars is matched without comparing every pair', () => {
    const n = 200_000;
    const expected = Array.from({ length: n }, (_, i) => (i % 2 === 0 ? i : `s${i}`));
    const actual = [...expected].reverse();
    const started = Date.now();
    expect(compareJson(expected, actual, { mode: 'unordered' })).toEqual([]);
    expect(summary(compareJson([...expected, -1], actual, { mode: 'contains' }))).toEqual([`$[${n}] no-match`]);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('arrays of arrays of objects, 100 by 100, are matched in well under two seconds', () => {
    const grid = (shift: number): unknown[] =>
      Array.from({ length: 100 }, (_, i) => Array.from({ length: 100 }, (_, j) => ({ id: i * 100 + ((j + shift) % 100) })));
    for (const mode of ['unordered', 'contains'] as const) {
      const started = Date.now();
      expect(compareJson(grid(0), grid(0), { mode }), mode).toEqual([]);
      expect(compareJson(grid(0), grid(1), { mode }), mode).toEqual([]);
      expect(compareJson(grid(0), [...grid(7)].reverse(), { mode }), mode).toEqual([]);
      expect(Date.now() - started, mode).toBeLessThan(2000);
    }
  });

  it('a probe stops at the first element with no match', () => {
    // 300 rows of which none fits: without the stop each of the 300 x 300 pairs is compared for every row.
    const rows = (tag: string): unknown[] => Array.from({ length: 300 }, (_, i) => [{ id: i, tag }, { n: i }]);
    const started = Date.now();
    const got = compareJson([rows('a'), 1], [rows('b'), 1], { mode: 'unordered' });
    expect(summary(got)).toEqual(['$[0] no-match', '$[0] extra-element']);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('a probe gives up on arrays whose lengths cannot match', () => {
    const big = Array.from({ length: 2000 }, (_, i) => ({ i }));
    const started = Date.now();
    // unordered: any other length; contains: a shorter answer.
    expect(summary(compareJson([big], [big.slice(1)], { mode: 'unordered' }))).toEqual(['$[0] no-match', '$[0] extra-element']);
    expect(summary(compareJson([big], [[...big, { i: -1 }]], { mode: 'unordered' }))).toEqual(['$[0] no-match', '$[0] extra-element']);
    expect(summary(compareJson([big], [big.slice(1)], { mode: 'contains' }))).toEqual(['$[0] no-match']);
    expect(compareJson([big.slice(1)], [big], { mode: 'contains' })).toEqual([]);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('the work of matching has one limit for the whole comparison, and past it the reason is too-large', () => {
    // Rows that differ only in a nested value: nothing cheap tells them apart, so every pair is compared.
    // Each array alone is far under the limit, all of them together are over it.
    const side = Math.ceil(Math.sqrt(MAX_MATCH_STEPS / 8));
    const rows = (k: number): unknown[] => Array.from({ length: side }, (_, i) => ({ kind: 'row', at: [k, i] }));
    const expected = Array.from({ length: 20 }, (_, k) => rows(k));
    const started = Date.now();
    const got = compareJson({ data: expected }, { data: expected.map((r) => [...r].reverse()) }, { mode: 'unordered' });
    expect(got).toEqual([
      {
        path: '$.data',
        reason: 'too-large',
        detail: `matching arrays in any order took more than ${MAX_MATCH_STEPS} comparisons of elements`,
      },
    ]);
    // About a second and a half plain; several times that when the run is instrumented for coverage.
    expect(Date.now() - started).toBeLessThan(15_000);
    // One such array alone is within the limit, and the same data in order is an exact comparison with none.
    expect(compareJson(rows(0), [...rows(0)].reverse(), { mode: 'unordered' })).toEqual([]);
    expect(compareJson({ data: expected }, { data: expected }, { mode: 'exact' })).toEqual([]);
  });

  it('a pair is charged once: asking again about it while elements are moved costs nothing', () => {
    // 1,500 rows that every candidate fits, so each new row asks about every taken place before a free one.
    const n = 1500;
    expect(n * n).toBeGreaterThan(MAX_MATCH_STEPS);
    const expected = Array.from({ length: n }, () => ({ tags: ['a'] }));
    const actual = Array.from({ length: n }, (_, i) => ({ tags: ['a'], i }));
    expect(compareJson(expected, actual, { mode: 'contains' })).toEqual([]);
  });

  it.each(['unordered', 'contains'] as const)(
    '%s: 300 shuffled objects with 12 nested objects each are equal, whatever the order of the keys',
    (mode) => {
      const rand = rng(11);
      const item = (i: number, j: number): unknown => ({ parts: [{ p: 1 }, { p: 2 }, { p: 3 }], qty: j, sku: `s${i}-${j}` });
      const order = (i: number, idFirst: boolean): unknown => {
        const items = Array.from({ length: 12 }, (_, j) => item(i, j));
        return idFirst ? { id: i, items } : { items, id: i };
      };
      for (const idFirst of [true, false]) {
        const expected = Array.from({ length: 300 }, (_, i) => order(i, idFirst));
        const started = Date.now();
        expect(compareJson(expected, shuffled(expected, rand), { mode }), `id first: ${idFirst}`).toEqual([]);
        expect(Date.now() - started).toBeLessThan(2000);
      }
    },
  );

  it.each([2000, 2100, 6000])('%i flat shuffled objects of 10 keys are equal, in both orders of the keys', (n) => {
    const rand = rng(12);
    const row = (i: number, reversed: boolean): unknown => {
      const entries: [string, unknown][] = [['type', 'row'], ['ok', true], ['id', i], ['name', `n${i % 7}`]];
      for (let k = 0; k < 6; k++) entries.push([`f${k}`, (i + k) % 3]);
      return Object.fromEntries(reversed ? entries.reverse() : entries);
    };
    for (const reversed of [false, true]) {
      const expected = Array.from({ length: n }, (_, i) => row(i, reversed));
      const actual = shuffled(Array.from({ length: n }, (_, i) => row(i, !reversed)), rand);
      const started = Date.now();
      expect(compareJson(expected, actual, { mode: 'unordered' }), `reversed: ${reversed}`).toEqual([]);
      expect(Date.now() - started).toBeLessThan(2000);
    }
  });

  it('one shuffled row that differs is the only mismatch among thousands', () => {
    const rand = rng(13);
    const rows = Array.from({ length: 3000 }, (_, i) => ({ type: 'row', id: i, v: [i] }));
    const actual = shuffled(rows.map((r) => (r.id === 1234 ? { ...r, v: [0] } : r)), rand) as { id: number }[];
    expect(summary(compareJson(rows, actual, { mode: 'unordered' }))).toEqual([
      '$[1234] no-match',
      `$[${actual.findIndex((r) => r.id === 1234)}] extra-element`,
    ]);
  });

  it('a long chain of elements that each must give up their place is matched, at any length', () => {
    // Row i fits answer i and answer i + 1; the last expected element fits answer 0 only, so every row moves up one.
    const chain = (n: number): [unknown[], unknown[]] => [
      [...Array.from({ length: n }, (_, i) => ({ [`k${i}`]: 1 })), { z: 1 }],
      Array.from({ length: n + 1 }, (_, j) => ({ [`k${j}`]: 1, ...(j === 0 ? { z: 1 } : { [`k${j - 1}`]: 1 }) })),
    ];
    for (const n of [10, 1100, 20_000]) expect(compareJson(...chain(n), { mode: 'contains' }), String(n)).toEqual([]);
    // The same chain with no free place at its end: every row is tried, and one is left over.
    const [expected, actual] = chain(1100);
    expect(summary(compareJson(expected, actual.slice(0, -1), { mode: 'contains' }))).toHaveLength(1);
  });

  it('elements that cheap fields cannot tell apart are still matched: checks, markers, nested values only', () => {
    expect(equal([{ a: '@gt(1)' }, { a: '@gt(5)' }], [{ a: 9 }, { a: 2 }], 'unordered')).toBe(true);
    expect(equal([{ $mode: 'contains', $value: { a: 1 } }, { a: 1, b: 2 }], [{ a: 1, b: 2 }, { a: 1, c: 3 }], 'unordered')).toBe(true);
    expect(equal([{ $literal: { a: '@x' } }, { a: '@@x', b: 1 }], [{ a: '@x', b: 1 }, { a: '@x' }], 'unordered')).toBe(true);
    expect(equal([{ v: [1] }, { v: [2] }], [{ v: [2] }, { v: [1] }], 'unordered')).toBe(true);
    expect(equal([{ a: 1 }, { a: '1' }, { a: null }], [{ a: null }, { a: 1 }, { a: '1' }], 'unordered')).toBe(true);
    expect(equal([{ a: 1 }], [[1]], 'contains')).toBe(false);
    expect(equal([{ a: 1 }], [{ a: { b: 1 } }], 'contains')).toBe(false);
  });

  it('rows told apart by more distinct keys than are indexed are still matched', () => {
    const expected = Array.from({ length: 120 }, (_, i) => ({ [`key${i}`]: i }));
    const actual = [...expected].reverse().map((row, i) => ({ ...row, extra: i }));
    expect(compareJson(expected, actual, { mode: 'contains' })).toEqual([]);
    expect(summary(compareJson(expected, actual.slice(1), { mode: 'contains' }))).toEqual(['$[119] no-match']);
  });

  it('scalars do not count toward the limit', () => {
    const scalars = Array.from({ length: 50_000 }, (_, i) => i);
    expect(equal([{ id: 1 }, ...scalars], [...scalars, { id: 1, x: 2 }], 'contains')).toBe(true);
  });
});

describe('json-verify · compare · the mode marker and its escape', () => {
  it('{$mode, $value} changes the mode for that node and everything under it', () => {
    const expected = { id: 1, tags: { $mode: 'unordered', $value: ['a', 'b'] }, meta: { $mode: 'contains', $value: { k: [{ x: 1 }] } } };
    expect(compareJson(expected, { id: 1, tags: ['b', 'a'], meta: { k: [{ x: 1, y: 2 }], more: true } })).toEqual([]);
    // Outside the markers the comparison is still exact.
    expect(summary(compareJson(expected, { id: 1, tags: ['b', 'a'], meta: { k: [{ x: 1 }] }, extra: 0 }))).toEqual([
      '$.extra extra-key',
    ]);
  });

  it('a marker can make a part stricter than the whole', () => {
    const expected = { user: { $mode: 'exact', $value: { name: 'John Doe' } } };
    expect(summary(compareJson(expected, { user: { name: 'John Doe', age: 1 }, more: 1 }, { mode: 'contains' }))).toEqual([
      '$.user.age extra-key',
    ]);
  });

  it('a marker works on an element of an unordered array and at the root', () => {
    expect(equal([{ $mode: 'contains', $value: { a: 1 } }, 2], [2, { a: 1, b: 2 }], 'unordered')).toBe(true);
    expect(equal({ $mode: 'contains', $value: { a: 1 } }, { a: 1, b: 2 }, 'exact')).toBe(true);
  });

  it('the marker adds nothing to the path', () => {
    expect(summary(compareJson({ a: { $mode: 'contains', $value: { b: 1 } } }, { a: { b: 2 } }))).toEqual(['$.a.b value']);
  });

  it('{$literal} is the escape: what is under it is plain data, markers included', () => {
    const data = { $mode: 'contains', $value: { a: 1 } };
    expect(compareJson({ $literal: data }, data)).toEqual([]);
    expect(summary(compareJson({ $literal: data }, { a: 1 }))).toEqual(['$.$mode missing-key', '$.$value missing-key', '$.a extra-key']);
    expect(compareJson({ cfg: { $literal: { $literal: 1 } } }, { cfg: { $literal: 1 } })).toEqual([]);
  });

  it('$literal keeps the mode around it', () => {
    expect(equal({ $literal: { a: [1, 2] } }, { a: [2, 1], b: 0 }, 'contains')).toBe(true);
    expect(equal({ $literal: { a: [1, 2] } }, { a: [2, 1] }, 'exact')).toBe(false);
  });

  it.each<[string, unknown, string]>([
    ['$mode beside other keys', { a: { $mode: 'contains', $value: 1, more: 2 } }, '$.a'],
    ['$mode without $value', { a: [{ $mode: 'contains' }] }, '$.a[0]'],
    ['an unknown mode', { $mode: 'loose', $value: 1 }, '$'],
    ['$literal beside other keys', { $literal: 1, a: 2 }, '$'],
  ])('%s is an error of the expected value, with its path', (_name, expected, path) => {
    let thrown: unknown;
    try {
      compareJson(expected, {}, { mode: 'contains' });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ExpectedJsonError);
    expect((thrown as ExpectedJsonError).path).toBe(path);
    expect(validateExpected(expected).map((i) => i.path)).toEqual([path]);
  });

  it('the error says how to write the data literally', () => {
    expect(validateExpected({ $mode: 'loose', $value: 1 })).toEqual([
      { path: '$', message: '$mode must be one of exact, unordered, contains; got "loose"' },
    ]);
    expect(validateExpected({ $mode: 'exact' })[0]!.message).toBe(
      'an object with $mode must have exactly the keys $mode and $value; data with a key $mode goes inside {"$literal": ...}',
    );
    expect(validateExpected({ $literal: 1, a: 2 })[0]!.message).toBe(
      'an object with $literal must have no other key; data with a key $literal goes inside {"$literal": ...}',
    );
  });

  it('an expected value nested too deep is an error of the expected value, under $literal too', () => {
    const nested = (depth: number): unknown => {
      let v: unknown = 1;
      for (let n = 0; n < depth; n++) v = n % 2 === 0 ? [v] : { a: v };
      return v;
    };
    expect(validateExpected(nested(MAX_EXPECTED_DEPTH))).toEqual([]);
    expect(compareJson(nested(MAX_EXPECTED_DEPTH), nested(MAX_EXPECTED_DEPTH), { mode: 'unordered' })).toEqual([]);
    for (const expected of [nested(MAX_EXPECTED_DEPTH + 1), { $literal: nested(MAX_EXPECTED_DEPTH) }, nested(50_000)]) {
      const issues = validateExpected(expected);
      expect(issues).toHaveLength(1);
      expect(issues[0]!.message).toBe(`expected is nested deeper than ${MAX_EXPECTED_DEPTH} levels`);
      expect(() => compareJson(expected, 1)).toThrow(ExpectedJsonError);
    }
    // Markers count as levels: a chain of them cannot go deeper than data can.
    let marked: unknown = 1;
    for (let n = 0; n <= MAX_EXPECTED_DEPTH; n++) marked = { $mode: 'contains', $value: marked };
    expect(validateExpected(marked)).toEqual([{ path: '$', message: `expected is nested deeper than ${MAX_EXPECTED_DEPTH} levels` }]);
  });

  it('a value that is not JSON is an error of the expected value, under $literal too', () => {
    const messages = (expected: unknown): string[] => validateExpected(expected).map((i) => `${i.path}: ${i.message}`);
    expect(messages({ a: undefined, b: [NaN, -Infinity], c: 10n, d: () => 1 })).toEqual([
      '$.a: undefined is not a JSON value',
      '$.b[0]: NaN is not a JSON value',
      '$.b[1]: -Infinity is not a JSON value',
      '$.c: a bigint is not a JSON value',
      '$.d: a function is not a JSON value',
    ]);
    expect(messages({ when: new Date(0), list: new Map(), made: Object.create({ inherited: 1 }) as unknown })).toEqual([
      '$.when: an object that is not plain JSON data',
      '$.list: an object that is not plain JSON data',
      '$.made: an object that is not plain JSON data',
    ]);
    expect(messages({ $literal: [NaN, new Date(0)] })).toEqual([
      '$[0]: NaN is not a JSON value',
      '$[1]: an object that is not plain JSON data',
    ]);
    expect(messages(JSON.parse('{"a":{"__proto__":1},"b":{"$literal":{"__proto__":{}}}}'))).toEqual([
      '$.a.__proto__: the key __proto__ is not supported in expected',
      '$.b.__proto__: the key __proto__ is not supported in expected',
    ]);
    const bare = Object.assign(Object.create(null) as Record<string, unknown>, { a: 1 });
    expect(messages(bare)).toEqual([]);
    expect(compareJson(bare, { a: 1 })).toEqual([]);
  });

  it('validateExpected finds every error, and none inside $literal or in plain data', () => {
    const expected = {
      ok: { $mode: 'contains', $value: { deep: { $mode: 'nope', $value: 1 } } },
      list: [1, { $literal: 1, x: 1 }],
      quiet: { $literal: { $mode: 'nope' } },
      $value: 'not reserved alone',
    };
    expect(validateExpected(expected).map((i) => i.path)).toEqual(['$.ok.deep', '$.list[1]']);
    expect(validateExpected([null, 1, 'a', { a: [] }])).toEqual([]);
  });
});

describe('json-verify · compare · properties over generated values', () => {
  it('a value equals itself in every mode', () => {
    const rand = rng(1);
    for (let i = 0; i < RUNS; i++) {
      const v = genJson(rand);
      for (const mode of MODES) expect(compareJson(v, v, { mode }), `${mode} ${JSON.stringify(v)}`).toEqual([]);
    }
  });

  it('exact implies unordered implies contains', () => {
    const rand = rng(2);
    const seen = { exact: 0, unordered: 0, contains: 0, none: 0 };
    for (let i = 0; i < RUNS * 3; i++) {
      const actual = genJson(rand);
      const expected = nearby(actual, rand);
      const [exact, unordered, contains] = MODES.map((mode) => equal(expected, actual, mode));
      const label = JSON.stringify({ expected, actual });
      if (exact) expect(unordered, label).toBe(true);
      if (unordered) expect(contains, label).toBe(true);
      seen[exact ? 'exact' : unordered ? 'unordered' : contains ? 'contains' : 'none']++;
    }
    // The generator must reach every rung, or the implications above were checked on nothing.
    for (const [rung, n] of Object.entries(seen)) expect(n, rung).toBeGreaterThan(20);
  });

  it('shuffling the arrays keeps unordered equal', () => {
    const rand = rng(3);
    for (let i = 0; i < RUNS; i++) {
      const v = genJson(rand, 4);
      const s = shuffled(v, rand);
      const label = JSON.stringify({ v, s });
      expect(compareJson(v, s, { mode: 'unordered' }), label).toEqual([]);
      expect(compareJson(s, v, { mode: 'unordered' }), label).toEqual([]);
    }
  });

  it('removing keys from the expected keeps contains equal, shuffled or not', () => {
    const rand = rng(4);
    for (let i = 0; i < RUNS; i++) {
      const v = genJson(rand, 4);
      const less = withKeysRemoved(v, rand);
      expect(compareJson(less, v, { mode: 'contains' }), JSON.stringify({ less, v })).toEqual([]);
      const mixed = shuffled(less, rand);
      expect(compareJson(mixed, v, { mode: 'contains' }), JSON.stringify({ mixed, v })).toEqual([]);
    }
  });

  it('a value under $literal equals itself, whatever it holds', () => {
    const rand = rng(5);
    const wrap = (v: unknown): unknown => (rand() < 0.5 ? { $mode: 'contains', $value: v } : { $literal: v });
    for (let i = 0; i < RUNS; i++) {
      const v = wrap(wrap(genJson(rand)));
      for (const mode of MODES) expect(compareJson({ $literal: v }, v, { mode }), JSON.stringify(v)).toEqual([]);
    }
  });

  it('the same input gives the same mismatches', () => {
    const rand = rng(6);
    for (let i = 0; i < RUNS; i++) {
      const expected = genJson(rand);
      const actual = genJson(rand);
      for (const mode of MODES)
        expect(compareJson(expected, actual, { mode })).toEqual(compareJson(expected, actual, { mode }));
    }
  });
});
