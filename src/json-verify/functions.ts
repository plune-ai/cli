// Check functions written as data inside an expected JSON value: a string such as
// `@isString() @minLength(3)` is not compared as text, each function in it is asked about the actual value
// and all must hold. Pure: no I/O and nothing of Node.
//
// Which strings are checks (the whole rule):
//
//   1. A string that starts with `@@` is a literal: one `@` is dropped (`@@isString()` is the text `@isString()`).
//   2. A string that starts with `@name(` is a check expression and must parse to its end: calls separated by
//      spaces, each a known function with the arguments it takes. Anything else is an error of the expected
//      value, never a silent literal.
//   3. A string that starts with `@name` of a known function with no `(` after it is an error too: the
//      parentheses were forgotten.
//   4. Every other string is a literal: `user@plune.ai`, `@john_doe`, `@ home`.
//
// Arguments are separated by commas: numbers, `true`, `false`, `null`, and strings in double or single quotes.
// Inside the quotes a backslash before the same quote gives the quote, and every other backslash stays as it
// is written, so a pattern reads as it does in a regular expression: `@matchesRegex("^\d+$")`.

import { compileRegex } from './regex.js';

export type CheckArg = string | number | boolean | null;

export interface Check {
  name: string;
  args: CheckArg[];
  /** The call as written, for the mismatch text: `@gt(0)`. */
  text: string;
}

export type ExpectedString = { checks: Check[] } | { literal: string };

/**
 * `@matchesRegex` does not run on a longer value: the check fails and says so. With the limit on the size of a
 * compiled pattern (regex.ts) it bounds one check to a fixed number of steps, whatever the pattern.
 */
export const MAX_REGEX_INPUT = 10_000;
/** A longer pattern is an error of the expected value. */
export const MAX_REGEX_PATTERN = 500;

interface CheckFunction {
  /** What is wrong with the arguments, as the end of "@name ...": `takes one number`. */
  args(args: CheckArg[]): string | undefined;
  /** `true` when the value satisfies the check; a string is a failure with a note. */
  test(actual: unknown, args: CheckArg[]): boolean | string;
}

const none = (args: CheckArg[]): string | undefined => (args.length === 0 ? undefined : 'takes no arguments');
const oneNumber = (args: CheckArg[]): string | undefined =>
  args.length === 1 && typeof args[0] === 'number' ? undefined : 'takes one number';
const oneLength = (args: CheckArg[]): string | undefined =>
  args.length === 1 && Number.isInteger(args[0]) && (args[0] as number) >= 0
    ? undefined
    : 'takes one whole number, 0 or more';
const lengthOf = (v: unknown): number | undefined =>
  typeof v === 'string' || Array.isArray(v) ? v.length : undefined;
const is = (test: (v: unknown) => boolean): CheckFunction => ({ args: none, test });

/** Compiled patterns: a check inside an array is asked about many elements. */
const matchers = new Map<string, (text: string) => boolean>();
function matcher(pattern: string, flags: string): (text: string) => boolean {
  const key = `${flags}/${pattern}`;
  let compiled = matchers.get(key);
  if (compiled === undefined) {
    compiled = compileRegex(pattern, flags);
    if (matchers.size >= 100) matchers.clear();
    matchers.set(key, compiled);
  }
  return compiled;
}

function regexArgs(args: CheckArg[]): string | undefined {
  const [pattern, flags = ''] = args;
  if (args.length < 1 || args.length > 2 || typeof pattern !== 'string' || typeof flags !== 'string')
    return 'takes a pattern in quotes and, optionally, flags in quotes';
  if (!/^[ims]*$/.test(flags)) return `takes only the flags i, m and s; got "${flags}"`;
  if (pattern.length > MAX_REGEX_PATTERN)
    return `takes a pattern of at most ${MAX_REGEX_PATTERN} characters; got ${pattern.length}`;
  try {
    matcher(pattern, flags);
  } catch (err) {
    return `has a pattern it cannot run: ${(err as Error).message}`;
  }
  return undefined;
}

/** The check functions by name. */
export const CHECK_FUNCTIONS: Readonly<Record<string, CheckFunction>> = {
  isNotNull: is((v) => v !== null),
  isString: is((v) => typeof v === 'string'),
  isNumber: is((v) => typeof v === 'number'),
  isBoolean: is((v) => typeof v === 'boolean'),
  isArray: is((v) => Array.isArray(v)),
  isObject: is((v) => typeof v === 'object' && v !== null && !Array.isArray(v)),
  matchesRegex: {
    args: regexArgs,
    test(v, [pattern, flags]) {
      if (typeof v !== 'string') return false;
      if (v.length > MAX_REGEX_INPUT)
        return `the value is ${v.length} characters long and a pattern is not run on more than ${MAX_REGEX_INPUT}`;
      return matcher(pattern as string, (flags as string | undefined) ?? '')(v);
    },
  },
  minLength: { args: oneLength, test: (v, [n]) => (lengthOf(v) ?? -1) >= (n as number) },
  maxLength: { args: oneLength, test: (v, [n]) => (lengthOf(v) ?? Infinity) <= (n as number) },
  gt: { args: oneNumber, test: (v, [n]) => typeof v === 'number' && v > (n as number) },
  lt: { args: oneNumber, test: (v, [n]) => typeof v === 'number' && v < (n as number) },
  oneOf: {
    args: (args) => (args.length > 0 ? undefined : 'takes at least one value'),
    test: (v, args) => args.includes(v as CheckArg),
  },
};

const known = (name: string): boolean => Object.prototype.hasOwnProperty.call(CHECK_FUNCTIONS, name);

/** A string of the expected value that looks like a check and is not a valid one. */
export class CheckSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CheckSyntaxError';
  }
}

const CALL_START = /^@([A-Za-z_]\w*)(\()?/;
const BARE_ARG = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)$/;

/** The arguments from just after `(`; returns them and the index just after `)`. */
function parseArgs(s: string, from: number, name: string): [CheckArg[], number] {
  const args: CheckArg[] = [];
  const bad = (what: string, at: number): CheckSyntaxError =>
    new CheckSyntaxError(`@${name}: ${what} at character ${at + 1} of ${JSON.stringify(s)}`);
  let i = from;
  const skipSpaces = (): void => {
    while (s[i] === ' ') i++;
  };
  skipSpaces();
  if (s[i] === ')') return [args, i + 1];
  for (;;) {
    const quote = s[i];
    if (quote === '"' || quote === "'") {
      let text = '';
      for (i++; s[i] !== quote; i++) {
        if (i >= s.length) throw bad('a string is not closed', from);
        if (s[i] === '\\' && s[i + 1] === quote) i++;
        text += s[i];
      }
      i++;
      args.push(text);
    } else {
      const start = i;
      while (i < s.length && !' ,)'.includes(s[i]!)) i++;
      const token = s.slice(start, i);
      if (!BARE_ARG.test(token))
        throw bad(
          `argument ${args.length + 1} must be a number, true, false, null or a string in quotes, got ${JSON.stringify(token)}`,
          start,
        );
      args.push(JSON.parse(token) as CheckArg);
    }
    skipSpaces();
    if (s[i] === ')') return [args, i + 1];
    if (s[i] !== ',') throw bad('expected "," or ")"', i);
    i++;
    skipSpaces();
  }
}

/**
 * Reads one string of an expected value by the rule at the top of this file.
 *
 * @throws CheckSyntaxError when the string is a check expression and not a valid one.
 */
export function parseExpectedString(s: string): ExpectedString {
  if (s.startsWith('@@')) return { literal: s.slice(1) };
  const first = CALL_START.exec(s);
  if (first === null) return { literal: s };
  if (first[2] === undefined) {
    const after = s[first[0].length];
    if (known(first[1]!) && (after === undefined || after === ' '))
      throw new CheckSyntaxError(
        `@${first[1]} needs parentheses to be a check: @${first[1]}(); for the text itself write @${s}`,
      );
    return { literal: s };
  }

  const checks: Check[] = [];
  let i = 0;
  while (i < s.length) {
    const call = CALL_START.exec(s.slice(i));
    if (call === null || call[2] === undefined)
      throw new CheckSyntaxError(
        `expected a check such as @isString() at character ${i + 1} of ${JSON.stringify(s)}; for the text itself write @${s}`,
      );
    const name = call[1]!;
    if (!known(name))
      throw new CheckSyntaxError(
        `@${name} is not a check function (known: ${Object.keys(CHECK_FUNCTIONS).join(', ')}); for the text itself write @${s}`,
      );
    const [args, end] = parseArgs(s, i + call[0].length, name);
    const text = s.slice(i, end);
    const wrong = CHECK_FUNCTIONS[name]!.args(args);
    if (wrong !== undefined) throw new CheckSyntaxError(`@${name} ${wrong}; got ${text}`);
    checks.push({ name, args, text });
    i = end;
    if (i < s.length && s[i] !== ' ')
      throw new CheckSyntaxError(`checks are separated by a space: character ${i + 1} of ${JSON.stringify(s)}`);
    while (s[i] === ' ') i++;
  }
  return { checks };
}

/** The first check the value does not satisfy, with the note of the function if it gave one. */
export function firstFailedCheck(checks: Check[], actual: unknown): { check: Check; note?: string } | undefined {
  for (const check of checks) {
    const result = CHECK_FUNCTIONS[check.name]!.test(actual, check.args);
    if (result === true) continue;
    return typeof result === 'string' ? { check, note: result } : { check };
  }
  return undefined;
}
