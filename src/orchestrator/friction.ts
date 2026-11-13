// Friction signals of an agentic row (MCP-D7): where the model spent steps it may not have needed. Advice only, never a
// verdict: each signal has a reading that is harmless, and says so. Pure. The results of the tools must be in memory
// to be read for identifiers, so the loop scans each answer as it comes (`scanIds`) and calls `frictionAdvice` at the
// end; the stored transcript keeps excerpts and could not do this later.
//
// Only names, step numbers, counts and the paths of the keys where an identifier was found leave this module. The
// identifiers themselves never do.

import type { AgentAdvice } from '../types/results.js';
import { sha256 } from '../util/hash.js';
import { isIdenticalCall, isPageTurn } from '../util/tool-calls.js';

/** How deep a result is walked, and how many items of one array are looked at. */
export const SCAN_DEPTH = 6;
export const SCAN_ITEMS = 50;
const MAX_PATHS = 10;
const MAX_PATH = 120;
/** A string shorter than this is too common to say it is the same record. Numbers are never compared. */
const MIN_VALUE = 6;

// A key holds an identifier when its name is one of these words, ends in one after an underscore (`user_id`) or after a
// capital (`userId`). A capital must follow a lower-case letter or digit, so `Valid` does not read as `...Id`.
const WORDS = 'id|ids|key|uuid|slug|number|ref|identifier';
const WHOLE = new RegExp(`^(?:${WORDS})$`, 'i');
const SNAKE = new RegExp(`_(?:${WORDS})$`, 'i');
const CAMEL = /[a-z0-9](?:Id|Ids|Uuid|Key|Slug|Number|Ref|Identifier)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isIdKey = (key: string): boolean =>
  WHOLE.test(key) || SNAKE.test(key) || CAMEL.test(key);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isScalar = (v: unknown): v is string | number =>
  (typeof v === 'string' && v !== '') || (typeof v === 'number' && Number.isFinite(v));

const EMAIL = /@/;
// A key of an object that is itself data (a UUID, an address, a number, a long or odd string) is not a name.
function segment(key: string): string {
  const plain =
    /^[A-Za-z_][\w-]*$/.test(key) && key.length <= 40 && !UUID.test(key) && !EMAIL.test(key);
  return plain ? key : '*';
}

interface Found {
  paths: Set<string>;
  /** Hash of an identifier value to the paths it was seen at. The value itself is never kept. */
  values: Map<string, Set<string>>;
}

const cap = (path: string): string => (path.length > MAX_PATH ? path.slice(0, MAX_PATH) : path);
const hashOf = (v: string): string => sha256(v).slice(0, 16);

function noteValue(out: Found, v: unknown, at: string): void {
  if (typeof v !== 'string' || v.length < MIN_VALUE) return;
  const h = hashOf(v);
  const where = out.values.get(h) ?? new Set<string>();
  where.add(at);
  out.values.set(h, where);
}

function walk(value: unknown, path: string, depth: number, out: Found): void {
  if (depth > SCAN_DEPTH) return;
  if (typeof value === 'string' && UUID.test(value)) {
    const at = cap(path === '' ? '(root)' : path);
    out.paths.add(at);
    noteValue(out, value, at);
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, SCAN_ITEMS)) walk(item, `${path}[]`, depth + 1, out);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, v] of Object.entries(value)) {
    const at = cap(path === '' ? segment(key) : `${path}.${segment(key)}`);
    if (isIdKey(key) && (isScalar(v) || (Array.isArray(v) && v.length > 0 && v.every(isScalar)))) {
      out.paths.add(at);
      for (const x of Array.isArray(v) ? v : [v]) noteValue(out, x, at);
    }
    walk(v, at, depth + 1, out);
  }
}

/**
 * The key paths of a tool's answer that hold identifiers, and the hashes of the values that are long enough to compare
 * (a string of 6 characters or more, or a UUID), or why the answer could not be read. The hashes stay in memory.
 */
export type IdScan =
  | { paths: string[]; values: { hash: string; paths: string[] }[] }
  | { unreadable: string };

/** `result` is the tools/call result as the server sent it. Structured content is walked, then each text block that is JSON. */
export function scanIds(result: unknown): IdScan {
  const found: Found = { paths: new Set(), values: new Map() };
  let readable = false;
  if (isRecord(result)) {
    if (result.structuredContent !== undefined) {
      readable = true;
      walk(result.structuredContent, '', 0, found);
    }
    if (Array.isArray(result.content))
      for (const block of result.content as unknown[]) {
        if (!isRecord(block) || block.type !== 'text' || typeof block.text !== 'string') continue;
        try {
          walk(JSON.parse(block.text) as unknown, '', 0, found);
          readable = true;
        } catch {
          // Not JSON: another block may be.
        }
      }
  }
  if (!readable) return { unreadable: 'the answer is not JSON' };
  return {
    paths: [...found.paths].sort().slice(0, MAX_PATHS),
    values: [...found.values].map(([hash, at]) => ({ hash, paths: [...at].sort() })),
  };
}

export interface FrictionCall {
  /** From 1, as in the transcript. Calls of one step ran from one model turn, so none could read another's answer. */
  step: number;
  name: string;
  args: unknown;
  executed: boolean;
  is_error: boolean;
  /** Set for a call that was executed and answered without an error. */
  ids?: IdScan;
}

const list = (steps: number[]): string => steps.join(', ');

interface Acc {
  type: string;
  tool: string;
  steps: Set<number>;
  count: number;
  paths: Set<string>;
  note: string | undefined;
}

/**
 * The signals of one row, in the order they first appear. `identical-retry` and `pagination-continuation` compare
 * each call with the one right before it; `search-after-id` compares a call with calls of an EARLIER step only.
 * An answer that could not be read gives `friction-unmeasured` for that pair, never "no signal".
 */
export function frictionAdvice(calls: FrictionCall[]): AgentAdvice[] {
  const acc = new Map<string, Acc>();
  const add = (
    type: string,
    tool: string,
    steps: number[],
    paths: string[] = [],
    note?: string,
  ): void => {
    const key = `${type}\0${tool}`;
    let a = acc.get(key);
    if (a === undefined) {
      a = { type, tool, steps: new Set(), count: 0, paths: new Set(), note };
      acc.set(key, a);
    }
    steps.forEach((s) => a.steps.add(s));
    paths.forEach((p) => a.paths.add(p));
    a.count++;
  };

  const sent = calls.filter((c) => c.executed);
  for (let j = 1; j < sent.length; j++) {
    const [prev, cur] = [sent[j - 1]!, sent[j]!];
    if (isIdenticalCall(prev, cur)) add('identical-retry', cur.name, [prev.step, cur.step]);
    else if (isPageTurn(prev, cur)) add('pagination-continuation', cur.name, [prev.step, cur.step]);
  }

  // A later call of the same tool that gives back a record an earlier step already gave: the model looked for what it
  // had. Calls of one step ran from one model turn, so only earlier STEPS count.
  for (const [j, cur] of sent.entries()) {
    if (cur.is_error) continue;
    const before = sent.slice(0, j).filter(
      (e) =>
        e.step < cur.step &&
        e.name === cur.name &&
        !e.is_error &&
        // The same arguments, or a page turn, is another signal and not a search after an identifier.
        !isIdenticalCall(e, cur) &&
        !isPageTurn(e, cur),
    );
    if (before.length === 0) continue;
    const scans = [cur, ...before].map((c) => c.ids);
    const unread = scans.some((x) => x === undefined || 'unreadable' in x);
    if (unread || cur.ids === undefined || 'unreadable' in cur.ids) {
      const named = scans.find((x) => x !== undefined && 'unreadable' in x);
      const why =
        named !== undefined && 'unreadable' in named ? named.unreadable : 'no answer was kept';
      // One note per call, so a server with text answers gets one line for the tool, not one for every pair.
      add('friction-unmeasured', cur.name, [...before.map((e) => e.step), cur.step], [], why);
      continue;
    }
    const mine = new Map(cur.ids.values.map((v) => [v.hash, v.paths]));
    const shared = before.filter((e) => {
      const ids = e.ids as { values: { hash: string }[] };
      return ids.values.some((v) => mine.has(v.hash));
    });
    if (shared.length === 0) continue;
    const seen = new Set(
      shared.flatMap((e) => (e.ids as { values: { hash: string }[] }).values.map((v) => v.hash)),
    );
    const paths = [...mine].filter(([h]) => seen.has(h)).flatMap(([, p]) => p);
    add('search-after-id', cur.name, [...shared.map((e) => e.step), cur.step], paths);
  }

  return [...acc.values()].map((a) => {
    const steps = [...a.steps].sort((x, y) => x - y);
    const paths = [...a.paths].sort();
    const base = {
      type: a.type,
      tool: a.tool,
      steps,
      count: a.count,
      ...(paths.length > 0 ? { paths } : {}),
    };
    if (a.type === 'identical-retry')
      return {
        ...base,
        reason: `${a.tool} was called again ${a.count} time(s) with the same arguments right after itself (steps ${list(steps)}); this may be fine if the first call failed or the state changed in between`,
      };
    if (a.type === 'pagination-continuation')
      return {
        ...base,
        reason: `${a.tool} continued through a list with a new page or cursor ${a.count} time(s) (steps ${list(steps)}); this is not a repeat and may be exactly what the task needs`,
      };
    if (a.type === 'search-after-id')
      return {
        ...base,
        reason: `${a.tool} was called again ${a.count} time(s) with other arguments and it returned a record that an earlier step had already returned (identifier at ${paths.join(', ')}; steps ${list(steps)}); this may be fine if the model needed the record again`,
      };
    return {
      ...base,
      reason: `${a.tool}: not measured, ${a.note ?? 'the answer could not be read'}, so identifiers were not looked for (steps ${list(steps)}); this is not the same as finding none`,
    };
  });
}
