// What two tool calls have in common, in one place for the heuristic check `no-repeated-call` and the friction
// signals of a run (MCP-D7), so both read a repeat and a page turn the same way. Pure.

import { canonicalJson } from './canonical-json.js';

/** Argument names that only move through a list. A call that differs from the one before in these alone is a page turn. */
export const PAGINATION_KEYS: readonly string[] = [
  'cursor',
  'page',
  'offset',
  'limit',
  'after',
  'before',
  'start',
  'pageToken',
  'page_token',
  'nextCursor',
  'next_cursor',
];

export interface CallLike {
  name: string;
  args: unknown;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Both are JSON values; equal when they serialize alike, key order aside. A missing value equals nothing. */
function sameValue(a: unknown, b: unknown): boolean {
  return a !== undefined && b !== undefined && canonicalJson(a) === canonicalJson(b);
}

function withoutPagination(args: unknown): unknown {
  if (!isRecord(args)) return args;
  return Object.fromEntries(Object.entries(args).filter(([k]) => !PAGINATION_KEYS.includes(k)));
}

/** The same tool with the same arguments (key order aside). Any changed argument, a cursor too, makes it another call. */
export function isIdenticalCall(a: CallLike, b: CallLike): boolean {
  return a.name === b.name && sameValue(a.args, b.args);
}

/** The same tool whose arguments differ in pagination keys alone: not a repeat. */
export function isPageTurn(a: CallLike, b: CallLike): boolean {
  return (
    a.name === b.name &&
    !isIdenticalCall(a, b) &&
    sameValue(withoutPagination(a.args), withoutPagination(b.args))
  );
}
