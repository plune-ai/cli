import { describe, expect, it } from 'vitest';
import { compareJson } from '../compare.js';
import { formatMismatches, MAX_FRAGMENT, MAX_LISTED } from '../format.js';

const text = (expected: unknown, actual: unknown, mode: 'exact' | 'unordered' | 'contains' = 'exact'): string =>
  formatMismatches(compareJson(expected, actual, { mode }));

describe('json-verify · format · the mismatch text', () => {
  it('no mismatch is an empty text', () => {
    expect(text({ a: 1 }, { a: 1 })).toBe('');
  });

  it('one of every reason, in the order the comparison found them', () => {
    const expected = {
      id: '@isNumber() @gt(0)',
      name: 'John Doe',
      email: '@matchesRegex("@plune\\.ai$")',
      age: 30,
      address: { city: 'Kyiv' },
      roles: ['admin', 'editor'],
      tags: { $mode: 'unordered', $value: ['a', { k: 1 }] },
    };
    const actual = {
      id: 0,
      name: 'John',
      email: 'user@plune.ai',
      age: '30',
      roles: ['admin', 'viewer', 'guest'],
      tags: ['a', { k: 2 }],
      debug: true,
    };
    expect(text(expected, actual)).toBe(
      [
        '9 mismatches',
        '    $.id: function not satisfied: @gt(0)',
        '      expected: "@isNumber() @gt(0)"',
        '      actual:   0',
        '    $.name: value differs',
        '      expected: "John Doe"',
        '      actual:   "John"',
        '    $.age: type differs: expected number, got string',
        '      expected: 30',
        '      actual:   "30"',
        '    $.address: missing key',
        '      expected: {"city":"Kyiv"}',
        '    $.roles[1]: value differs',
        '      expected: "editor"',
        '      actual:   "viewer"',
        '    $.roles[2]: extra element',
        '      actual:   "guest"',
        '    $.tags[1]: no match for an array element',
        '      expected: {"k":1}',
        '    $.tags[1]: extra element',
        '      actual:   {"k":2}',
        '    $.debug: extra key',
        '      actual:   true',
      ].join('\n'),
    );
  });

  it('an extra key, a missing element and the types of null and an array', () => {
    expect(text({ a: [1, 2], b: null, c: [] }, { a: [1], b: {}, c: null, d: 0 })).toBe(
      [
        '4 mismatches',
        '    $.a[1]: missing element',
        '      expected: 2',
        '    $.b: type differs: expected null, got object',
        '      expected: null',
        '      actual:   {}',
        '    $.c: type differs: expected array, got null',
        '      expected: []',
        '      actual:   null',
        '    $.d: extra key',
        '      actual:   0',
      ].join('\n'),
    );
  });

  it('one mismatch is counted in the singular', () => {
    expect(text(1, 2)).toBe(['1 mismatch', '    $: value differs', '      expected: 1', '      actual:   2'].join('\n'));
  });

  it('a check that gave a note carries it, and an array over the matching limit says so', () => {
    const long = 'a'.repeat(2001);
    expect(text('@matchesRegex("^a+$")', long).split('\n')[1]).toBe(
      '    $: function not satisfied: @matchesRegex("^a+$"): the value is 2001 characters long and a pattern is not run on more than 2000',
    );
    const rows = Array.from({ length: 501 }, (_, id) => ({ id }));
    expect(text(rows, rows, 'unordered')).toBe(
      [
        '1 mismatch',
        '    $: array too large to match in any order: 501 expected elements against 501 of the answer is over the limit of 250000 pairs',
      ].join('\n'),
    );
  });

  it(`a fragment is cut at ${MAX_FRAGMENT} characters, with its full length`, () => {
    const long = 'x'.repeat(300);
    const lines = text({ a: long }, { a: [long] }).split('\n');
    expect(lines[2]).toBe(`      expected: "${'x'.repeat(MAX_FRAGMENT - 1)}... (302 characters)`);
    expect(lines[3]).toBe(`      actual:   ["${'x'.repeat(MAX_FRAGMENT - 2)}... (304 characters)`);
    const fits = 'y'.repeat(MAX_FRAGMENT - 2);
    expect(text(fits, '').split('\n')[2]).toBe(`      expected: "${fits}"`);
  });

  it('a cut never splits a character written as two code units', () => {
    const emoji = '\u{1F600}';
    // The quote takes one unit, so the 60th emoji would be cut in half at 120.
    const lines = text(emoji.repeat(100), '').split('\n');
    expect(lines[2]).toBe(`      expected: "${emoji.repeat(59)}... (202 characters)`);
  });

  it('a line break or a control character of the answer stays on its line', () => {
    const lines = text('a', 'line one\nline two\u001b[31m\r::error::x').split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[3]).toBe('      actual:   "line one\\nline two\\u001b[31m\\r::error::x"');
  });

  it(`at most ${MAX_LISTED} mismatches are listed, and the rest are counted`, () => {
    const expected = Array.from({ length: MAX_LISTED + 7 }, (_, i) => i);
    const lines = text(expected, expected.map((i) => -i - 1)).split('\n');
    expect(lines[0]).toBe(`${MAX_LISTED + 7} mismatches`);
    expect(lines).toHaveLength(1 + MAX_LISTED * 3 + 1);
    expect(lines[lines.length - 2]).toBe(`      actual:   ${-MAX_LISTED}`);
    expect(lines[lines.length - 1]).toBe('    and 7 more');
    // Exactly at the cap nothing is counted as more.
    const atCap = text(expected.slice(0, MAX_LISTED), expected.slice(0, MAX_LISTED).map((i) => -i - 1));
    expect(atCap.split('\n')).toHaveLength(1 + MAX_LISTED * 3);
    expect(atCap).not.toContain('more');
  });

  it('the text is the same on every call', () => {
    const expected = { b: [{ x: 1 }, { y: 2 }], a: '@isString()' };
    const actual = { a: 1, b: [{ y: 3 }, { x: 2 }], c: null };
    expect(text(expected, actual, 'unordered')).toBe(text(expected, actual, 'unordered'));
    expect(text(expected, actual, 'unordered')).toBe(
      [
        '6 mismatches',
        '    $.b[0]: no match for an array element',
        '      expected: {"x":1}',
        '    $.b[1]: no match for an array element',
        '      expected: {"y":2}',
        '    $.b[0]: extra element',
        '      actual:   {"y":3}',
        '    $.b[1]: extra element',
        '      actual:   {"x":2}',
        '    $.a: function not satisfied: @isString()',
        '      expected: "@isString()"',
        '      actual:   1',
        '    $.c: extra key',
        '      actual:   null',
      ].join('\n'),
    );
  });
});
