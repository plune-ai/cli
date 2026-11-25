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

export const COMPARE_MODES = ['exact', 'unordered', 'contains'] as const;
export type CompareMode = (typeof COMPARE_MODES)[number];

export type MismatchReason =
  | 'missing-key'
  | 'extra-key'
  | 'type'
  | 'value'
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

/** The expected value itself is wrong (a broken marker). An error of the config, never a failed check. */
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
 * The most pairs (expected element, actual element) one array is matched over, counted after the plain
 * scalars are paired off. Matching is by augmenting paths: at most that many element comparisons, and in the
 * worst case that many steps again for each expected element. A larger array is reported as `too-large`.
 */
export const MAX_MATCH_PAIRS = 250_000;

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
    }
  };
  visit(expected, '$');
  return issues;
}

/** Collects mismatches up to a limit; a probe for "do these two match" stops at the first. */
interface Sink {
  list: Mismatch[];
  limit: number;
}

function walk(exp: unknown, act: unknown, mode: CompareMode, path: string, sink: Sink, literal: boolean): void {
  if (sink.list.length >= sink.limit) return;
  if (!literal && isObject(exp)) {
    // Validated before the walk, so a marker here is never a broken one.
    const marker = readMarker(exp) as Marker | undefined;
    if (marker !== undefined) {
      walk(marker.value, act, marker.mode ?? mode, path, sink, marker.literal);
      return;
    }
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
  for (let i = 0; i < shared; i++) walk(exp[i], act[i], mode, `${path}[${i}]`, sink, literal);
  for (let i = shared; i < exp.length; i++)
    sink.list.push({ path: `${path}[${i}]`, reason: 'missing-element', expected: exp[i] });
  for (let i = shared; i < act.length; i++)
    sink.list.push({ path: `${path}[${i}]`, reason: 'extra-element', actual: act[i] });
}

/** A scalar that can only match an equal scalar: every element that is not an array or an object. */
const isScalar = (v: unknown): boolean => typeof v !== 'object' || v === null;
const scalarKey = (v: unknown): string => `${typeOf(v)}:${String(v)}`;

/**
 * Arrays as multisets. Two steps, and together they find the largest set of pairs there is:
 *
 * 1. Expected scalars are paired with equal scalars of the answer through a map, in linear time. Equal
 *    scalars are interchangeable for every other expected element, so pairing them first never costs a pair.
 * 2. The rest (objects, arrays, marked nodes) is a bipartite matching, solved with augmenting paths: an
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
    if (!isScalar(e)) return rest.push(i);
    const j = scalars.get(scalarKey(e))?.pop();
    if (j === undefined) return unmatched.push(i);
    taken[j] = 1;
  });

  if (rest.length > 0) {
    const open: number[] = [];
    for (let j = 0; j < act.length; j++) if (taken[j] === 0) open.push(j);
    if (rest.length * open.length > MAX_MATCH_PAIRS) {
      sink.list.push({
        path,
        reason: 'too-large',
        detail: `${rest.length} expected elements against ${open.length} of the answer is over the limit of ${MAX_MATCH_PAIRS} pairs`,
      });
      return;
    }
    // fits[e * open.length + c]: 0 not asked yet, 1 yes, 2 no.
    const fits = new Uint8Array(rest.length * open.length);
    const fit = (e: number, c: number): boolean => {
      const at = e * open.length + c;
      if (fits[at] === 0) {
        const probe: Sink = { list: [], limit: 1 };
        walk(exp[rest[e]!], act[open[c]!], mode, path, probe, literal);
        fits[at] = probe.list.length === 0 ? 1 : 2;
      }
      return fits[at] === 1;
    };
    const holder = new Int32Array(open.length).fill(-1);
    const place = (e: number, seen: Uint8Array): boolean => {
      for (let c = 0; c < open.length; c++) {
        if (seen[c] === 1 || !fit(e, c)) continue;
        seen[c] = 1;
        if (holder[c] === -1 || place(holder[c]!, seen)) {
          holder[c] = e;
          return true;
        }
      }
      return false;
    };
    rest.forEach((i, e) => {
      if (!place(e, new Uint8Array(open.length))) unmatched.push(i);
    });
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
 * @throws ExpectedJsonError when `expected` holds a broken marker; `validateExpected` finds those ahead.
 */
export function compareJson(expected: unknown, actual: unknown, options: CompareOptions = {}): Mismatch[] {
  const issue = validateExpected(expected)[0];
  if (issue !== undefined) throw new ExpectedJsonError(issue.path, issue.message);
  const sink: Sink = { list: [], limit: Infinity };
  walk(expected, actual, options.mode ?? 'exact', '$', sink, false);
  return sink.list;
}
