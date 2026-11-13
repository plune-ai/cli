import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ConnectTarget } from '../../connect/options.js';
import { isThisMachine } from './local.js';

/**
 * The page of `scan/probe/untrusted-content-verbatim`: a listener the scan starts for the length of the probe and
 * stops on every way out. It is bound to 127.0.0.1 and nothing else, serves one harmless line (a marker that is random
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
  close(): Promise<void>;
}

export async function startPage(): Promise<Page> {
  const marker = `PLUNE-CANARY-${randomBytes(8).toString('hex')}`;
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(marker);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { address, port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/page`,
    address,
    marker,
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

/** Words that mark the start or the end of content that comes from outside: a boundary. A heuristic list. */
export const BOUNDARY_SIGNS: readonly RegExp[] = [
  /<\/?\s*(?:untrusted|external|user-content|document|tool[-_ ]?output|fetched|quote|data)\b/i,
  /\b(?:begin|end)[\s_-]+(?:untrusted|external)\b/i,
  /\buntrusted\b/i,
  /\bexternal (?:content|data|source)\b/i,
  /```/,
  /^\s*(?:-{3,}|={3,}|#{3,})\s*$/m,
];

export type Verdict = 'verbatim' | 'bounded' | 'absent';

/**
 * What a tool result says about the marker, and only that: `absent` when it is not in the first 64 KiB of the text,
 * `bounded` when it is there with a sign of a boundary (a sign in the text, or `annotations` on the content item), and
 * `verbatim` when it is there with none.
 */
export function markerVerdict(result: unknown, marker: string): Verdict {
  const content = (result as { content?: unknown } | null)?.content;
  if (!Array.isArray(content)) return 'absent';
  for (const item of content as unknown[]) {
    const c = item as { text?: unknown; annotations?: unknown } | null;
    if (c === null || typeof c !== 'object' || typeof c.text !== 'string') continue;
    const text = c.text.slice(0, MAX_ANSWER_TEXT);
    if (!text.includes(marker)) continue;
    if (c.annotations !== undefined || BOUNDARY_SIGNS.some((re) => re.test(text))) return 'bounded';
    return 'verbatim';
  }
  return 'absent';
}
