// One comparison of an expected JSON value with an actual one, in three modes. Pure: no I/O and nothing of
// Node, so it runs anywhere JavaScript does.
//
//   exact      same keys and values, arrays in order
//   unordered  as exact, but an array is a multiset: every expected element matches a distinct actual one,
//              and the lengths are equal
//   contains   an object has the expected keys (more are fine); an array has a distinct match for every
//              expected element (more are fine)
//
// The mode is given for the whole comparison and can be changed for one node, and everything under it, by
// writing that node as {"$mode": "<mode>", "$value": <node>}. The keys `$mode` and `$literal` are reserved in
// an expected object: one that has either must be exactly a marker, or it is an error of the expected value.
// Data that really has such a key is written inside {"$literal": <data>}: what is under `$literal` is compared
// as plain data, with no marker read anywhere in it.
//
// A string of the expected value can be a check on the actual value instead of a text to equal:
// `@isString() @minLength(3)`. The rule for which strings are checks, and the escape `@@`, are in functions.ts.
// Under `$literal` no string is a check.

import { firstFailedCheck, parseExpectedString, type CheckSyntaxError } from './functions.js';

export const COMPARE_MODES = ['exact', 'unordered', 'contains'] as const;
export type CompareMode = (typeof COMPARE_MODES)[number];

export type MismatchReason =
  | 'missing-key'
  | 'extra-key'
  | 'type'
  | 'value'
  | 'function'
  | 'missing-element'
  | 'extra-element'
  | 'no-match'
  | 'too-large';

export interface Mismatch {
  /** JSONPath of the place in the answer: `$.a.b[2]`. For `no-match` the index is the expected element's. */
  path: string;
  reason: MismatchReason;
  /** The expected fragment; absent where there is none (an extra key or element). */
  expected?: unknown;
  /** The actual fragment; absent where there is none (a missing key, an element with no match). */
  actual?: unknown;
  detail?: string;
}

export interface ExpectedIssue {
  path: string;
  message: string;
}

/** The expected value itself is wrong (a broken marker or check). An error of the config, never a failed check. */
export class ExpectedJsonError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
    this.name = 'ExpectedJsonError';
  }
}

/**
 * The work one comparison may spend on matching arrays in any order, over all its arrays and every depth: how
 * many times an expected element is tried against an element of the answer. Plain scalars are paired through a
 * map and cost nothing. Past the limit the whole comparison is one `too-large` mismatch.
 */
export const MAX_MATCH_STEPS = 2_000_000;
/** How many elements in a row may each give up their place for one new element; it is the depth of a recursion. */
export const MAX_MATCH_DEPTH = 1000;

type JsonObject = Record<string, unknown>;

const isObject = (v: unknown): v is JsonObject => typeof v === 'object' && v !== null && !Array.isArray(v);
const own = (o: object, key: string): boolean => Object.prototype.hasOwnProperty.call(o, key);
const typeOf = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

const PLAIN_KEY = /^[A-Za-z_$][\w$]*$/;
const keyPath = (path: string, key: string): string =>
  PLAIN_KEY.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;

interface Marker {
  value: unknown;
  mode?: CompareMode;
  literal: boolean;
}

/** The marker an expected object is, `undefined` for plain data, or the message of a broken one. */
function readMarker(exp: JsonObject): Marker | string | undefined {
  const keys = Object.keys(exp);
  if (own(exp, '$literal')) {
    if (keys.length !== 1)
      return 'an object with $literal must have no other key; data with a key $literal goes inside {"$literal": ...}';
    return { value: exp.$literal, literal: true };
  }
  if (!own(exp, '$mode')) return undefined;
  if (keys.length !== 2 || !own(exp, '$value'))
    return 'an object with $mode must have exactly the keys $mode and $value; data with a key $mode goes inside {"$literal": ...}';
  const mode = exp.$mode as CompareMode;
  if (!COMPARE_MODES.includes(mode))
    return `$mode must be one of ${COMPARE_MODES.join(', ')}; got ${JSON.stringify(exp.$mode)}`;
  return { value: exp.$value, mode, literal: false };
}

/** Every error of an expected value, with the path of each. Empty means `compareJson` will not throw. */
export function validateExpected(expected: unknown): ExpectedIssue[] {
  const issues: ExpectedIssue[] = [];
  const visit = (exp: unknown, path: string): void => {
    if (Array.isArray(exp)) exp.forEach((item, i) => visit(item, `${path}[${i}]`));
    else if (isObject(exp)) {
      const marker = readMarker(exp);
      if (typeof marker === 'string') issues.push({ path, message: marker });
      else if (marker === undefined) for (const key of Object.keys(exp)) visit(exp[key], keyPath(path, key));
      else if (!marker.literal) visit(marker.value, path);
    } else if (typeof exp === 'string') {
      try {
        parseExpectedString(exp);
      } catch (err) {
        // The parser throws nothing but a CheckSyntaxError.
        issues.push({ path, message: (err as CheckSyntaxError).message });
      }
    }
  };
  visit(expected, '$');
  return issues;
}

/** What one comparison shares between its walk and every probe inside it. */
interface Budget {
  steps: number;
  /** Set once the matching went over a limit: every walk stops, and this is the comparison's only mismatch. */
  spent?: Mismatch;
}

/** Collects mismatches up to a limit; a probe for "do these two match" stops at the first. */
interface Sink {
  list: Mismatch[];
  limit: number;
  budget: Budget;
}

const done = (sink: Sink): boolean => sink.list.length >= sink.limit || sink.budget.spent !== undefined;

function walk(exp: unknown, act: unknown, mode: CompareMode, path: string, sink: Sink, literal: boolean): void {
  // Every caller has asked done(sink) already.
  if (!literal && isObject(exp)) {
    // Validated before the walk, so a marker here is never a broken one.
    const marker = readMarker(exp) as Marker | undefined;
    if (marker !== undefined) {
      walk(marker.value, act, marker.mode ?? mode, path, sink, marker.literal);
      return;
    }
  }
  if (!literal && typeof exp === 'string') {
    const parsed = parseExpectedString(exp);
    if ('checks' in parsed) {
      const failed = firstFailedCheck(parsed.checks, act);
      if (failed !== undefined)
        sink.list.push({
          path,
          reason: 'function',
          expected: exp,
          actual: act,
          detail: failed.note === undefined ? failed.check.text : `${failed.check.text}: ${failed.note}`,
        });
      return;
    }
    exp = parsed.literal;
  }
  if (typeOf(exp) !== typeOf(act)) {
    sink.list.push({ path, reason: 'type', expected: exp, actual: act });
  } else if (Array.isArray(exp)) {
    (mode === 'exact' ? walkInOrder : walkAnyOrder)(exp, act as unknown[], mode, path, sink, literal);
  } else if (isObject(exp)) {
    walkObject(exp, act as JsonObject, mode, path, sink, literal);
  } else if (exp !== act) {
    sink.list.push({ path, reason: 'value', expected: exp, actual: act });
  }
}

function walkObject(
  exp: JsonObject,
  act: JsonObject,
  mode: CompareMode,
  path: string,
  sink: Sink,
  literal: boolean,
): void {
  for (const key of Object.keys(exp)) {
    if (done(sink)) return;
    const at = keyPath(path, key);
    if (own(act, key)) walk(exp[key], act[key], mode, at, sink, literal);
    else sink.list.push({ path: at, reason: 'missing-key', expected: exp[key] });
  }
  if (mode === 'contains') return;
  for (const key of Object.keys(act))
    if (!own(exp, key)) sink.list.push({ path: keyPath(path, key), reason: 'extra-key', actual: act[key] });
}

function walkInOrder(
  exp: unknown[],
  act: unknown[],
  mode: CompareMode,
  path: string,
  sink: Sink,
  literal: boolean,
): void {
  const shared = Math.min(exp.length, act.length);
  for (let i = 0; i < shared && !done(sink); i++) walk(exp[i], act[i], mode, `${path}[${i}]`, sink, literal);
  for (let i = shared; i < exp.length; i++)
    sink.list.push({ path: `${path}[${i}]`, reason: 'missing-element', expected: exp[i] });
  for (let i = shared; i < act.length; i++)
    sink.list.push({ path: `${path}[${i}]`, reason: 'extra-element', actual: act[i] });
}

const isScalar = (v: unknown): boolean => typeof v !== 'object' || v === null;
/** An expected element that can only match an equal scalar, as that scalar; `undefined` for any other. */
function plainScalar(e: unknown, literal: boolean): { value: unknown } | undefined {
  if (!isScalar(e)) return undefined;
  if (literal || typeof e !== 'string') return { value: e };
  const parsed = parseExpectedString(e);
  return 'literal' in parsed ? { value: parsed.literal } : undefined;
}
const scalarKey = (v: unknown): string => `${typeOf(v)}:${String(v)}`;

/**
 * Arrays as multisets. Two steps, and together they find the largest set of pairs there is:
 *
 * 1. Expected scalars are paired with equal scalars of the answer through a map, in linear time. Equal
 *    scalars are interchangeable for every other expected element, so pairing them first never costs a pair.
 * 2. The rest (objects, arrays, marked nodes, checks) is a bipartite matching, solved with augmenting paths: an
 *    element that fits several places gives its place up when another element has nowhere else to go.
 *    First-fit is wrong here: {a:1} would take {a:1,b:2} and leave an expected {a:1,b:2} with nothing.
 */
function walkAnyOrder(
  exp: unknown[],
  act: unknown[],
  mode: CompareMode,
  path: string,
  sink: Sink,
  literal: boolean,
): void {
  // A probe only asks whether the arrays match: it stops at the first sign that they do not.
  const probing = sink.limit === 1;
  if (probing && (mode === 'unordered' ? exp.length !== act.length : exp.length > act.length)) {
    sink.list.push({ path, reason: 'no-match' });
    return;
  }
  const { budget } = sink;
  const taken = new Uint8Array(act.length);
  const unmatched: number[] = [];
  const rest: number[] = [];

  const scalars = new Map<string, number[]>();
  for (let j = act.length - 1; j >= 0; j--) {
    if (!isScalar(act[j])) continue;
    const key = scalarKey(act[j]);
    const at = scalars.get(key);
    if (at === undefined) scalars.set(key, [j]);
    else at.push(j);
  }
  exp.forEach((e, i) => {
    const plain = plainScalar(e, literal);
    if (plain === undefined) return rest.push(i);
    const j = scalars.get(scalarKey(plain.value))?.pop();
    if (j === undefined) return unmatched.push(i);
    taken[j] = 1;
  });

  if (rest.length > 0 && !(probing && unmatched.length > 0)) {
    const open: number[] = [];
    for (let j = 0; j < act.length; j++) if (taken[j] === 0) open.push(j);
    // Asked pairs only: an array of 100,000 objects in order asks 100,000, not 10^10.
    const fits = new Map<number, boolean>();
    const fit = (e: number, c: number): boolean => {
      const at = e * open.length + c;
      let known = fits.get(at);
      if (known === undefined) {
        const probe: Sink = { list: [], limit: 1, budget };
        walk(exp[rest[e]!], act[open[c]!], mode, path, probe, literal);
        known = probe.list.length === 0;
        fits.set(at, known);
      }
      return known;
    };
    const holder = new Int32Array(open.length).fill(-1);
    // seen[c] === round: candidate c was already tried for the element of this round.
    const seen = new Int32Array(open.length).fill(-1);
    const place = (e: number, round: number, depth: number): boolean => {
      if (depth > MAX_MATCH_DEPTH) {
        budget.spent = {
          path,
          reason: 'too-large',
          detail: `matching arrays in any order moved more than ${MAX_MATCH_DEPTH} elements for one`,
        };
        return false;
      }
      // From the element's own position on: arrays that are already in order match in one try each.
      for (let n = 0; n < open.length; n++) {
        const c = (e + n) % open.length;
        if (seen[c] === round) continue;
        if (--budget.steps < 0) {
          budget.spent = {
            path,
            reason: 'too-large',
            detail: `matching arrays in any order took more than ${MAX_MATCH_STEPS} comparisons of elements`,
          };
          return false;
        }
        if (!fit(e, c) || budget.spent !== undefined) continue;
        seen[c] = round;
        if (holder[c] === -1 || place(holder[c]!, round, depth + 1)) {
          holder[c] = e;
          return true;
        }
        if (budget.spent !== undefined) return false;
      }
      return false;
    };
    for (let e = 0; e < rest.length; e++) {
      const placed = place(e, e, 0);
      if (budget.spent !== undefined) return;
      if (placed) continue;
      unmatched.push(rest[e]!);
      if (probing) break;
    }
    holder.forEach((e, c) => {
      if (e !== -1) taken[open[c]!] = 1;
    });
  }

  for (const i of unmatched.sort((a, b) => a - b))
    sink.list.push({ path: `${path}[${i}]`, reason: 'no-match', expected: exp[i] });
  if (mode === 'contains') return;
  for (let j = 0; j < act.length; j++)
    if (taken[j] === 0) sink.list.push({ path: `${path}[${j}]`, reason: 'extra-element', actual: act[j] });
}

export interface CompareOptions {
  /** The mode of the whole comparison; a `$mode` marker changes it for one node. Default `exact`. */
  mode?: CompareMode;
}

/**
 * Every mismatch between `expected` and `actual`, in a stable order: depth first, the expected keys in their
 * order, then the keys only the answer has. An empty list means they match.
 *
 * @throws ExpectedJsonError when `expected` holds a broken marker or check; `validateExpected` finds those ahead.
 */
export function compareJson(expected: unknown, actual: unknown, options: CompareOptions = {}): Mismatch[] {
  const issue = validateExpected(expected)[0];
  if (issue !== undefined) throw new ExpectedJsonError(issue.path, issue.message);
  const sink: Sink = { list: [], limit: Infinity, budget: { steps: MAX_MATCH_STEPS } };
  walk(expected, actual, options.mode ?? 'exact', '$', sink, false);
  return sink.budget.spent === undefined ? sink.list : [sink.budget.spent];
}
