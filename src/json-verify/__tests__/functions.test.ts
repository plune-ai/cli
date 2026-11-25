import { describe, expect, it } from 'vitest';
import {
  CHECK_FUNCTIONS,
  CheckSyntaxError,
  MAX_REGEX_INPUT,
  MAX_REGEX_PATTERN,
  parseExpectedString,
} from '../functions.js';
import { compareJson, ExpectedJsonError, validateExpected } from '../compare.js';
import type { CompareMode } from '../compare.js';

const MODES: CompareMode[] = ['exact', 'unordered', 'contains'];
const passes = (expected: unknown, actual: unknown, mode: CompareMode = 'exact'): boolean =>
  compareJson(expected, actual, { mode }).length === 0;
const errorOf = (s: string): string => {
  try {
    parseExpectedString(s);
  } catch (err) {
    expect(err).toBeInstanceOf(CheckSyntaxError);
    return (err as Error).message;
  }
  return '(no error)';
};

describe('json-verify · functions · which strings are checks', () => {
  it.each([
    'user@plune.ai',
    '@john_doe',
    '@ home',
    '@',
    '@john said (hi)',
    '@1st(place)',
    '@isstring',
    '@isStringy',
    'see @isString()',
    ' @isString()',
    '',
    'John Doe',
  ])('%j is a literal, compared as text', (s) => {
    expect(parseExpectedString(s)).toEqual({ literal: s });
    expect(passes({ v: s }, { v: s })).toBe(true);
    expect(passes({ v: s }, { v: `${s}!` })).toBe(false);
  });

  it.each<[string, string]>([
    ['@@isString()', '@isString()'],
    ['@@john(hi)', '@john(hi)'],
    ['@@@x', '@@x'],
    ['@@', '@'],
  ])('%j is the escape for the text %j', (written, text) => {
    expect(parseExpectedString(written)).toEqual({ literal: text });
    expect(passes([written], [text], 'unordered')).toBe(true);
    expect(passes(written, written)).toBe(false);
  });

  it('{$literal} is the other escape: under it no string is a check', () => {
    expect(passes({ $literal: { a: '@isString()', b: ['@@x', '@nope('] } }, { a: '@isString()', b: ['@@x', '@nope('] })).toBe(true);
    expect(passes({ $literal: '@isString()' }, 'text')).toBe(false);
    expect(validateExpected({ $literal: '@nope()' })).toEqual([]);
  });

  it('several checks in one string are separated by spaces, and all must hold', () => {
    expect(parseExpectedString('@isString()  @minLength(3) ')).toEqual({
      checks: [
        { name: 'isString', args: [], text: '@isString()' },
        { name: 'minLength', args: [3], text: '@minLength(3)' },
      ],
    });
    expect(passes('@isString() @minLength(3)', 'John')).toBe(true);
    expect(compareJson({ name: '@isString() @minLength(3)' }, { name: 'Jo' })).toEqual([
      { path: '$.name', reason: 'function', expected: '@isString() @minLength(3)', actual: 'Jo', detail: '@minLength(3)' },
    ]);
  });

  it('numbers are written as JSON writes them', () => {
    expect(parseExpectedString('@oneOf(0, -0, 10, 0.5, -1.25e-3, 1E2)')).toEqual({
      checks: [expect.objectContaining({ args: [0, -0, 10, 0.5, -0.00125, 100] })],
    });
  });

  it('arguments: numbers, true, false, null and strings in either quote', () => {
    const parsed = parseExpectedString(`@oneOf( 1, -2.5 ,1e3,true,false,null,"a, b)" , 'it''s' )`.replace("''", "\\'"));
    expect(parsed).toEqual({
      checks: [expect.objectContaining({ name: 'oneOf', args: [1, -2.5, 1000, true, false, null, 'a, b)', "it's"] })],
    });
  });

  it('inside quotes only the quote itself is escaped; every other backslash stays', () => {
    const parsed = parseExpectedString(String.raw`@matchesRegex("^\d+\\ \"x\"$")`);
    expect(parsed).toEqual({ checks: [expect.objectContaining({ args: [String.raw`^\d+\\ "x"$`] })] });
    expect(passes(String.raw`@matchesRegex("^\d+\\ \"x\"$")`, String.raw`12\ "x"`)).toBe(true);
  });
});

describe('json-verify · functions · a broken check is an error, never a literal', () => {
  it.each<[string, string]>([
    ['@foo()', '@foo is not a check function (known: isNotNull, isString, isNumber, isBoolean, isArray, isObject, matchesRegex, minLength, maxLength, gt, lt, oneOf); for the text itself write @@foo()'],
    ['@isString', '@isString needs parentheses to be a check: @isString(); for the text itself write @@isString'],
    ['@gt @lt(1)', '@gt needs parentheses to be a check: @gt(); for the text itself write @@gt @lt(1)'],
    ['@isString() and more', 'expected a check such as @isString() at character 13 of "@isString() and more"; for the text itself write @@isString() and more'],
    ['@isString() @john', 'expected a check such as @isString() at character 13 of "@isString() @john"; for the text itself write @@isString() @john'],
    ['@isString()@minLength(1)', 'checks are separated by a space: character 12 of "@isString()@minLength(1)"'],
    ['@isString(1)', '@isString takes no arguments; got @isString(1)'],
    ['@gt()', '@gt takes one number; got @gt()'],
    ['@gt("1")', '@gt takes one number; got @gt("1")'],
    ['@lt(1, 2)', '@lt takes one number; got @lt(1, 2)'],
    ['@minLength(-1)', '@minLength takes one whole number, 0 or more; got @minLength(-1)'],
    ['@maxLength(1.5)', '@maxLength takes one whole number, 0 or more; got @maxLength(1.5)'],
    ['@oneOf()', '@oneOf takes at least one value; got @oneOf()'],
    ['@gt(abc)', '@gt: argument 1 must be a number, true, false, null or a string in quotes, got "abc" at character 5 of "@gt(abc)"'],
    ['@oneOf(01)', '@oneOf: argument 1 must be a number, true, false, null or a string in quotes, got "01" at character 8 of "@oneOf(01)"'],
    ['@oneOf(1, -01.5)', '@oneOf: argument 2 must be a number, true, false, null or a string in quotes, got "-01.5" at character 11 of "@oneOf(1, -01.5)"'],
    ['@gt(.5)', '@gt: argument 1 must be a number, true, false, null or a string in quotes, got ".5" at character 5 of "@gt(.5)"'],
    ['@gt(1e999)', '@gt: argument 1 is not a finite number, got "1e999" at character 5 of "@gt(1e999)"'],
    ['@lt(-1e999)', '@lt: argument 1 is not a finite number, got "-1e999" at character 5 of "@lt(-1e999)"'],
    ['@gt(1,)', '@gt: argument 2 must be a number, true, false, null or a string in quotes, got "" at character 7 of "@gt(1,)"'],
    ['@gt(1', '@gt: expected "," or ")" at character 6 of "@gt(1"'],
    ['@gt(1 2)', '@gt: expected "," or ")" at character 7 of "@gt(1 2)"'],
    ['@oneOf("a)', '@oneOf: a string is not closed at character 8 of "@oneOf(\\"a)"'],
    ['@matchesRegex()', '@matchesRegex takes a pattern in quotes and, optionally, flags in quotes; got @matchesRegex()'],
    ['@matchesRegex(1)', '@matchesRegex takes a pattern in quotes and, optionally, flags in quotes; got @matchesRegex(1)'],
    ['@matchesRegex("a", 1)', '@matchesRegex takes a pattern in quotes and, optionally, flags in quotes; got @matchesRegex("a", 1)'],
    ['@matchesRegex("a", "i", "m")', '@matchesRegex takes a pattern in quotes and, optionally, flags in quotes; got @matchesRegex("a", "i", "m")'],
    ['@matchesRegex("a", "g")', '@matchesRegex takes the flags i, m and s, each at most once; got "g"; got @matchesRegex("a", "g")'],
    ['@matchesRegex("a", "ii")', '@matchesRegex takes the flags i, m and s, each at most once; got "ii"; got @matchesRegex("a", "ii")'],
    ['@matchesRegex("a", "imi")', '@matchesRegex takes the flags i, m and s, each at most once; got "imi"; got @matchesRegex("a", "imi")'],
    ['@matchesRegex("a", "u")', '@matchesRegex takes the flags i, m and s, each at most once; got "u"; got @matchesRegex("a", "u")'],
  ])('%j', (s, message) => {
    expect(errorOf(s)).toBe(message);
  });

  it('the error carries the path of the string in the expected value', () => {
    const expected = { user: { tags: ['ok', '@isStrin()'] }, n: '@gt()' };
    expect(validateExpected(expected)).toEqual([
      { path: '$.user.tags[1]', message: expect.stringMatching(/^@isStrin is not a check function/) as string },
      { path: '$.n', message: '@gt takes one number; got @gt()' },
    ]);
    let thrown: unknown;
    try {
      compareJson(expected, {}, { mode: 'contains' });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ExpectedJsonError);
    expect((thrown as Error).message).toMatch(/^\$\.user\.tags\[1\]: @isStrin is not a check function/);
  });

  it('a name that is a property of every object is not a function', () => {
    expect(errorOf('@toString()')).toMatch(/^@toString is not a check function/);
    expect(errorOf('@constructor()')).toMatch(/^@constructor is not a check function/);
    expect(parseExpectedString('@toString')).toEqual({ literal: '@toString' });
  });
});

describe('json-verify · functions · the twelve', () => {
  const SAMPLES: unknown[] = [null, true, false, 0, 1, -1, 2.5, '', 'a', 'abc', [], [1, 2, 3], {}, { a: 1 }];
  /** The samples a check accepts, as JSON: the whole truth table of the function in one line. */
  const accepted = (check: string): string => JSON.stringify(SAMPLES.filter((v) => passes(check, v)));

  it.each<[string, string]>([
    ['@isNotNull()', '[true,false,0,1,-1,2.5,"","a","abc",[],[1,2,3],{},{"a":1}]'],
    ['@isString()', '["","a","abc"]'],
    ['@isNumber()', '[0,1,-1,2.5]'],
    ['@isBoolean()', '[true,false]'],
    ['@isArray()', '[[],[1,2,3]]'],
    ['@isObject()', '[{},{"a":1}]'],
    ['@matchesRegex("^a")', '["a","abc"]'],
    ['@matchesRegex("^A", "i")', '["a","abc"]'],
    ['@matchesRegex("")', '["","a","abc"]'],
    ['@minLength(1)', '["a","abc",[1,2,3]]'],
    ['@minLength(0)', '["","a","abc",[],[1,2,3]]'],
    ['@maxLength(1)', '["","a",[]]'],
    ['@gt(0)', '[1,2.5]'],
    ['@lt(1)', '[0,-1]'],
    ['@oneOf("a", 1, null, true)', '[null,true,1,"a"]'],
    ['@oneOf("1")', '[]'],
    ['@isNumber() @gt(0) @lt(2)', '[1]'],
  ])('%s accepts %s', (check, list) => {
    expect(accepted(check)).toBe(list);
  });

  it('has exactly these names', () => {
    expect(Object.keys(CHECK_FUNCTIONS)).toEqual([
      'isNotNull',
      'isString',
      'isNumber',
      'isBoolean',
      'isArray',
      'isObject',
      'matchesRegex',
      'minLength',
      'maxLength',
      'gt',
      'lt',
      'oneOf',
    ]);
  });
});

describe('json-verify · functions · inside a comparison', () => {
  it('a check works in every mode, and a key it is on must still be there', () => {
    for (const mode of MODES) {
      expect(passes({ id: '@isNumber() @gt(0)' }, { id: 7 }, mode), mode).toBe(true);
      expect(compareJson({ id: '@isNotNull()' }, {}, { mode }), mode).toEqual([
        { path: '$.id', reason: 'missing-key', expected: '@isNotNull()' },
      ]);
    }
  });

  it('a check replaces the type comparison: the mismatch is of the function', () => {
    expect(compareJson({ id: '@isNumber()' }, { id: '7' })).toEqual([
      { path: '$.id', reason: 'function', expected: '@isNumber()', actual: '7', detail: '@isNumber()' },
    ]);
  });

  it('in an array, a check does not take the element a plain value needs', () => {
    // First-fit gives @isNumber() the 1 and leaves the expected 1 with nothing.
    for (const mode of ['unordered', 'contains'] as const) {
      expect(passes(['@isNumber()', 1], [1, 2], mode), mode).toBe(true);
      expect(passes(['@isString()', '@@a', 'b'], ['b', '@a', 'c'], mode), mode).toBe(true);
      expect(passes(['@isNumber()', '@gt(1)'], [2, 1], mode), mode).toBe(true);
    }
    expect(compareJson(['@gt(1)', '@gt(1)'], [2, 1], { mode: 'unordered' })).toEqual([
      { path: '$[1]', reason: 'no-match', expected: '@gt(1)' },
      { path: '$[1]', reason: 'extra-element', actual: 1 },
    ]);
  });

  it('an e-mail address inside the expected value is a text to equal', () => {
    expect(passes({ email: 'user@plune.ai' }, { email: 'user@plune.ai' })).toBe(true);
    expect(compareJson({ email: 'user@plune.ai' }, { email: 'john@plune.ai' })).toEqual([
      { path: '$.email', reason: 'value', expected: 'user@plune.ai', actual: 'john@plune.ai' },
    ]);
  });

  it('an escaped text is reported as the text, not as it was written', () => {
    expect(compareJson('@@handle', 'x')).toEqual([{ path: '$', reason: 'value', expected: '@handle', actual: 'x' }]);
  });
});

describe('json-verify · functions · a pattern that would take RegExp minutes', () => {
  // The three a review timed with RegExp: 14.8 s, 82 s and 0.75 s (four times more per two characters).
  it.each<[string, string]>([
    ['^(a+){20}$', `${'a'.repeat(32)}!`],
    [String.raw`^\d+\d+\d+\d+\d+x`, '7'.repeat(400)],
    ['^(a|a)*b', 'a'.repeat(28)],
  ])('%s is accepted and answered at once', (pattern, text) => {
    expect(errorOf(`@matchesRegex("${pattern}")`)).toBe('(no error)');
    const started = Date.now();
    expect(passes(`@matchesRegex("${pattern}")`, text)).toBe(false);
    expect(Date.now() - started).toBeLessThan(250);
  });

  it('all three flags together are taken', () => {
    expect(passes('@matchesRegex("^A.b$", "smi")', 'a\nB')).toBe(true);
  });

  it('a repeat inside a repeat is an ordinary pattern', () => {
    expect(passes(String.raw`@matchesRegex("^(\d+,)*\d+$")`, '1,22,333')).toBe(true);
    expect(passes(String.raw`@matchesRegex("^(\w+\s?)+$")`, 'John Doe')).toBe(true);
    expect(passes('@matchesRegex("^(a+)+$")', `${'a'.repeat(MAX_REGEX_INPUT - 1)}!`)).toBe(false);
  });

  it('a value over the length cap fails the check with a note, and the pattern is not run', () => {
    const long = 'a'.repeat(MAX_REGEX_INPUT + 1);
    expect(passes('@matchesRegex("^a+$")', long.slice(1))).toBe(true);
    expect(compareJson('@matchesRegex("^a+$")', long)).toEqual([
      {
        path: '$',
        reason: 'function',
        expected: '@matchesRegex("^a+$")',
        actual: long,
        detail: `@matchesRegex("^a+$"): the value is ${MAX_REGEX_INPUT + 1} characters long and a pattern is not run on more than ${MAX_REGEX_INPUT}`,
      },
    ]);
  });

  it('what the matcher does not read is an error that names the function and the place in the pattern', () => {
    expect(errorOf(String.raw`@matchesRegex("(a)\1")`)).toBe(
      String.raw`@matchesRegex has a pattern it cannot run: \1 is not supported (character 5 of the pattern); got @matchesRegex("(a)\1")`,
    );
    expect(errorOf('@matchesRegex("a(?=b)")')).toMatch(/^@matchesRegex has a pattern it cannot run: lookahead, /);
    expect(errorOf('@matchesRegex("(")')).toMatch(/^@matchesRegex has a pattern it cannot run: a group is not closed /);
    expect(errorOf('@matchesRegex("a{5000}")')).toMatch(/^@matchesRegex has a pattern it cannot run: the pattern is too large /);
  });

  it('a pattern over the length cap is an error', () => {
    const pattern = 'a'.repeat(MAX_REGEX_PATTERN + 1);
    expect(errorOf(`@matchesRegex("${pattern}")`)).toBe(
      `@matchesRegex takes a pattern of at most ${MAX_REGEX_PATTERN} characters; got ${MAX_REGEX_PATTERN + 1}; got @matchesRegex("${pattern}")`,
    );
    expect(errorOf(`@matchesRegex("${pattern.slice(1)}")`)).toBe('(no error)');
  });

  it('many different patterns in one run are each compiled and answered', () => {
    for (let n = 0; n < 250; n++) expect(passes(`@matchesRegex("^a{${n}}$")`, 'a'.repeat(n)), String(n)).toBe(true);
    expect(passes('@matchesRegex("^a{3}$")', 'aa')).toBe(false);
  });
});
