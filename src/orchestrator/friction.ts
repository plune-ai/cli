// Friction signals of an agentic row (MCP-D7): where the model spent steps it may not have needed. Advice only, never a
// verdict: each signal has a reading that is harmless, and says so. Pure. The results of the tools must be in memory
// to be read for identifiers, so the loop scans each answer as it comes (`scanIds`) and calls `frictionAdvice` at the
// end; the stored transcript keeps excerpts and could not do this later.
//
// Only names, step numbers, counts and the paths of the keys where an identifier was found leave this module. The
// identifiers themselves never do.

import type { AgentAdvice } from '../types/results.js';
import { isIdenticalCall, isPageTurn } from '../util/tool-calls.js';

/** How deep a result is walked, and how many items of one array are looked at. */
export const SCAN_DEPTH = 6;
export const SCAN_ITEMS = 50;
const MAX_PATHS = 10;

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

function walk(value: unknown, path: string, depth: number, out: Set<string>): void {
  if (depth > SCAN_DEPTH) return;
  if (typeof value === 'string' && UUID.test(value)) out.add(path === '' ? '(root)' : path);
  if (Array.isArray(value)) {
    for (const item of value.slice(0, SCAN_ITEMS)) walk(item, `${path}[]`, depth + 1, out);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, v] of Object.entries(value)) {
    const at = path === '' ? key : `${path}.${key}`;
    if (isIdKey(key) && (isScalar(v) || (Array.isArray(v) && v.length > 0 && v.every(isScalar))))
      out.add(at);
    walk(v, at, depth + 1, out);
  }
}

/** The key paths of a tool's answer that hold identifiers, or why the answer could not be read. */
export type IdScan = { paths: string[] } | { unreadable: string };

/** `result` is the tools/call result as the server sent it. Structured content is walked, then each text block that is JSON. */
export function scanIds(result: unknown): IdScan {
  const found = new Set<string>();
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
  return { paths: [...found].sort().slice(0, MAX_PATHS) };
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

  for (const [j, cur] of sent.entries())
    for (const earlier of sent.slice(0, j)) {
      if (earlier.step >= cur.step || earlier.name !== cur.name || earlier.is_error) continue;
      // The same arguments, or a page turn, is another signal and not a search after an identifier.
      if (isIdenticalCall(earlier, cur) || isPageTurn(earlier, cur)) continue;
      const ids = earlier.ids;
      if (ids === undefined || 'unreadable' in ids)
        add(
          'friction-unmeasured',
          cur.name,
          [earlier.step, cur.step],
          [],
          ids === undefined ? 'no answer was kept' : ids.unreadable,
        );
      else if (ids.paths.length > 0)
        add('search-after-id', cur.name, [earlier.step, cur.step], ids.paths);
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
        reason: `${a.tool} was called again ${a.count} time(s) with other arguments after an earlier step had already returned identifiers (at ${paths.join(', ')}; steps ${list(steps)}); this may be fine if the new call asks for something the first did not return`,
      };
    return {
      ...base,
      reason: `${a.tool}: not measured, ${a.note ?? 'the answer could not be read'}, so identifiers were not looked for (steps ${list(steps)}); this is not the same as finding none`,
    };
  });
}
