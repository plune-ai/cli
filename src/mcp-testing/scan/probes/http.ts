import type { Redactor } from '../../connect/redact.js';
import { ConnectError } from '../../connect/session.js';
import {
  header,
  rawRequest,
  type HeaderList,
  type HttpTarget,
} from '../../conformance/raw-http.js';
import type { Frame, Reply } from './guard.js';

/**
 * The transport of the probes: one request to the server under test, as written, and the answer as it came, through
 * the raw HTTP helper of `plune mcp conformance` (no client library, no redirect followed). It adds the `Authorization`
 * header of the frame and nothing else: the `--header` values of the connection are not sent by a probe, because a
 * probe `as: none` must arrive with nothing. A request goes to the origin of the target and to no other; the metadata
 * request has no credential at all.
 *
 * Built by the runner and handed to the guard once; it is not exported to anything else.
 */

const REVISION = '2025-06-18';
const WELL_KNOWN = '/.well-known/oauth-protected-resource';

export function httpTransport(
  url: string,
  redact: Redactor,
  timeoutMs: number,
): (frame: Frame) => Promise<Reply> {
  const origin = new URL(url).origin;
  let version = REVISION;
  let nextId = 1;

  const target = (to: string, token: string | undefined): HttpTarget => ({
    url: to,
    headers: {},
    redact,
    fetch: (input, init) => {
      const u = new URL(input.toString());
      if (u.origin !== origin) throw new Error('a probe goes to the origin of the target only');
      const headers = new Headers(init?.headers);
      if (token !== undefined) headers.set('Authorization', `Bearer ${token}`);
      return fetch(u, { ...init, headers, redirect: 'manual' });
    },
  });

  return async (frame) => {
    try {
      if (frame.type === 'discovery') {
        const res = await rawRequest(
          target(origin + WELL_KNOWN, undefined),
          { method: 'GET', headers: [['Accept', 'application/json']] },
          { timeoutMs, headersOnly: true },
        );
        return { kind: 'http', status: res.status };
      }
      const id = frame.notification === true ? undefined : nextId++;
      const headers: HeaderList = [
        ['Content-Type', 'application/json'],
        ['Accept', 'application/json, text/event-stream'],
      ];
      if (frame.method !== 'initialize') headers.push(['MCP-Protocol-Version', version]);
      if (frame.sessionId !== undefined) headers.push(['Mcp-Session-Id', frame.sessionId]);
      const body = JSON.stringify({
        jsonrpc: '2.0',
        ...(id === undefined ? {} : { id }),
        method: frame.method,
        ...(frame.params === undefined ? {} : { params: frame.params }),
      });
      const token = frame.credential.kind === 'bearer' ? frame.credential.token : undefined;
      const res = await rawRequest(
        target(url, token),
        { method: 'POST', headers, body },
        {
          timeoutMs,
          ...(id === undefined ? {} : { stopWhen: (e) => messageOf(e.data, id) !== undefined }),
        },
      );
      let message: unknown;
      if (id !== undefined && res.status >= 200 && res.status < 300) {
        message =
          res.events.length > 0
            ? res.events.map((e) => messageOf(e.data, id)).find((m) => m !== undefined)
            : messageOf(res.body, id);
        const negotiated = (message as { result?: { protocolVersion?: unknown } } | undefined)
          ?.result?.protocolVersion;
        if (frame.method === 'initialize' && typeof negotiated === 'string') version = negotiated;
      }
      const sessionId = header(res.headers, 'mcp-session-id');
      return {
        kind: 'http',
        status: res.status,
        ...(message === undefined ? {} : { message }),
        ...(sessionId === undefined ? {} : { sessionId }),
      };
    } catch (err) {
      return {
        kind: 'failure',
        why: err instanceof ConnectError && err.kind === 'timeout' ? 'timeout' : 'network',
      };
    }
  };
}

/** The JSON-RPC message with this id in `text`, or undefined. */
function messageOf(text: string, id: number): unknown {
  try {
    const m = JSON.parse(text) as { id?: unknown };
    return m !== null && typeof m === 'object' && m.id === id ? m : undefined;
  } catch {
    return undefined;
  }
}
