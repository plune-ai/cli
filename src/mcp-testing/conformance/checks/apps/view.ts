/**
 * What the checks of the apps suite share: which tools have a UI, which `ui://` resources are read and how, and the
 * words for what was found. The suite only reads (tools/list, resources/list, resources/read of a `ui://` address a
 * tool or the list names); what the server sends is text of a stranger, so the HTML is never printed, parsed or run,
 * and an address, a name or a media type is quoted and cut before it reaches `actual`.
 */

import type { CheckOutcome } from '../../outcome.js';
import type { ConformanceContext } from '../index.js';
import { tools } from '../tools.js';
import {
  call,
  capabilities,
  entries,
  isObject,
  isOutcome,
  notOffered,
  prerequisite,
  said,
  some,
} from '../wire.js';

export const UI_EXTENSION = 'io.modelcontextprotocol/ui';
export const APP_MIME = 'text/html;profile=mcp-app';
export const UI_SCHEME = 'ui://';
/** The largest HTML document that is judged: our limit, not the specification's. */
export const MAX_UI_BYTES = 4 * 1024 * 1024;
/** The most ui:// resources read in one run. */
export const MAX_UI_READS = 32;
const SHOWN = 60;

/** A string of the server in a sentence of ours: quoted, cut, with its length when cut. */
export const kind = (value: unknown): string =>
  Array.isArray(value) ? 'an array' : value === null ? 'null' : `a ${typeof value}`;

export const quoter =
  (ctx: ConformanceContext) =>
  (value: unknown): string => {
    if (typeof value !== 'string') return kind(value);
    // Masked first, then cut: a secret longer than the part kept would otherwise leave a prefix the report cannot find.
    const text = ctx.session.redact.text(value);
    return text.length <= SHOWN
      ? JSON.stringify(text)
      : `${JSON.stringify(`${text.slice(0, SHOWN)}…`)} (${text.length} characters)`;
  };

/** A media type as a media type: letter case and white space do not count. */
export const sameMime = (value: unknown, wanted: string): boolean =>
  typeof value === 'string' && value.toLowerCase().replace(/\s+/g, '') === wanted;

export const hasUiScheme = (value: unknown): value is string =>
  typeof value === 'string' && value.startsWith(UI_SCHEME);

/** A tool that has a UI: its name, the `_meta.ui` it holds, and the address it names. */
export interface UiTool {
  /** The name, or its position when it has none. */
  name: string;
  ui: unknown;
  /** `_meta.ui.resourceUri`, or the deprecated `_meta["ui/resourceUri"]` when that is all there is. */
  resourceUri: unknown;
}

/** The resource of the run that is read: its address and what the read answered. */
export type Read =
  /** An answer with contents (a list that may be empty). */
  | { kind: 'read'; contents: Record<string, unknown>[] }
  /** The error code of the revision for a missing resource (`notFoundCode`): the one answer that says it is not there. */
  | { kind: 'not-found'; said: string }
  /** Any other error, or an answer that is not a result with a contents list: nothing is known of the resource. */
  | { kind: 'no-answer'; said: string };

/**
 * The code that says a resource is not there, by the revision of the session: -32002 up to 2025-11-25
 * (resources-read-not-found), -32602 from 2026-07-28 (mod-resource-not-found). Both checks write the code into their
 * own text; there is no shared constant to reuse, so this follows the same split, by `ctx.era`.
 */
export const notFoundCode = (ctx: ConformanceContext): number =>
  ctx.era === 'modern' ? -32602 : -32002;

/** The addresses to read, those left unread for the limit, and why the list that was to add to them was not read. */
export interface Addresses {
  uris: string[];
  over: number;
  /** resources/list could not be read: addresses it names, if any, are not in `uris`. */
  listNote?: string;
}

export const LIMIT_NOTE = (over: number, read: number): string =>
  `${over} of ${read + over} addresses were not read (the limit is ${MAX_UI_READS})`;

const noApps: CheckOutcome = {
  state: 'not-applicable',
  reason: 'capability-not-declared',
  actual:
    'The server declares no MCP Apps extension (io.modelcontextprotocol/ui) and no tool has _meta.ui: nothing to check.',
};
const extensionOnly = (what: string): CheckOutcome =>
  notOffered(
    `The server declares the MCP Apps extension (io.modelcontextprotocol/ui), but ${what}.`,
  );

/** The server declares the extension in its capabilities: initialize's in the legacy era, server/discover's in the modern. */
export function declaresExtension(ctx: ConformanceContext): boolean {
  const extensions = capabilities(ctx)['extensions'];
  return isObject(extensions) && isObject(extensions[UI_EXTENSION]);
}

/**
 * The tools that have a UI, or the outcome when there are none to judge: `not-applicable` (`capability-not-declared`)
 * for a server that declares no extension and has no such tool, `not-applicable` (`not-offered`) for one that declares
 * the extension and has none, and `could-not-run` when tools/list cannot be read.
 */
export function uiTools(ctx: ConformanceContext): Promise<UiTool[] | CheckOutcome> {
  return ctx.memo('apps tools', async () => {
    const extension = declaresExtension(ctx);
    const list = await tools(ctx);
    if (isOutcome(list)) {
      if (list.state === 'not-applicable')
        return extension ? extensionOnly('declares no tools capability') : noApps;
      // A page that is not a page is for tools-list-shape to judge.
      return list.state === 'failed'
        ? prerequisite(list.actual ?? 'tools/list could not be read.')
        : list;
    }
    const found: UiTool[] = [];
    list.forEach((t, i) => {
      if (!isObject(t) || !isObject(t['_meta'])) return;
      const meta = t['_meta'];
      if (!('ui' in meta) && !('ui/resourceUri' in meta)) return;
      const ui = meta['ui'];
      const resourceUri =
        isObject(ui) && ui['resourceUri'] !== undefined
          ? ui['resourceUri']
          : meta['ui/resourceUri'];
      found.push({
        name: typeof t['name'] === 'string' ? t['name'] : `#${i + 1}`,
        ui,
        resourceUri,
      });
    });
    if (found.length === 0) return extension ? extensionOnly('no tool has _meta.ui') : noApps;
    return found;
  });
}

/** The listed resources, or the outcome when the list cannot be read (a page that is not a page is not ours to judge). */
export async function listed(
  ctx: ConformanceContext,
): Promise<Record<string, unknown>[] | CheckOutcome> {
  const list = await entries(ctx, 'resources', 'resources/list', 'resources');
  if (isOutcome(list))
    return list.state === 'failed'
      ? prerequisite(list.actual ?? 'resources/list could not be read.')
      : list;
  return list.filter(isObject);
}

/** The distinct ui:// addresses the tools name, in order, and how many were left unread for the limit. */
export function namedAddresses(found: readonly UiTool[]): { uris: string[]; over: number } {
  const all = [...new Set(found.map((t) => t.resourceUri).filter(hasUiScheme))];
  return { uris: all.slice(0, MAX_UI_READS), over: Math.max(0, all.length - MAX_UI_READS) };
}

/** The distinct ui:// addresses of the tools and of the list, in that order, under the limit. */
export async function uiAddresses(
  ctx: ConformanceContext,
  found: readonly UiTool[],
): Promise<Addresses> {
  const list = await listed(ctx);
  const fromList = Array.isArray(list) ? list.map((r) => r['uri']).filter(hasUiScheme) : [];
  const all = [...new Set([...found.map((t) => t.resourceUri).filter(hasUiScheme), ...fromList])];
  return {
    uris: all.slice(0, MAX_UI_READS),
    over: Math.max(0, all.length - MAX_UI_READS),
    ...listNote(list),
  };
}

/** Says that the list was not read, when it was asked for and could not be (not when the server declares no resources). */
export const listNote = (list: Record<string, unknown>[] | CheckOutcome): { listNote?: string } =>
  Array.isArray(list) || list.state !== 'could-not-run'
    ? {}
    : { listNote: `resources/list was not read (${list.actual ?? 'no answer'})` };

/** resources/read of one address, once per run. A server that does not answer rejects (the runner says could-not-run). */
export function readUi(ctx: ConformanceContext, uri: string): Promise<Read> {
  return ctx.memo(`apps read ${uri}`, async (): Promise<Read> => {
    const a = await call(ctx, 'resources/read', { uri });
    if (a.kind === 'error')
      return a.code === notFoundCode(ctx)
        ? { kind: 'not-found', said: said(a) }
        : { kind: 'no-answer', said: said(a) };
    if (a.kind === 'other') return { kind: 'no-answer', said: said(a) };
    const contents = a.result['contents'];
    if (!Array.isArray(contents))
      return { kind: 'no-answer', said: 'a result with no contents list' };
    return { kind: 'read', contents: contents.filter(isObject) };
  });
}

export interface Gathered {
  /** The problems found, each one sentence. */
  bad: string[];
  /** What could not be judged (too large): not a pass, not a failure. */
  skipped: string[];
  /** The resources that could not be read. */
  unread: string[];
  /** The contents judged. */
  judged: number;
  /** The addresses left unread for the limit. */
  over: number;
  uris: number;
  listNote?: string;
}

/** What one content gives: its problems, or why it was not judged, or that it has nothing of the kind to judge. */
export interface Judged {
  problems: string[];
  skipped?: string;
  none?: true;
}

/** Each content that resources/read answers for these addresses, judged. A server that does not answer rejects. */
export async function gather(
  ctx: ConformanceContext,
  addresses: Addresses,
  judge: (uri: string, content: Record<string, unknown>) => Judged,
): Promise<Gathered> {
  const q = quoter(ctx);
  const g: Gathered = {
    bad: [],
    skipped: [],
    unread: [],
    judged: 0,
    over: addresses.over,
    uris: addresses.uris.length,
    ...(addresses.listNote === undefined ? {} : { listNote: addresses.listNote }),
  };
  for (const uri of addresses.uris) {
    const read = await readUi(ctx, uri);
    if (read.kind !== 'read') {
      g.unread.push(`${q(uri)}: resources/read answered ${read.said}`);
      continue;
    }
    if (read.contents.length === 0) {
      g.unread.push(`${q(uri)}: resources/read answered no content`);
      continue;
    }
    // The contents that carry the address asked for; a server that names none is judged on all it sent.
    const own = read.contents.filter((c) => c['uri'] === uri);
    for (const content of own.length > 0 ? own : read.contents) {
      const r = judge(uri, content);
      if (r.skipped !== undefined) g.skipped.push(`${q(uri)}: ${r.skipped}`);
      else if (r.none !== true) g.judged++;
      g.bad.push(...r.problems);
    }
  }
  return g;
}

/**
 * The outcome of what was gathered, with the problems and the count of what was judged elsewhere (`more`): `failed`
 * for a problem, `could-not-run` when something was not judged and nothing failed, `not-offered` when there was nothing
 * to judge, else `passed`.
 */
export function verdict(
  g: Gathered,
  what: string,
  fix: string,
  more: { bad: string[]; judged: number } = { bad: [], judged: 0 },
): CheckOutcome {
  const notes = [
    ...(g.listNote === undefined ? [] : [g.listNote]),
    ...(g.over > 0 ? [LIMIT_NOTE(g.over, g.uris)] : []),
  ];
  const limit = notes.length > 0 ? ` ${notes.join('; ')}.` : '';
  const bad = [...more.bad, ...g.bad];
  if (bad.length > 0) return { state: 'failed', actual: `${what}: ${some(bad, 3)}.${limit}`, fix };
  if (g.skipped.length > 0) return prerequisite(`Not judged: ${some(g.skipped, 3)}.${limit}`);
  if (g.unread.length > 0)
    return prerequisite(
      `A resource could not be read, so it was not judged: ${some(g.unread, 3)}.${limit} apps-ui-resource-exists says why.`,
    );
  // Not everything that was to be judged was read: no pass for what was.
  if (notes.length > 0)
    return prerequisite(
      `${notes.join('; ')}, so the verdict would cover only part of what the server has.`,
    );
  const judged = g.judged + more.judged;
  if (judged === 0)
    return notOffered(
      g.uris === 0
        ? 'No tool or listed resource has a ui:// address to read.'
        : 'Nothing of this kind was found to judge.',
    );
  return { state: 'passed', actual: `${judged} judged.${limit}` };
}
