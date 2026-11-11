import { ProtocolError } from '@modelcontextprotocol/client';
import type { ListedTool } from '../lint/types.js';
import { selectSafeTools } from './safe-tools.js';
import { ConnectError, type Session } from './session.js';

// Reading a server's lists to their last page, choosing which of its tools `plune` may call on its own, and making
// such a call: shared by `plune mcp lint --call` and `plune mcp check --smoke`, so the two never disagree on what is
// safe to call or on what an answer was.

/** Pages read at most: a server that always answers with a cursor would otherwise be read forever. */
export const MAX_PAGES = 100;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export interface Listing {
  items: unknown[];
  pages: number;
  /** False when the pages did not end within MAX_PAGES. */
  complete: boolean;
  /** A page was not an object with a `key` list: whatever it held could not be read. */
  malformed: boolean;
}

/**
 * `method` to its last page. A JSON-RPC error or a lost server rejects, as `Session.request` does. Once `signal`
 * aborts, no further page is asked for: the listing ends incomplete.
 */
export async function listAll(
  session: Pick<Session, 'request'>,
  method: string,
  key: string,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<Listing> {
  const items: unknown[] = [];
  let malformed = false;
  let cursor: string | undefined;
  for (let pages = 1; pages <= MAX_PAGES; pages++) {
    if (opts.signal?.aborted === true)
      return { items, pages: pages - 1, complete: false, malformed };
    const page = await session.request(
      method,
      cursor === undefined ? undefined : { cursor },
      opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs },
    );
    const listed = isRecord(page) ? page[key] : undefined;
    // One by one: spreading a server's page into push() overflows the stack from about 130 000 entries.
    if (Array.isArray(listed)) for (const item of listed as unknown[]) items.push(item);
    else malformed = true;
    cursor =
      isRecord(page) && typeof page.nextCursor === 'string' && page.nextCursor !== ''
        ? page.nextCursor
        : undefined;
    if (cursor === undefined) return { items, pages, complete: true, malformed };
  }
  return { items, pages: MAX_PAGES, complete: false, malformed };
}

/**
 * A `tools/list` as tools. An entry that is not an object, or has no string name, keeps its place under an empty name
 * (the lint's name rules report it); `unnamed` holds those entries with what they had for a name, so none is called.
 */
export function asTools(items: readonly unknown[]): {
  tools: ListedTool[];
  unnamed: Map<ListedTool, string>;
} {
  const tools: ListedTool[] = [];
  const unnamed = new Map<ListedTool, string>();
  for (const t of items) {
    const name = isRecord(t) ? t.name : undefined;
    if (typeof name === 'string' && name !== '') {
      tools.push(t as unknown as ListedTool);
      continue;
    }
    const tool: ListedTool = { ...(isRecord(t) ? t : {}), name: '' };
    unnamed.set(tool, name === undefined ? '(no name)' : String(JSON.stringify(name)));
    tools.push(tool);
  }
  return { tools, unnamed };
}

/**
 * The tools `plune` may call with `{}`: what `selectSafeTools` allows, less every entry without a name and every name
 * the whole list holds twice (tools/call picks by name, so a read-only entry could run a destructive one). `skipped`
 * names each tool left out and why, in list order: the name reasons first.
 */
export function callableTools(
  tools: readonly ListedTool[],
  unnamed: ReadonlyMap<ListedTool, string>,
  opts: { allowWrite?: boolean } = {},
): { safe: ListedTool[]; skipped: { tool: string; reason: string }[] } {
  const counts = new Map<string, number>();
  for (const t of tools) if (!unnamed.has(t)) counts.set(t.name, (counts.get(t.name) ?? 0) + 1);
  const refused: { tool: string; reason: string }[] = [];
  const candidates: ListedTool[] = [];
  for (const t of tools) {
    const label = unnamed.get(t);
    if (label !== undefined) refused.push({ tool: label, reason: 'invalid-name' });
    else if ((counts.get(t.name) ?? 0) > 1)
      refused.push({ tool: t.name, reason: 'duplicate-name' });
    else candidates.push(t);
  }
  const { safe, skipped } = selectSafeTools(candidates, opts);
  return {
    safe,
    skipped: [...refused, ...skipped.map((s) => ({ tool: s.tool.name, reason: s.reason }))],
  };
}

/** What one call came to: an answer, a JSON-RPC error, no answer in time, or a server that is gone. */
export type CallAnswer =
  | { kind: 'result'; result: unknown }
  | { kind: 'error'; message: string }
  | { kind: 'timeout' }
  | { kind: 'lost'; message: string };

/** `tools/call`, with `{}` for arguments unless the caller has some (the model's, in an agentic eval). */
export async function callTool(
  session: Pick<Session, 'request'>,
  name: string,
  timeoutMs: number,
  args: Record<string, unknown> = {},
): Promise<CallAnswer> {
  try {
    const result = await session.request('tools/call', { name, arguments: args }, { timeoutMs });
    return { kind: 'result', result };
  } catch (err) {
    if (err instanceof ConnectError) {
      // Credentials refused: not this call's answer but the whole connection's, so the command decides.
      if (err.kind === 'auth') throw err;
      return err.kind === 'timeout' ? { kind: 'timeout' } : { kind: 'lost', message: err.message };
    }
    if (err instanceof ProtocolError) return { kind: 'error', message: err.message };
    throw err;
  }
}
