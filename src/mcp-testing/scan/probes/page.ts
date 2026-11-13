import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ConnectTarget } from '../../connect/options.js';
import { isThisMachine } from './local.js';

/**
 * The page of `scan/probe/untrusted-content-verbatim`: a listener the scan starts when the first `fetches` probe
 * runs and stops when the run ends, on every way out. It is bound to 127.0.0.1 and nothing else, serves one harmless line (a marker that is random
 * for each run) to any GET, and never reads a request. It is for a server that runs on this machine: one that does
 * not cannot reach it, and is "not run" with its own reason.
 */

/** The most of a tool answer that is looked at. The answer is untrusted: it is never printed or journaled. */
export const MAX_ANSWER_TEXT = 64 * 1024;

export interface Page {
  url: string;
  /** The address the listener is bound to (always 127.0.0.1). */
  address: string;
  marker: string;
  /** The limits the listener was given, read back from it. */
  limits: {
    maxConnections: number;
    headersTimeout: number;
    requestTimeout: number;
    keepAliveTimeout: number;
  };
  close(): Promise<void>;
}

export async function startPage(): Promise<Page> {
  const marker = `PLUNE-CANARY-${randomBytes(8).toString('hex')}`;
  const server = createServer((_req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(marker);
  });
  // It serves one tiny page to one caller: small limits, so nothing that connects can hold it open.
  server.maxConnections = 8;
  server.headersTimeout = 5_000;
  server.requestTimeout = 5_000;
  server.keepAliveTimeout = 1_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { address, port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/page`,
    address,
    marker,
    limits: {
      maxConnections: server.maxConnections ?? 0,
      headersTimeout: server.headersTimeout,
      requestTimeout: server.requestTimeout,
      keepAliveTimeout: server.keepAliveTimeout,
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Whether a server can reach a listener on this machine loopback: a stdio child and a server on this machine can. */
export function pageReachable(target: ConnectTarget): boolean {
  return target.kind === 'stdio' || isThisMachine(target.url);
}

/** Names of tags that mark content from outside; a tag counts only when it encloses the marker. */
const BOUNDARY_TAGS = [
  'untrusted',
  'external',
  'user-content',
  'document',
  'tool-output',
  'tool_output',
  'fetched',
  'quote',
  'data',
];
const LINES_AROUND = 200;
const LINE_CUT = 200;

/** A line of three or more of one of - = #, with spaces and tabs around: a separator. String methods only. */
function isSeparator(line: string): boolean {
  const t = line.slice(0, LINE_CUT).trim();
  if (t.length < 3) return false;
  const c = t[0]!;
  if (c !== '-' && c !== '=' && c !== '#') return false;
  for (let i = 1; i < t.length; i++) if (t[i] !== c) return false;
  return true;
}

const count = (text: string, part: string): number => {
  let n = 0;
  for (let i = text.indexOf(part); i >= 0; i = text.indexOf(part, i + part.length)) n++;
  return n;
};

/**
 * Whether a sign of a boundary encloses the marker at `at`: a code fence opened before it and closed after it, a tag
 * opened before it and closed after it, a separator line on both sides, or a "begin untrusted" line before and an
 * "end untrusted" line after. A word or a fence somewhere else in the text does not count. Only `indexOf`, `split` and
 * lines cut to a constant length: no pattern, so no input makes it slow. A heuristic a server can satisfy trivially.
 */
export function enclosed(text: string, at: number): boolean {
  const before = text.slice(0, at);
  const after = text.slice(at);
  if (count(before, '```') % 2 === 1 && after.includes('```')) return true;
  const lowerBefore = before.toLowerCase();
  const lowerAfter = after.toLowerCase();
  for (const tag of BOUNDARY_TAGS)
    if (
      lowerBefore.lastIndexOf(`<${tag}`) > lowerBefore.lastIndexOf(`</${tag}`) &&
      lowerAfter.includes(`</${tag}`)
    )
      return true;
  const up = before.split('\n').slice(-LINES_AROUND);
  const down = after.split('\n').slice(1, LINES_AROUND + 1);
  if (up.some(isSeparator) && down.some(isSeparator)) return true;
  const says = (line: string, word: string) => {
    const l = line.slice(0, LINE_CUT).toLowerCase();
    return l.includes(word) && l.includes('untrusted');
  };
  return up.some((l) => says(l, 'begin')) && down.some((l) => says(l, 'end'));
}

export type Verdict = 'verbatim' | 'bounded' | 'absent' | 'too-large' | 'no-text';

/**
 * What a tool result says about the marker, and only that. The text of the result is read from the places a result
 * carries text (`content[].text`, `content[].resource.text`, `structuredContent` as JSON) up to 64 KiB in all:
 * `bounded` when a sign of a boundary encloses the marker or the content item has `annotations`, `verbatim` when it
 * does not, `absent` when the text that was read does not hold it, `too-large` when it does not and the answer had
 * more text than was read, `no-text` when there was nothing to read. Only the first two are about the marker.
 */
export function markerVerdict(result: unknown, marker: string): Verdict {
  const r = (result ?? {}) as { content?: unknown; structuredContent?: unknown };
  const items: { text: string; annotated: boolean }[] = [];
  if (Array.isArray(r.content))
    for (const item of r.content as unknown[]) {
      const c = item as {
        text?: unknown;
        annotations?: unknown;
        resource?: { text?: unknown };
      } | null;
      if (c === null || typeof c !== 'object') continue;
      const annotated = c.annotations !== undefined;
      if (typeof c.text === 'string') items.push({ text: c.text, annotated });
      if (
        typeof c.resource === 'object' &&
        c.resource !== null &&
        typeof c.resource.text === 'string'
      )
        items.push({ text: c.resource.text, annotated });
    }
  if (r.structuredContent !== undefined && r.structuredContent !== null) {
    let json: string | undefined;
    try {
      json = JSON.stringify(r.structuredContent);
    } catch {
      json = undefined;
    }
    if (json !== undefined) items.push({ text: json, annotated: false });
  }
  if (items.length === 0) return 'no-text';
  let budget = MAX_ANSWER_TEXT;
  let total = 0;
  for (const item of items) {
    total += item.text.length;
    const read = item.text.slice(0, budget);
    budget -= read.length;
    const at = read.indexOf(marker);
    if (at >= 0) return item.annotated || enclosed(read, at) ? 'bounded' : 'verbatim';
  }
  return total > MAX_ANSWER_TEXT ? 'too-large' : 'absent';
}
