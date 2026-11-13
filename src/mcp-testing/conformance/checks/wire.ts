/**
 * What every check module shares: a request over the session's raw layer (never the SDK client, which would normalise
 * the answer and hide what is wrong with it), the declared capabilities, a list walked once per run, and the outcomes
 * in their usual words.
 */

import type { Redactor } from '../../connect/redact.js';
import type { RawOptions, RawReply } from '../../connect/session.js';
import type { CheckOutcome } from '../outcome.js';
import type { ConformanceContext } from './index.js';
import { modernMeta } from './modern/meta.js';

/** `status`: the HTTP status the answer came with (Streamable HTTP only). */
export type Answer =
  | { kind: 'result'; result: Record<string, unknown>; frame: Record<string, unknown>; status?: number }
  | { kind: 'error'; code: unknown; message: string; frame: Record<string, unknown>; status?: number }
  /** No JSON-RPC answer: an HTTP error page, or a frame with neither a result object nor an error object. */
  | { kind: 'other'; text: string; status?: number };

export const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

let counter = 0;
/** A request id of this checker: a string, so it never meets the SDK's own numbered ones. */
export const nextId = (): string => `plune-conformance-${++counter}`;

export function answerOf(reply: RawReply, redact: Redactor): Answer {
  const f = reply.frame;
  const status = reply.status !== undefined ? { status: reply.status } : {};
  if (f !== undefined) {
    const error = f['error'];
    if (isObject(error))
      // The message is masked here, whole: said() cuts it afterwards, and a secret cut in two cannot be found again.
      return {
        kind: 'error',
        code: error['code'],
        message: typeof error['message'] === 'string' ? redact.text(error['message']) : '',
        frame: f,
        ...status,
      };
    const result = f['result'];
    if (isObject(result)) return { kind: 'result', result, frame: f, ...status };
  }
  return { kind: 'other', text: reply.text, ...status };
}

/** The params of a request in the run's era: in the modern era with the per-request `_meta` (basic/index, `_meta`). */
export function eraParams(ctx: ConformanceContext, params?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (ctx.era !== 'modern') return params;
  const given = params?.['_meta'];
  return { ...params, _meta: { ...modernMeta(ctx.protocolVersion ?? '2026-07-28'), ...(isObject(given) ? given : {}) } };
}

/**
 * One request, as written here, over stdio or one POST, with the `_meta` of the modern era. A server that does not
 * answer rejects with a ConnectError.
 */
export async function call(
  ctx: ConformanceContext,
  method: string,
  params?: Record<string, unknown>,
  options?: RawOptions,
): Promise<Answer> {
  return callAsIs(ctx, method, eraParams(ctx, params), options);
}

/** One request with its params exactly as given: no `_meta` is added, so a probe can leave a field out. */
export async function callAsIs(
  ctx: ConformanceContext,
  method: string,
  params?: Record<string, unknown>,
  options?: RawOptions,
): Promise<Answer> {
  const id = nextId();
  const message = { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) };
  return answerOf(await ctx.session.raw(JSON.stringify(message), id, options), ctx.session.redact);
}

/** What an answer was, in a few words, for `actual`. */
export function said(a: Answer): string {
  if (a.kind === 'result') return 'a result';
  if (a.kind === 'error') return `error ${String(a.code)}${a.message === '' ? '' : ` (${a.message.slice(0, 120)})`}`;
  const status = a.status === undefined ? '' : ` (HTTP ${a.status})`;
  return `no JSON-RPC answer${status}${a.text === '' ? '' : `: ${a.text.slice(0, 160)}`}`;
}

/** The capabilities of the initialize result, or of server/discover in the modern era, as sent ({} when none). */
export function capabilities(ctx: ConformanceContext): Record<string, unknown> {
  const result = ctx.era === 'modern' ? (ctx.discover?.kind === 'result' ? ctx.discover.result : undefined) : ctx.session.handshake.result;
  return isObject(result) && isObject(result['capabilities']) ? result['capabilities'] : {};
}

/** The revisions server/discover named in a modern run; empty when it named none. */
export function supportedVersions(ctx: ConformanceContext): string[] {
  const v = ctx.discover?.kind === 'result' ? ctx.discover.result['supportedVersions'] : undefined;
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** A modern server that serves the legacy era as well: server/discover names a revision before 2026-07-28. */
export const dualEra = (ctx: ConformanceContext): boolean => supportedVersions(ctx).some((v) => v < '2026-07-28');

export const declares = (ctx: ConformanceContext, name: string): boolean => {
  const value = capabilities(ctx)[name];
  return value !== undefined && value !== null;
};

export const passed = (actual: string): CheckOutcome => ({ state: 'passed', actual });
export const failed = (actual: string, fix: string): CheckOutcome => ({ state: 'failed', actual, fix });
export const notDeclared = (capability: string): CheckOutcome => ({
  state: 'not-applicable',
  reason: 'capability-not-declared',
  actual: `The server does not declare the ${capability} capability.`,
});
export const notOffered = (actual: string): CheckOutcome => ({ state: 'not-applicable', reason: 'not-offered', actual });
export const prerequisite = (actual: string): CheckOutcome => ({
  state: 'could-not-run',
  reason: 'prerequisite-failed',
  actual,
});

/** A few items of a list for `actual`, and how many more. */
export const some = (items: readonly string[], n = 5): string =>
  items.length <= n ? items.join(', ') : `${items.slice(0, n).join(', ')} and ${items.length - n} more`;

/** The most pages a list is followed for: our limit, not the specification's. */
export const PAGE_LIMIT = 64;

export interface Walk {
  items: unknown[];
  /** Each page's items, in order. */
  pages: unknown[][];
  /** Each page's result as the server sent it. */
  results: Record<string, unknown>[];
  /** nextCursor was absent on the last page read. */
  ended: boolean;
  repeatedCursor: boolean;
  /** The answer that was not a result, when a page was refused. */
  stop?: Answer;
  /** Why a page that answered is not a page of this list. */
  badPage?: string;
}

/** Every page of a list, read once per run: the checks that read the list share it. */
export function walk(ctx: ConformanceContext, method: string, field: string): Promise<Walk> {
  return ctx.memo(`walk ${method}`, async () => {
    const w: Walk = { items: [], pages: [], results: [], ended: false, repeatedCursor: false };
    const cursors = new Set<string>();
    let cursor: string | undefined;
    while (w.pages.length < PAGE_LIMIT) {
      const a = await call(ctx, method, cursor === undefined ? undefined : { cursor });
      if (a.kind !== 'result') return { ...w, stop: a };
      const list = a.result[field];
      if (!Array.isArray(list))
        return { ...w, badPage: `page ${w.pages.length + 1} of ${method} has no ${field} list` };
      w.pages.push(list);
      w.results.push(a.result);
      w.items.push(...list);
      const next = a.result['nextCursor'];
      if (next === undefined || next === null) return { ...w, ended: true };
      if (typeof next !== 'string') return { ...w, badPage: `nextCursor on page ${w.pages.length} of ${method} is not a string` };
      if (cursors.has(next)) return { ...w, repeatedCursor: true };
      cursors.add(next);
      cursor = next;
    }
    return w;
  });
}

/**
 * The entries of a declared list for a check that reads them, or the outcome when they cannot be read: the capability
 * is not declared (not-applicable), the list was refused (could-not-run: `life-capabilities-declared-served` judges
 * that), or a page is not a page (failed).
 */
export async function entries(
  ctx: ConformanceContext,
  capability: string,
  method: string,
  field: string,
): Promise<unknown[] | CheckOutcome> {
  if (!declares(ctx, capability)) return notDeclared(capability);
  const w = await walk(ctx, method, field);
  if (w.stop !== undefined) return prerequisite(`${method} answered ${said(w.stop)}.`);
  if (w.badPage !== undefined) return failed(`${w.badPage}.`, `Answer ${method} with a result that holds a ${field} array.`);
  return w.items;
}

export const isOutcome = (v: unknown[] | CheckOutcome): v is CheckOutcome => !Array.isArray(v);

/** A name for an entry in `actual`: its name, uri or position. */
export const label = (entry: unknown, i: number): string => {
  if (isObject(entry)) for (const k of ['name', 'uri', 'uriTemplate']) if (typeof entry[k] === 'string') return String(entry[k]);
  return `#${i + 1}`;
};
