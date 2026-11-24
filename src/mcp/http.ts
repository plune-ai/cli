import { AsyncLocalStorage } from 'node:async_hooks';
import { createMcpHandler } from '@modelcontextprotocol/server';
import type { PluneToolExecutorOptions } from '../mcp-tools/index.js';
import { createPluneMcpServer } from './server.js';

/**
 * The Plune tools over streamable HTTP, for a host that mounts them on its own route: a fetch-shaped handler built from
 * the same server factory `plune mcp serve` uses. It is exported from this package because a server built with one
 * copy of the SDK cannot be served by a transport from another copy.
 *
 * One endpoint, POST only, no sessions, a JSON answer. A fresh server answers each request, so nothing is kept between
 * two requests: the tool list is fixed in both protocol eras and `listChanged` is not announced. A 2025-era request is
 * served by the SDK's stateless fallback, a 2026-07-28 one natively.
 *
 * The handler verifies nothing about the caller. The host does, and names the caller with every request: the API
 * address, the token (or its own `fetchImpl`), the scope and the tools switched off (`disabledTools`). Origin and Host
 * checks belong in front of it too.
 */

export interface PluneMcpHttpOptions {
  /** The server version announced to clients. */
  version: string;
  /** Rejected requests and failures, for the host's log; it never alters the response. */
  onerror?: (error: Error) => void;
}

export type PluneMcpHttpHandler = (request: Request, caller: PluneToolExecutorOptions) => Promise<Response>;

const METHOD_NOT_ALLOWED = JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Method not allowed.' } });

/**
 * The stateless fallback answers a 2025-era request with an event stream that holds the answer and ends. This returns
 * the same answer as one JSON body, which the 2025 revisions allow for any POST; any other response passes untouched.
 * ponytail: the stream is read whole and its notifications are dropped; a tool that reports progress would need SSE kept.
 */
async function asJson(response: Response): Promise<Response> {
  if (!(response.headers.get('content-type') ?? '').startsWith('text/event-stream')) return response;
  const answers = (await response.text())
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:') && line.length > 'data:'.length)
    .map((line) => JSON.parse(line.slice('data:'.length)) as { method?: string })
    .filter((message) => message.method === undefined);
  if (answers.length === 0) return new Response(null, { status: 202 });
  return new Response(JSON.stringify(answers.length === 1 ? answers[0] : answers), { status: response.status, headers: { 'content-type': 'application/json' } });
}

export function createPluneMcpHttpHandler(opts: PluneMcpHttpOptions): PluneMcpHttpHandler {
  // The SDK's factory is told the era, not the caller, so the caller of the request in flight travels beside it.
  const callers = new AsyncLocalStorage<PluneToolExecutorOptions>();
  const handler = createMcpHandler(
    (ctx) => {
      const caller = callers.getStore();
      if (caller === undefined) throw new Error('no caller for this request');
      return createPluneMcpServer({ ...caller, version: opts.version }, ctx.era, { listChanged: false });
    },
    { responseMode: 'json', ...(opts.onerror === undefined ? {} : { onerror: opts.onerror }) },
  );
  return async (request, caller) => {
    if (request.method.toUpperCase() !== 'POST') {
      return new Response(METHOD_NOT_ALLOWED, { status: 405, headers: { allow: 'POST', 'content-type': 'application/json' } });
    }
    return asJson(await callers.run(caller, () => handler.fetch(request)));
  };
}
