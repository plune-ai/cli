import { describe, expect, it } from 'vitest';
import { compileRegex, MAX_REGEX_NODES } from '../regex.js';

const errorOf = (pattern: string, flags = ''): string => {
  try {
    compileRegex(pattern, flags);
  } catch (err) {
    return (err as Error).message;
  }
  return '(no error)';
};

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

/** Every pattern here is read the same way by `RegExp`: the matcher must agree with it on every text. */
const PATTERNS: [string, string?][] = [
  [''],
  ['a'],
  ['ab|ba'],
  ['^a'],
  ['a$'],
  ['^$'],
  ['^ab*a$'],
  ['a+b+'],
  ['a?b'],
  ['(a|b)*c'],
  ['(?:ab)+'],
  ['(a+)+$'],
  ['^(a+)+$'],
  ['(a*)*b'],
  ['(a|a)*b'],
  ['^(a|aa)+$'],
  ['a{2}'],
  ['^a{2,}$'],
  ['^a{1,2}b$'],
  ['^(ab){2}$'],
  ['^(a+){3}$'],
  ['a{0}b'],
  ['a{,2}'],
  ['a{b'],
  ['a}'],
  ['a]'],
  ['a*?b'],
  ['a+?'],
  ['a??b'],
  ['a{1,2}?b'],
  ['.'],
  ['a.b'],
  ['a.b', 's'],
  ['^.*$'],
  ['^.*$', 's'],
  ['^b', 'm'],
  ['a$', 'm'],
  ['^$', 'm'],
  ['\\d+'],
  ['^\\d+\\d+\\d+x'],
  ['\\D'],
  ['\\w\\W'],
  ['\\s'],
  ['\\S+'],
  ['\\bab\\b'],
  ['\\Ba'],
  ['a\\b'],
  ['\\.'],
  ['\\(a\\)'],
  ['\\n'],
  ['a\\tb'],
  ['[ab]'],
  ['[^ab]'],
  ['[a-c1-2]+'],
  ['[^a-c]'],
  ['[\\d.]+'],
  ['[\\D]'],
  ['[a\\-b]'],
  ['[a-]'],
  ['[-a]'],
  ['[\\]]'],
  ['[\\n\\b]'],
  ['[.*+?(){}|^$]'],
  ['[]'],
  ['[^]'],
  ['A', 'i'],
  ['[a-b]c', 'i'],
  ['[^A]', 'i'],
  ['\\w', 'i'],
  ['ß', 'i'],
  ['іЇ', 'i'],
  ['||a'],
  ['()'],
  ['(|a)b'],
  ['(a|)'],
  ['^(?:(?:a|b)(?:c|d)?)*$'],
];

const ALPHABET = ['a', 'a', 'a', 'b', 'b', 'c', 'A', 'B', '1', '2', ' ', '.', '-', '\n', '\t', '\r', 'x', ']', 'ß', 'İ', 'І', 'ї', '\b'];

describe('json-verify · regex · the same verdict as RegExp', () => {
  it.each(PATTERNS)('%j %s', (pattern, flags = '') => {
    const native = new RegExp(pattern, flags);
    const match = compileRegex(pattern, flags);
    const rand = rng(pattern.length * 31 + flags.length);
    const texts = ['', 'a', 'ab', 'aab', 'abab', 'aaa', 'b\na', 'a\nb', 'a b', '(a)', 'a\tb', 'a.b', 'a-b', '\n'];
    for (let n = 0; n < 300; n++)
      texts.push(Array.from({ length: Math.floor(rand() * 8) }, () => ALPHABET[Math.floor(rand() * ALPHABET.length)]).join(''));
    for (const text of texts) expect(match(text), JSON.stringify(text)).toBe(native.test(text));
  });

  it('a compiled pattern can be asked again and again', () => {
    const match = compileRegex('^a+$');
    expect([match('aa'), match('ab'), match('aa'), match('')]).toEqual([true, false, true, false]);
  });
});

describe('json-verify · regex · the time does not depend on the pattern', () => {
  // Each of these takes RegExp from most of a second to more than a minute on the same text.
  it.each<[string, string, boolean]>([
    ['^(a+){20}$', `${'a'.repeat(32)}!`, false],
    ['^\\d+\\d+\\d+\\d+\\d+x', '7'.repeat(400), false],
    ['^(a|a)*b', 'a'.repeat(28), false],
    ['(a+)+$', `${'a'.repeat(5000)}!`, false],
    ['^(\\w+\\s?)+$', `${'word '.repeat(1000)}!`, false],
    ['^(a|aa)+$', 'a'.repeat(5000), true],
  ])('%s', (pattern, text, verdict) => {
    const started = Date.now();
    expect(compileRegex(pattern)(text)).toBe(verdict);
    expect(Date.now() - started).toBeLessThan(250);
  });

  it('the largest pattern on the longest text a check runs is well under a second', () => {
    const pattern = `^(?:${'[ab]?'.repeat(10)}){${Math.floor((MAX_REGEX_NODES - 10) / 21)}}$`;
    const match = compileRegex(pattern);
    const started = Date.now();
    expect(match(`${'ab'.repeat(5000)}`)).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('json-verify · regex · what it refuses, with the place', () => {
  it.each<[string, string]>([
    ['(a)\\1', '\\1 is not supported (character 5 of the pattern)'],
    ['\\p{L}', '\\p is not supported (character 2 of the pattern)'],
    ['\\x41', '\\x is not supported (character 2 of the pattern)'],
    ['\\u0041', '\\u is not supported (character 2 of the pattern)'],
    ['[\\x41]', '\\x is not supported (character 3 of the pattern)'],
    ['a(?=b)', 'lookahead, lookbehind and named groups are not supported (character 2 of the pattern)'],
    ['(?<!a)b', 'lookahead, lookbehind and named groups are not supported (character 1 of the pattern)'],
    ['(?<n>a)', 'lookahead, lookbehind and named groups are not supported (character 1 of the pattern)'],
    ['(a', 'a group is not closed (character 2 of the pattern)'],
    ['a)', 'a ")" has no group to close (character 1 of the pattern)'],
    ['[a', 'a character class is not closed (character 3 of the pattern)'],
    ['[a\\', 'a backslash ends the pattern (character 4 of the pattern)'],
    ['a\\', 'a backslash ends the pattern (character 3 of the pattern)'],
    ['[b-a]', 'a range in a character class is out of order (character 4 of the pattern)'],
    ['[a-\\d]', 'a range in a character class is out of order (character 5 of the pattern)'],
    ['*a', 'nothing to repeat (character 1 of the pattern)'],
    ['a|+', 'nothing to repeat (character 3 of the pattern)'],
    ['a**', 'nothing to repeat (character 3 of the pattern)'],
    ['(?:?)', 'nothing to repeat (character 4 of the pattern)'],
    ['^*', 'an anchor cannot be repeated (character 2 of the pattern)'],
    ['\\b+', 'an anchor cannot be repeated (character 3 of the pattern)'],
    ['a{2,1}', 'a repeat has its numbers out of order (character 6 of the pattern)'],
  ])('%s', (pattern, message) => {
    expect(errorOf(pattern)).toBe(message);
  });

  it.each(['a{5000}', '(a{50}){50}', '((?:){999999999}){999999999}', '(a?){3000}', `(?:${'a'.repeat(200)}){1,20}`])(
    'a pattern that is too large once written out, at once: %s',
    (pattern) => {
      const started = Date.now();
      expect(errorOf(pattern)).toBe(
        `the pattern is too large once its repeats are written out (over ${MAX_REGEX_NODES} parts)`,
      );
      expect(Date.now() - started).toBeLessThan(250);
    },
  );

  it('a pattern just under that size is run', () => {
    expect(errorOf(`a{${MAX_REGEX_NODES - 10}}`)).toBe('(no error)');
  });
});
