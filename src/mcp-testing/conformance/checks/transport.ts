/**
 * Streamable HTTP on the wire: what the server does with raw requests (../raw-http.ts), read from the status, the
 * headers and the bytes as they came. The handshake is made once per run by a POST of its own (initialize and its
 * notification in the legacy era; in the modern era there is none, and each request carries its metadata), and every
 * check that reads an answer reads the same probe. The checks that change the server's state each make a session of
 * their own and are kept last in the catalog.
 */

import { ConnectError, headerValue } from '../../connect/session.js';
import { mediaTypeOf } from '../../../reporter-core/failure-detail.js';
import type { CheckOutcome } from '../outcome.js';
import {
  exchange,
  header,
  rawRequest,
  type Exchange,
  type HeaderList,
  type HttpTarget,
  type RawRequest,
  type RawResponse,
  type SseEvent,
} from '../raw-http.js';
import type { ConformanceCheck, ConformanceContext } from './index.js';
import { CLIENT, modernMeta } from './modern/meta.js';
import { dualEra, failed, isObject, nextId, notOffered, passed, prerequisite, some, supportedVersions } from './wire.js';

const ACCEPT = 'application/json, text/event-stream';
/** How long a stream is watched for its end once the response came on it. */
export const LINGER_MS = 1000;
/** The most the two GET streams of http-sse-no-broadcast are watched; they stop LINGER_MS after the call's answer. */
export const BROADCAST_MS = 5000;

export function target(ctx: ConformanceContext): HttpTarget {
  if (ctx.http === undefined)
    throw new ConnectError('protocol', 'Requests of its own go over Streamable HTTP only, not HTTP+SSE.', []);
  return ctx.http;
}

export const ok = (res: RawResponse): boolean => res.status >= 200 && res.status < 300;
const isSse = (res: RawResponse) => mediaTypeOf(header(res.headers, 'content-type')) === 'text/event-stream';

/** A session of this run's own: the one the SDK client holds is never touched. */
export interface OwnSession {
  version: string;
  sessionId?: string;
  /** The notification sent after initialize (legacy) or alone (modern), and its answer. */
  notification: { req: RawRequest; res: RawResponse };
  details: Exchange[];
}

export interface Asked {
  req: RawRequest;
  res: RawResponse;
  /** The JSON-RPC answer to the request, from the JSON body or the SSE event that answers it. */
  frame: Record<string, unknown> | undefined;
  detail: Exchange;
}

const parsed = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const answers = (data: string, id: string): Record<string, unknown> | undefined => {
  const f = parsed(data);
  return isObject(f) && f['id'] === id && ('result' in f || 'error' in f) ? f : undefined;
};

export function frameOf(res: RawResponse, id: string): Record<string, unknown> | undefined {
  if (isSse(res)) {
    for (const e of res.events) {
      const f = answers(e.data, id);
      if (f !== undefined) return f;
    }
    return undefined;
  }
  const f = parsed(res.body);
  return isObject(f) ? f : undefined;
}

/**
 * A JSON-RPC message as the run's era writes it. Legacy: the session id and the negotiated version as headers.
 * Modern: the version, client and capabilities in `_meta`, and the version, method and name as headers.
 */
export function message(
  ctx: ConformanceContext,
  s: Pick<OwnSession, 'version' | 'sessionId'>,
  method: string,
  id: string | undefined,
  params?: Record<string, unknown>,
): RawRequest {
  const headers: HeaderList = [
    ['Content-Type', 'application/json'],
    ['Accept', ACCEPT],
  ];
  let p = params;
  if (ctx.era === 'modern') {
    headers.push(['MCP-Protocol-Version', s.version], ['Mcp-Method', method]);
    const name = method === 'resources/read' ? params?.['uri'] : params?.['name'];
    if (['tools/call', 'resources/read', 'prompts/get'].includes(method) && typeof name === 'string')
      headers.push(['Mcp-Name', headerValue(name)]);
    p = { ...params, _meta: modernMeta(s.version) };
  } else {
    if (s.sessionId !== undefined) headers.push(['Mcp-Session-Id', s.sessionId]);
    headers.push(['MCP-Protocol-Version', s.version]);
  }
  const body = JSON.stringify({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, ...(p === undefined ? {} : { params: p }) });
  return { method: 'POST', headers, body };
}

/** The request as written, with headers set or dropped by name: the probe that differs in one header. */
export function edited(req: RawRequest, set: HeaderList = [], drop: string[] = []): RawRequest {
  const gone = new Set([...drop, ...set.map(([n]) => n)].map((n) => n.toLowerCase()));
  return { ...req, headers: [...req.headers.filter(([n]) => !gone.has(n.toLowerCase())), ...set] };
}

/** One request in a session, read up to the event that answers it (and `lingerMs` beyond). */
export async function ask(
  ctx: ConformanceContext,
  s: Pick<OwnSession, 'version' | 'sessionId'>,
  method: string,
  opts: { set?: HeaderList; drop?: string[]; params?: Record<string, unknown>; lingerMs?: number } = {},
): Promise<Asked> {
  const t = target(ctx);
  const id = nextId();
  const req = edited(message(ctx, s, method, id, opts.params), opts.set, opts.drop);
  const res = await rawRequest(t, req, {
    stopWhen: (e: SseEvent) => answers(e.data, id) !== undefined,
    lingerMs: opts.lingerMs ?? 0,
  });
  return { req, res, frame: frameOf(res, id), detail: exchange(t, req, res) };
}

/** The method every probe asks: ping in the legacy era, server/discover (which every modern server has) after. */
export const probeMethod = (ctx: ConformanceContext): string => (ctx.era === 'legacy' ? 'ping' : 'server/discover');

/**
 * A new session of this run's own: in the legacy era an initialize POST and its notification, in the modern era just
 * a notification. The outcome instead when initialize was not answered: every check on it could not run.
 */
export async function openOwn(ctx: ConformanceContext): Promise<OwnSession | CheckOutcome> {
  const t = target(ctx);
  const details: Exchange[] = [];
  let s: Pick<OwnSession, 'version' | 'sessionId'> = {
    version: ctx.protocolVersion ?? (ctx.era === 'modern' ? '2026-07-28' : '2025-11-25'),
  };
  if (ctx.era === 'legacy') {
    const id = nextId();
    const req: RawRequest = {
      method: 'POST',
      headers: [
        ['Content-Type', 'application/json'],
        ['Accept', ACCEPT],
      ],
      body: JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'initialize',
        params: { protocolVersion: s.version, capabilities: {}, clientInfo: CLIENT },
      }),
    };
    const res = await rawRequest(t, req, { stopWhen: (e) => answers(e.data, id) !== undefined });
    details.push(exchange(t, req, res));
    const result = frameOf(res, id)?.['result'];
    if (!ok(res) || !isObject(result))
      return { ...prerequisite(`An initialize POST of this run's own got HTTP ${res.status} and no result.`), details };
    const sessionId = header(res.headers, 'mcp-session-id');
    s = {
      version: typeof result['protocolVersion'] === 'string' ? result['protocolVersion'] : s.version,
      ...(sessionId === undefined ? {} : { sessionId }),
    };
  }
  const req = message(ctx, s, 'notifications/initialized', undefined);
  const res = await rawRequest(t, req);
  details.push(exchange(t, req, res));
  return { ...s, notification: { req, res }, details };
}

/** The session could not be had: the outcome stands for the check. */
export const isOutcome = <T extends object>(v: T | CheckOutcome): v is CheckOutcome => 'state' in v;

/** The session the checks share, made once per run. */
export const session = (ctx: ConformanceContext) => ctx.memo('http session', () => openOwn(ctx));

/** The probe every answer-reading check reads, once per run: watched LINGER_MS past its response. */
export const probe = (ctx: ConformanceContext, s: OwnSession) =>
  ctx.memo('http probe', () => ask(ctx, s, probeMethod(ctx), { lingerMs: LINGER_MS }));

/** Three probes sent at once, once per run. */
const concurrent = (ctx: ConformanceContext, s: OwnSession) =>
  ctx.memo('http concurrent', () => Promise.all([1, 2, 3].map(() => ask(ctx, s, probeMethod(ctx)))));

/** The shared session and its probe, or the outcome when either could not be had. */
async function probed(ctx: ConformanceContext): Promise<{ s: OwnSession; p: Asked } | CheckOutcome> {
  const s = await session(ctx);
  if (isOutcome(s)) return s;
  const p = await probe(ctx, s);
  if (!ok(p.res))
    return { ...prerequisite(`The probe request (${probeMethod(ctx)}) got HTTP ${p.res.status}.`), details: [p.detail] };
  return { s, p };
}

const notificationAccepted: ConformanceCheck = async (ctx) => {
  const s = await session(ctx);
  if (isOutcome(s)) return s;
  const { res } = s.notification;
  const details = s.details.slice(-1);
  if (res.status === 202 && res.body === '') return { ...passed('The notification got 202 Accepted with no body.'), details };
  if (res.status >= 400) return { ...passed(`The notification was refused with HTTP ${res.status}, an error status.`), details };
  const body = res.body === '' ? '' : ` and a body of ${res.body.length} characters`;
  return {
    ...failed(
      `The notification got HTTP ${res.status}${body}.`,
      'Answer a notification the server accepts with 202 Accepted and no body, and one it does not accept with an HTTP error status (400).',
    ),
    details,
  };
};

const contentType: ConformanceCheck = async (ctx) => {
  const got = await probed(ctx);
  if (isOutcome(got)) return got;
  const type = mediaTypeOf(header(got.p.res.headers, 'content-type'));
  const details = [got.p.detail];
  if (type === 'application/json' || type === 'text/event-stream')
    return { ...passed(`${probeMethod(ctx)} was answered as ${type}.`), details };
  return {
    ...failed(
      `${probeMethod(ctx)} was answered with ${type === undefined ? 'no Content-Type' : `Content-Type ${type}`}.`,
      'Answer a request with Content-Type: application/json (one JSON object) or text/event-stream (an SSE stream).',
    ),
    details,
  };
};

const utf8Json: ConformanceCheck = async (ctx) => {
  const got = await probed(ctx);
  if (isOutcome(got)) return got;
  const { res, detail } = got.p;
  const fix = 'Send every JSON-RPC message as JSON encoded in UTF-8.';
  if (!res.utf8) return { ...failed('The body of the answer is not valid UTF-8.', fix), details: [detail] };
  const messages = isSse(res) ? res.events.map((e) => e.data).filter((d) => d !== '') : [res.body];
  const bad = messages.filter((m) => parsed(m) === undefined);
  if (bad.length > 0)
    return { ...failed(`${bad.length} of ${messages.length} messages of the answer are not JSON.`, fix), details: [detail] };
  return { ...passed(`The answer is valid UTF-8, and its ${messages.length} message(s) are JSON.`), details: [detail] };
};

const singleEndpoint: ConformanceCheck = async (ctx) => {
  const s = await session(ctx);
  if (isOutcome(s)) return s;
  const p = await probe(ctx, s);
  const details = [p.detail];
  const fix = 'Serve the MCP endpoint at one URL that takes POST.';
  const status = p.res.status;
  const error = p.frame?.['error'];
  const methodNotFound = isObject(error) && error['code'] === -32601;
  if (ok(p.res) || (status === 404 && methodNotFound))
    return { ...passed(`A POST of ${probeMethod(ctx)} to the endpoint got HTTP ${status}${methodNotFound ? ' with -32601' : ''}.`), details };
  if (status === 404 || status === 405)
    return { ...failed(`A POST of ${probeMethod(ctx)} to the endpoint got HTTP ${status}.`, fix), details };
  return { ...prerequisite(`The probe request (${probeMethod(ctx)}) got HTTP ${status}.`), details };
};

/** A GET or DELETE to the endpoint with the session's headers, read up to its status. */
async function bare(ctx: ConformanceContext, s: OwnSession, method: 'GET' | 'DELETE'): Promise<Asked> {
  const t = target(ctx);
  const headers: HeaderList = [['Accept', 'text/event-stream']];
  if (ctx.era === 'legacy') {
    if (s.sessionId !== undefined) headers.push(['Mcp-Session-Id', s.sessionId]);
    headers.push(['MCP-Protocol-Version', s.version]);
  }
  const req: RawRequest = { method, headers };
  const res = await rawRequest(t, req, { headersOnly: true });
  return { req, res, frame: undefined, detail: exchange(t, req, res) };
}

const getStreamOr405: ConformanceCheck = async (ctx) => {
  const s = await session(ctx);
  if (isOutcome(s)) return s;
  const g = await bare(ctx, s, 'GET');
  const details = [g.detail];
  if (g.res.status === 405) return { ...passed('GET got 405: the server offers no SSE stream at this endpoint.'), details };
  if (ok(g.res) && isSse(g.res)) return { ...passed('GET opened an SSE stream (text/event-stream).'), details };
  const type = header(g.res.headers, 'content-type');
  return {
    ...failed(
      `GET got HTTP ${g.res.status}${type === undefined ? '' : ` as ${mediaTypeOf(type)}`}.`,
      'Answer a GET to the endpoint with an SSE stream (Content-Type: text/event-stream) or with 405 Method Not Allowed.',
    ),
    details,
  };
};

const modernGetDelete405: ConformanceCheck = async (ctx) => {
  if (dualEra(ctx))
    return {
      state: 'not-applicable',
      reason: 'era',
      actual: `server/discover names ${some(supportedVersions(ctx))}: the server serves the legacy era as well (dual-era).`,
    };
  const s = await session(ctx);
  if (isOutcome(s)) return s;
  const got = [await bare(ctx, s, 'GET'), await bare(ctx, s, 'DELETE')];
  const details = got.map((g) => g.detail);
  const wrong = got.filter((g) => g.res.status !== 405).map((g) => `${g.req.method} got HTTP ${g.res.status}`);
  if (wrong.length === 0) return { ...passed('GET and DELETE both got 405.'), details };
  return {
    ...failed(`${wrong.join('; ')}.`, 'Answer GET and DELETE on the endpoint with 405 Method Not Allowed.'),
    details,
  };
};

const sessionIdAscii: ConformanceCheck = async (ctx) => {
  const s = await session(ctx);
  if (isOutcome(s)) return s;
  const details = s.details.slice(0, 1);
  if (s.sessionId === undefined) return { ...notOffered('The server assigned no MCP-Session-Id.'), details };
  const bad = [...s.sessionId].findIndex((c) => c < '\x21' || c > '\x7e');
  if (bad < 0) return { ...passed(`The session id is ${s.sessionId.length} visible ASCII characters.`), details };
  const code = s.sessionId.codePointAt(bad) ?? 0;
  return {
    ...failed(
      `Character ${bad + 1} of the session id is 0x${code.toString(16).padStart(2, '0')}, outside 0x21 to 0x7E.`,
      'Make a session id of visible ASCII characters only (0x21 to 0x7E), such as a UUID.',
    ),
    details,
  };
};

const sessionRequired400: ConformanceCheck = async (ctx) => {
  const s = await session(ctx);
  if (isOutcome(s)) return s;
  if (s.sessionId === undefined) return notOffered('The server assigned no MCP-Session-Id.');
  const a = await ask(ctx, s, 'ping', { drop: ['Mcp-Session-Id'] });
  const details = [a.detail];
  if (a.res.status === 400) return { ...passed('ping without MCP-Session-Id got 400.'), details };
  return {
    ...failed(
      `ping without MCP-Session-Id got HTTP ${a.res.status}.`,
      'Answer a request without MCP-Session-Id (other than initialize) with 400 Bad Request when the server uses sessions.',
    ),
    details,
  };
};

export const INVALID_VERSION = 'not-a-revision';

const versionHeaderInvalid400: ConformanceCheck = async (ctx) => {
  const s = await session(ctx);
  if (isOutcome(s)) return s;
  const a = await ask(ctx, s, 'ping', { set: [['MCP-Protocol-Version', INVALID_VERSION]] });
  const details = [a.detail];
  if (a.res.status === 400) return { ...passed(`ping with MCP-Protocol-Version: ${INVALID_VERSION} got 400.`), details };
  return {
    ...failed(
      `ping with MCP-Protocol-Version: ${INVALID_VERSION} got HTTP ${a.res.status}.`,
      'Answer a request with an invalid or unsupported MCP-Protocol-Version with 400 Bad Request.',
    ),
    details,
  };
};

const concurrentMatched: ConformanceCheck = async (ctx) => {
  const s = await session(ctx);
  if (isOutcome(s)) return s;
  const all = await concurrent(ctx, s);
  const details = all.map((a) => a.detail);
  const refused = all.find((a) => !ok(a.res));
  if (refused !== undefined)
    return { ...prerequisite(`A probe request (${probeMethod(ctx)}) got HTTP ${refused.res.status}.`), details };
  const wrong = all.flatMap((a) => {
    const sent = (parsed(a.req.body ?? '') as { id?: unknown } | undefined)?.id;
    const got = a.frame?.['id'];
    return got === sent ? [] : [`the request ${JSON.stringify(sent)} got ${a.frame === undefined ? 'no answer' : `the id ${JSON.stringify(got)}`}`];
  });
  if (wrong.length === 0) return { ...passed(`${all.length} POSTs sent at once each got the answer with their own id.`), details };
  return {
    ...failed(`Of ${all.length} POSTs sent at once, ${wrong.join('; ')}.`, 'Answer each POST with the response to the request it carries, under that id.'),
    details,
  };
};

/** The SSE answers the shared session saw: the probe and the concurrent requests. */
async function streams(ctx: ConformanceContext): Promise<Asked[] | CheckOutcome> {
  const got = await probed(ctx);
  if (isOutcome(got)) return got;
  return [got.p, ...(await concurrent(ctx, got.s))].filter((a) => isSse(a.res));
}

const noSse = (): CheckOutcome => notOffered('Every request was answered as application/json, none over SSE.');

const eventIdsUnique: ConformanceCheck = async (ctx) => {
  const sse = await streams(ctx);
  if (!Array.isArray(sse)) return sse;
  const ids = sse.flatMap((a) => a.res.events.flatMap((e) => (e.id === undefined ? [] : [e.id])));
  const details = sse.map((a) => a.detail);
  if (ids.length === 0) return { ...notOffered('No SSE event the session saw had an id.'), details };
  const twice = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
  if (twice.length === 0) return { ...passed(`${ids.length} event ids over ${sse.length} streams, each one once.`), details };
  return {
    ...failed(
      `${twice.length} event id(s) came back more than once over ${sse.length} streams: ${twice.slice(0, 5).map((id) => JSON.stringify(id)).join(', ')}.`,
      'Give every SSE event an id unique across all the streams of the session.',
    ),
    details,
  };
};

const streamCloses: ConformanceCheck = async (ctx) => {
  const got = await probed(ctx);
  if (isOutcome(got)) return got;
  const { res, frame, detail } = got.p;
  const details = [detail];
  if (!isSse(res)) return { ...noSse(), details };
  if (frame === undefined)
    return { state: 'could-not-run', reason: 'timeout', actual: 'The response did not come on the SSE stream in time.', details };
  if (res.ended) return { ...passed('The SSE stream ended after the response.'), details };
  return {
    ...failed(
      `The SSE stream was still open ${LINGER_MS / 1000} s after the response.`,
      'Close the SSE stream of a request once its JSON-RPC response is sent.',
    ),
    details,
  };
};

const noServerRequests: ConformanceCheck = async (ctx) => {
  const sse = await streams(ctx);
  if (!Array.isArray(sse)) return sse;
  if (sse.length === 0) return noSse();
  const details = sse.map((a) => a.detail);
  const requests = sse.flatMap((a) =>
    a.res.events.flatMap((e) => {
      const m = parsed(e.data);
      return isObject(m) && typeof m['method'] === 'string' && 'id' in m ? [m['method']] : [];
    }),
  );
  if (requests.length === 0) return { ...passed(`${sse.length} SSE answers held no request of the server.`), details };
  return {
    ...failed(
      `The SSE answer to a request held ${requests.length} request(s) of the server: ${requests.slice(0, 5).join(', ')}.`,
      'Send only the response and notifications related to the request on its stream; ask the client through an input request in the result.',
    ),
    details,
  };
};

const accelBuffering: ConformanceCheck = async (ctx) => {
  const sse = await streams(ctx);
  if (!Array.isArray(sse)) return sse;
  if (sse.length === 0) return noSse();
  const details = sse.map((a) => a.detail);
  const without = sse.filter((a) => header(a.res.headers, 'x-accel-buffering')?.trim().toLowerCase() !== 'no');
  if (without.length === 0) return { ...passed('Every SSE answer had X-Accel-Buffering: no.'), details };
  return {
    ...failed(
      `${without.length} of ${sse.length} SSE answers had no X-Accel-Buffering: no.`,
      'Send X-Accel-Buffering: no with every response that opens an SSE stream.',
    ),
    details,
  };
};

const closeCancels: ConformanceCheck = async () => ({
  state: 'could-not-run',
  reason: 'needs-input',
  actual: 'Whether the server stopped a call whose stream was closed shows only in the effects of the tool; this run has no way to watch them.',
});

const sessionTerminated404: ConformanceCheck = async (ctx) => {
  // A session of its own: the shared one and the SDK client's stay alive.
  const s = await openOwn(ctx);
  if (isOutcome(s)) return s;
  if (s.sessionId === undefined) return notOffered('The server assigned no MCP-Session-Id.');
  const del = await bare(ctx, s, 'DELETE');
  if (del.res.status === 405)
    return { ...notOffered('DELETE got 405: the server does not let a client end a session.'), details: [del.detail] };
  if (!ok(del.res))
    return { ...prerequisite(`DELETE of the session got HTTP ${del.res.status}.`), details: [del.detail] };
  const a = await ask(ctx, s, 'ping');
  const details = [del.detail, a.detail];
  if (a.res.status === 404) return { ...passed('After DELETE, a request with the ended session id got 404.'), details };
  return {
    ...failed(
      `After DELETE got HTTP ${del.res.status}, a request with the ended session id got HTTP ${a.res.status}.`,
      'Answer every request that carries the id of an ended session with 404 Not Found.',
    ),
    details,
  };
};

const noBroadcast: ConformanceCheck = async (ctx) => {
  const call = ctx.fixture?.[0];
  if (call === undefined)
    return {
      state: 'could-not-run',
      reason: 'needs-input',
      actual: 'No --fixture: no call to make the server send a message on its GET streams.',
    };
  const t = target(ctx);
  const s = await openOwn(ctx);
  if (isOutcome(s)) return s;
  const stop = new AbortController();
  const open = () => {
    let opened: () => void = () => {};
    const ready = new Promise<void>((resolve) => (opened = resolve));
    const req: RawRequest = {
      method: 'GET',
      headers: [
        ['Accept', 'text/event-stream'],
        ...(s.sessionId === undefined ? [] : ([['Mcp-Session-Id', s.sessionId]] as HeaderList)),
        ['MCP-Protocol-Version', s.version],
      ],
    };
    const done = rawRequest(t, req, { timeoutMs: BROADCAST_MS, onOpen: opened, signal: stop.signal });
    return { req, done, ready: Promise.race([ready, done.then(() => {}, () => {})]) };
  };
  const streamsOpen = [open(), open()];
  await Promise.all(streamsOpen.map((g) => g.ready));
  const called = await ask(ctx, s, 'tools/call', { params: { name: call.tool, arguments: call.arguments } }).finally(() =>
    setTimeout(() => stop.abort(), LINGER_MS),
  );
  const got = await Promise.all(streamsOpen.map((g) => g.done));
  const details = [...got.map((res, i) => exchange(t, streamsOpen[i]!.req, res)), called.detail];
  const refused = got.find((res) => !ok(res) || !isSse(res));
  if (refused !== undefined)
    return { ...notOffered(`A second GET stream was not opened: HTTP ${refused.status}.`), details };
  const [a, b] = got.map((res) => new Set(res.events.map((e) => e.data).filter((d) => d !== '')));
  if (a!.size + b!.size === 0)
    return { ...prerequisite(`The --fixture call of ${call.tool} sent no message on either GET stream.`), details };
  const both = [...a!].filter((m) => b!.has(m));
  if (both.length === 0) return { ...passed(`${a!.size + b!.size} messages, each on one GET stream only.`), details };
  return {
    ...failed(
      `${both.length} message(s) came on both GET streams.`,
      'Send each message of the server on one of the connected streams only, never on each.',
    ),
    details,
  };
};

export const TRANSPORT: Record<string, ConformanceCheck> = {
  'http-notification-202': notificationAccepted,
  'http-request-content-type': contentType,
  'http-response-utf8': utf8Json,
  'http-single-endpoint': singleEndpoint,
  'http-get-stream-or-405': getStreamOr405,
  'http-modern-get-delete-405': modernGetDelete405,
  'http-session-id-visible-ascii': sessionIdAscii,
  'http-session-required-400': sessionRequired400,
  'http-protocol-version-header-invalid-400': versionHeaderInvalid400,
  'http-concurrent-posts-matched': concurrentMatched,
  'http-sse-event-ids-unique': eventIdsUnique,
  'http-sse-stream-closes': streamCloses,
  'http-sse-no-server-requests': noServerRequests,
  'http-accel-buffering-header': accelBuffering,
  'http-close-cancels': closeCancels,
  'http-session-terminated-404': sessionTerminated404,
  'http-sse-no-broadcast': noBroadcast,
};
