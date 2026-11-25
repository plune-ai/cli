// A local HTTP server that answers like a model provider, from stubs. It never forwards a request anywhere.
//
// Stubs belong to a scope (one case). The scope is the first segment of the request path, so a provider SDK
// carries it in its base URL and the product under test needs no change: point the SDK at `scope.url` plus
// whatever the SDK expects after the host (`<scope.url>/v1` where the base URL holds the version, bare
// `scope.url` where the SDK adds `/v1/...` itself). A stub's `path` is written without the scope.
//
// The scope is read from the request target as it was written, with nothing decoded or normalised: a
// target with a `.` or `..` segment, or with nothing where the scope goes, is refused with a 400.
//
// What the journal keeps: header and query VALUES are masked where the name looks like a credential; the
// path and the body are kept as they came, unmasked. Do not send a real secret in a path or a body to this
// server and then print the journal. An answer to a request the server cannot serve repeats nothing of
// the target: the path is in the journal, not in the 404.
//
// Limits, so that a client in a loop cannot take the process down: each journal keeps its newest
// `JOURNAL_MAX_ENTRIES` entries and counts the rest in `dropped`; the server holds at most
// `MAX_CONNECTIONS` connections at once, a held `timeout` included, and drops a new one over that. With
// the default body cap a full journal is at most 1,000 x 64 KiB = 64 MiB of body bytes per scope.

import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  formatIssues,
  stubSchema,
  type Stub,
  type StubInput,
  type StubResponse,
} from './schema.js';

export interface JournalEntry {
  scope: string;
  method: string;
  /** Without the scope segment and without the query string. */
  path: string;
  /** Without the leading `?`; values of secret-looking parameters are masked. */
  query: string;
  /** Lower-case names; values of secret-looking headers are masked. */
  headers: Record<string, string>;
  /** The first `journalBodyCap` bytes. */
  body: string;
  bodyTruncated: boolean;
  /** Whether a stub answered. */
  matched: boolean;
}

/** Entries one journal keeps (each scope, and the unrouted list); the oldest go first. */
export const JOURNAL_MAX_ENTRIES = 1000;
/** Connections open at once; one more is dropped by the server without an answer. */
export const MAX_CONNECTIONS = 256;

export interface StartOptions {
  /** `127.0.0.1` unless asked otherwise. */
  host?: string;
  /** An ephemeral port unless asked otherwise. */
  port?: number;
  /** Bytes of a request body kept in the journal. Default 64 KiB. */
  journalBodyCap?: number;
  /** The clock and timer a slow stream is paced by. Default: the real ones. */
  timers?: MockTimers;
}

export interface MockTimers {
  /** Milliseconds on a clock that never goes back. */
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const REAL_TIMERS: MockTimers = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};
// A slow stream is written in pieces of about this much time each.
const SLOW_STREAM_STEP_MS = 50;

export interface MockScope {
  readonly name: string;
  /** `<server.url>/<name>`: what a provider SDK's base URL starts with. */
  readonly url: string;
  /** The newest `JOURNAL_MAX_ENTRIES` requests that named this scope, in arrival order. */
  readonly journal: readonly JournalEntry[];
  /** How many older entries the journal has let go. */
  readonly dropped: number;
  add(...stubs: StubInput[]): void;
  /**
   * Removes the scope and its stubs, ends the requests it still holds (a `timeout`, a `slow_stream`) by
   * destroying their sockets, and returns the stubs that were never called.
   */
  close(): Stub[];
}

export interface MockServer {
  readonly url: string;
  readonly port: number;
  /** The newest `JOURNAL_MAX_ENTRIES` requests whose target named no open scope or was refused. */
  readonly unrouted: readonly JournalEntry[];
  /** How many older entries `unrouted` has let go. */
  readonly unroutedDropped: number;
  /** Throws on a name that is taken or cannot be a path segment, and once the server is closed. */
  scope(name: string, stubs?: StubInput[]): MockScope;
  /** Always resolves, destroys open sockets, safe to call twice. */
  close(): Promise<void>;
}

export const MASK = '[masked]';
// By name, not by a list of known providers: any header or query parameter that looks like a credential.
// It errs on the side of masking: `code` also hides a harmless `x-error-code`.
export const SECRET_NAME =
  /auth|key|token|secret|cookie|password|passwd|pwd|credential|sig|jwt|session|csrf|otp|code|assertion/i;
export const SCOPE_NAME = /^(?!\.{1,2}$)[A-Za-z0-9._-]+$/;
// `.` and `..`, also percent-encoded: a client or a proxy on the way may resolve them.
export const DOT_SEGMENT = /^(\.|%2e){1,2}$/i;
export const MAX_BODY_BYTES = 16 * 1024 * 1024;

interface LiveStub {
  stub: Stub;
  matches: (path: string) => boolean;
  calls: number;
}

interface ScopeState {
  stubs: LiveStub[];
  journal: JournalEntry[];
  dropped: number;
  /** One function per response still held open; calling it destroys the socket. */
  held: Set<() => void>;
}

/**
 * A stub path as a matcher: `*` is any run of characters without a slash, `**` any run at all. It follows
 * every way to match at once (`at[i]`: the first i tokens match what was read so far), so the time is the
 * pattern length times the path length whatever the pattern; a backtracking regular expression is not.
 */
export function pathMatcher(pattern: string): (path: string) => boolean {
  const tokens = pattern.match(/\*\*|[^]/g) ?? [];
  const n = tokens.length;
  // A wildcard may also match nothing.
  const skipWildcards = (at: Uint8Array): void => {
    for (let i = 0; i < n; i += 1)
      if (at[i] && (tokens[i] === '*' || tokens[i] === '**')) at[i + 1] = 1;
  };
  return (path) => {
    let at = new Uint8Array(n + 1);
    at[0] = 1;
    skipWildcards(at);
    for (let c = 0; c < path.length; c += 1) {
      const ch = path[c];
      const next = new Uint8Array(n + 1);
      for (let i = 0; i < n; i += 1) {
        if (!at[i]) continue;
        const token = tokens[i];
        if (token === '**' || (token === '*' && ch !== '/')) next[i] = 1;
        else if (token !== '*' && token === ch) next[i + 1] = 1;
      }
      skipWildcards(next);
      at = next;
    }
    return at[n] === 1;
  };
}

/** Whether `actual` holds everything `expected` asks for. */
export function matchesSubset(expected: unknown, actual: unknown): boolean {
  if (Array.isArray(expected))
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((item, i) => matchesSubset(item, actual[i]))
    );
  if (expected !== null && typeof expected === 'object')
    return (
      actual !== null &&
      typeof actual === 'object' &&
      !Array.isArray(actual) &&
      Object.entries(expected).every(
        ([k, v]) =>
          Object.hasOwn(actual, k) && matchesSubset(v, (actual as Record<string, unknown>)[k]),
      )
    );
  return expected === actual;
}

/** Whether `actual` is `expected`, where each `[masked]` in `expected` stands for any text. */
export function maskedTextMatches(expected: string, actual: string): boolean {
  const parts = expected.split(MASK);
  const first = parts[0]!;
  const last = parts[parts.length - 1]!;
  if (parts.length === 1) return expected === actual;
  if (actual.length < first.length + last.length) return false;
  if (!actual.startsWith(first) || !actual.endsWith(last)) return false;
  // The parts in between, each at the first place it fits after the one before: enough for "any text".
  const end = actual.length - last.length;
  let at = first.length;
  for (const part of parts.slice(1, -1)) {
    const found = actual.indexOf(part, at);
    if (found === -1 || found + part.length > end) return false;
    at = found + part.length;
  }
  return true;
}

/**
 * Whether `actual` is the whole of `expected`: the same keys, the same items, the same values. A value of
 * `expected` that is `[masked]` and nothing else matches any value that is there.
 */
export function matchesExact(expected: unknown, actual: unknown): boolean {
  if (expected === MASK) return actual !== undefined;
  if (typeof expected === 'string')
    return typeof actual === 'string' && maskedTextMatches(expected, actual);
  if (Array.isArray(expected))
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((item, i) => matchesExact(item, actual[i]))
    );
  if (expected !== null && typeof expected === 'object')
    return (
      actual !== null &&
      typeof actual === 'object' &&
      !Array.isArray(actual) &&
      Object.keys(actual).length === Object.keys(expected).length &&
      Object.entries(expected).every(
        ([k, v]) =>
          Object.hasOwn(actual, k) && matchesExact(v, (actual as Record<string, unknown>)[k]),
      )
    );
  return expected === actual;
}

/**
 * Why a request is not served, or nothing. Only a request addressed to the server by a loopback name and
 * its own port is: a name that merely resolves to this machine is how a web page elsewhere reaches a local
 * server (DNS rebinding). A request a browser sent for a page of another origin is refused too: one with
 * an `Origin` that is not the server's, and one the browser marked in `Sec-Fetch-Site` as coming from
 * another site, which it does also where it sends no `Origin` (a plain GET for an image or a link). A page
 * cannot set or remove that header. A client that is not a browser sends neither and is served. No answer
 * of the server carries a CORS header, so no page can read one.
 */
export function notLocal(req: http.IncomingMessage, port: number, bound = '127.0.0.1'): boolean {
  const names = ['127.0.0.1', 'localhost', '[::1]', bound.includes(':') ? `[${bound}]` : bound];
  const hosts = names.flatMap((name) => (port === 80 ? [name, `${name}:80`] : [`${name}:${port}`]));
  const host = (req.headers.host ?? '').toLowerCase();
  const { origin } = req.headers;
  const site = req.headers['sec-fetch-site'];
  return (
    !hosts.includes(host) ||
    (origin !== undefined && !hosts.some((h) => origin.toLowerCase() === `http://${h}`)) ||
    // Fail closed: of the four values a browser sends, `cross-site` and `same-site` are another site.
    (site !== undefined && !['same-origin', 'none'].includes(String(site).toLowerCase()))
  );
}

export const NOT_LOCAL_MESSAGE =
  'This server answers only a request addressed to 127.0.0.1, localhost or [::1] with its own port, and none a browser marks as sent from another site';

function maskedHeaders(headers: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    out[name] = SECRET_NAME.test(name) ? MASK : Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}

function maskedQuery(params: URLSearchParams): string {
  return [...params]
    .map(
      ([k, v]) => `${encodeURIComponent(k)}=${SECRET_NAME.test(k) ? MASK : encodeURIComponent(v)}`,
    )
    .join('&');
}

export function renderBody(response: StubResponse): { type?: string; body: Buffer } {
  if (response.sse !== undefined) {
    const events = response.sse.map((chunk) => {
      const { event, data } = typeof chunk === 'string' ? { event: undefined, data: chunk } : chunk;
      const line = typeof data === 'string' ? data : JSON.stringify(data);
      return `${event === undefined ? '' : `event: ${event}\n`}data: ${line}\n\n`;
    });
    return { type: 'text/event-stream', body: Buffer.from(events.join('')) };
  }
  if (response.text !== undefined)
    return { type: 'text/plain; charset=utf-8', body: Buffer.from(response.text) };
  if (response.json !== undefined)
    return { type: 'application/json', body: Buffer.from(JSON.stringify(response.json)) };
  return { body: Buffer.alloc(0) };
}

function responseHeaders(response: StubResponse, type: string | undefined, length: number) {
  const headers: Record<string, string | number> = {};
  if (type !== undefined) headers['content-type'] = type;
  // An event stream has no length known ahead, as from a real provider; everything else declares it.
  if (response.sse === undefined) headers['content-length'] = length;
  else headers['cache-control'] = 'no-cache';
  for (const [name, value] of Object.entries(response.headers)) headers[name.toLowerCase()] = value;
  return headers;
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
    ...headers,
  });
  res.end(text);
}

// One body that reads as an error to clients of either common shape: `error.type` and `error.message`
// under a top-level `type: "error"`, and `error.code`.
const providerError = (type: string, code: string, message: string) => ({
  type: 'error',
  error: { type, code, message },
});

/**
 * Writes `body` so that by any moment `bytesPerSec` times the seconds passed have been sent, never more.
 * The amount due is read from the clock at each step, so a late timer does not slow the stream down.
 * Returns the function that stops it.
 */
function writeSlowly(
  res: http.ServerResponse,
  body: Buffer,
  bytesPerSec: number,
  timers: MockTimers,
): () => void {
  const startedAt = timers.now();
  const step = Math.max(1, Math.round((bytesPerSec * SLOW_STREAM_STEP_MS) / 1000));
  let sent = 0;
  let handle: unknown;
  const tick = (): void => {
    const due = Math.min(
      body.length,
      Math.floor(((timers.now() - startedAt) * bytesPerSec) / 1000),
    );
    if (due > sent) {
      res.write(body.subarray(sent, due));
      sent = due;
    }
    if (sent >= body.length) {
      res.end();
      return;
    }
    // The schema keeps the rate at one byte a second or more, so no wait is over a second.
    const nextAt = startedAt + (Math.min(body.length, sent + step) * 1000) / bytesPerSec;
    handle = timers.setTimeout(tick, Math.max(1, Math.ceil(nextAt - timers.now())));
  };
  tick();
  return () => timers.clearTimeout(handle);
}

export async function start(options: StartOptions = {}): Promise<MockServer> {
  const host = options.host ?? '127.0.0.1';
  const journalBodyCap = options.journalBodyCap ?? 64 * 1024;
  const timers = options.timers ?? REAL_TIMERS;
  const scopes = new Map<string, ScopeState>();
  const unrouted: JournalEntry[] = [];
  let unroutedDropped = 0;
  let closing: Promise<void> | undefined;

  /** Adds to a journal and says how many entries fell off its far end. */
  const record = (journal: JournalEntry[], entry: JournalEntry): number => {
    journal.push(entry);
    if (journal.length <= JOURNAL_MAX_ENTRIES) return 0;
    journal.shift();
    return 1;
  };

  function answer(req: http.IncomingMessage, res: http.ServerResponse, body: Buffer): void {
    // The target is taken apart by hand and as written: a URL parser throws on some targets and resolves
    // `..` and `//` in others, which would take a request into a scope its first segment does not name.
    const target = req.url ?? '';
    const queryAt = target.indexOf('?');
    const rawPath = queryAt === -1 ? target : target.slice(0, queryAt);
    const segments = rawPath.split('/');
    const badTarget =
      segments[0] !== '' ||
      segments.length < 2 ||
      (segments[1] === '' && segments.length > 2) ||
      segments.some((segment) => DOT_SEGMENT.test(segment));
    const name = badTarget ? '' : segments[1]!;
    const method = req.method ?? 'GET';
    const path = badTarget ? rawPath : rawPath.slice(name.length + 1) || '/';
    const entry: JournalEntry = {
      scope: name,
      method,
      path,
      query: maskedQuery(new URLSearchParams(queryAt === -1 ? '' : target.slice(queryAt + 1))),
      headers: maskedHeaders(req.headers),
      body: body.subarray(0, journalBodyCap).toString('utf8'),
      bodyTruncated: body.length > journalBodyCap,
      matched: false,
    };
    // A refusal names the method, and the scope when it is an open one, and nothing else of the request:
    // no path, query or header value can leak into an error text.
    const refuse = (status: number, type: string, message: string, open?: string): void =>
      sendJson(res, status, {
        error: { type, message, method, ...(open === undefined ? {} : { scope: open }) },
      });

    const scope = badTarget ? undefined : scopes.get(name);
    if (scope === undefined) {
      unroutedDropped += record(unrouted, entry);
      if (badTarget)
        refuse(
          400,
          'mock_bad_target',
          'Bad request target: it starts with "/<scope>" and holds no "." or ".." segment',
        );
      else
        refuse(
          404,
          'mock_no_stub',
          `No open scope for this ${method} request: the first path segment names the scope`,
        );
      return;
    }
    scope.dropped += record(scope.journal, entry);

    let json: unknown;
    let parsed = false;
    const live = scope.stubs.find(({ stub, matches, calls }) => {
      if (stub.times !== 'always' && calls >= (stub.times === 'once' ? 1 : stub.times))
        return false;
      if (stub.method !== method || !matches(path)) return false;
      const exact = stub.match === 'exact';
      if (stub.body === undefined && !exact) return true;
      if (!parsed) {
        parsed = true;
        try {
          json = JSON.parse(body.toString('utf8'));
        } catch {
          json = undefined;
        }
      }
      if (!exact) return matchesSubset(stub.body, json);
      return stub.body === undefined ? json === undefined : matchesExact(stub.body, json);
    });
    if (live === undefined) {
      refuse(
        404,
        'mock_no_stub',
        `No stub matches this ${method} request in scope "${name}": compare its path and body in the journal of the scope with the stubs`,
        name,
      );
      return;
    }
    entry.matched = true;
    live.calls += 1;

    // The schema gives every stub the response its failure needs; the fallback is for the types only.
    const response = live.stub.response ?? { status: 200, headers: {} };
    const rendered = renderBody(response);
    const head = (length: number): void => {
      res.writeHead(response.status, responseHeaders(response, rendered.type, length));
    };
    const { failure } = live.stub;
    if (failure === undefined || (failure.first !== undefined && live.calls > failure.first)) {
      head(rendered.body.length);
      res.end(rendered.body);
      return;
    }

    // A response left open belongs to the scope until its socket closes, whoever closes it.
    const hold = (stop: () => void = () => undefined): void => {
      const abort = (): void => {
        stop();
        res.destroy();
      };
      scope.held.add(abort);
      res.on('close', () => {
        stop();
        scope.held.delete(abort);
      });
    };
    switch (failure.type) {
      case 'timeout':
        hold();
        return;
      case 'reset':
        req.socket.resetAndDestroy();
        return;
      case 'http_429':
        sendJson(
          res,
          429,
          providerError('rate_limit_error', 'rate_limit_exceeded', 'Rate limit exceeded (stub)'),
          { 'retry-after': String(failure.retry_after_seconds) },
        );
        return;
      case 'http_500':
        sendJson(
          res,
          500,
          providerError('api_error', 'internal_error', 'Internal server error (stub)'),
        );
        return;
      case 'slow_stream':
        head(rendered.body.length);
        res.flushHeaders();
        hold(writeSlowly(res, rendered.body, failure.bytes_per_sec, timers));
        return;
      case 'truncated_json': {
        const cut = rendered.body.subarray(0, Math.floor(rendered.body.length / 2));
        if (failure.content_length === 'cut') {
          head(cut.length);
          res.end(cut);
        } else {
          head(rendered.body.length);
          res.write(cut, () => res.destroy());
        }
        return;
      }
    }
  }

  let port = 0;
  const server = http.createServer((req, res) => {
    if (notLocal(req, port, host)) {
      req.resume();
      sendJson(res, 403, { error: { type: 'mock_not_local', message: NOT_LOCAL_MESSAGE } });
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('error', () => undefined);
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      // Past the limit the rest is read and dropped, so the refusal still reaches the client.
      if (size <= MAX_BODY_BYTES) chunks.push(chunk);
      else chunks.length = 0;
    });
    req.on('end', () => {
      if (size > MAX_BODY_BYTES) {
        sendJson(res, 413, {
          error: { type: 'mock_body_too_large', message: 'Request body over 16 MiB' },
        });
        return;
      }
      // Nothing a request holds may take the process down: whatever `answer` did not foresee ends here.
      try {
        answer(req, res, Buffer.concat(chunks));
      } catch {
        if (res.headersSent) res.destroy();
        else
          sendJson(res, 500, {
            error: { type: 'mock_internal', message: 'The stub server failed on this request' },
          });
      }
    });
  });
  server.maxConnections = MAX_CONNECTIONS;

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  ({ port } = server.address() as AddressInfo);
  const url = `http://${host.includes(':') ? `[${host}]` : host}:${port}`;

  return {
    url,
    port,
    unrouted,
    get unroutedDropped() {
      return unroutedDropped;
    },
    scope(name, stubs = []) {
      if (closing !== undefined) throw new Error('The server is closed: it takes no new scope');
      if (!SCOPE_NAME.test(name))
        throw new Error(
          `Bad scope name "${name}": letters, digits, ".", "_" and "-" only, and not "." or ".."`,
        );
      if (scopes.has(name)) throw new Error(`Scope "${name}" is already open`);
      const state: ScopeState = { stubs: [], journal: [], dropped: 0, held: new Set() };
      scopes.set(name, state);
      const scope: MockScope = {
        name,
        url: `${url}/${name}`,
        journal: state.journal,
        get dropped() {
          return state.dropped;
        },
        add(...inputs) {
          for (const input of inputs) {
            const result = stubSchema.safeParse(input);
            if (!result.success)
              throw new Error(`Invalid stub: ${formatIssues(result.error).join('; ')}`);
            state.stubs.push({
              stub: result.data,
              matches:
                result.data.match === 'exact'
                  ? (path) => maskedTextMatches(result.data.path, path)
                  : pathMatcher(result.data.path),
              calls: 0,
            });
          }
        },
        close() {
          if (scopes.get(name) === state) scopes.delete(name);
          const unused = state.stubs.filter((s) => s.calls === 0).map((s) => s.stub);
          state.stubs = [];
          for (const abort of [...state.held]) abort();
          return unused;
        },
      };
      scope.add(...stubs);
      return scope;
    },
    close() {
      closing ??= new Promise<void>((resolve) => {
        for (const state of scopes.values()) for (const abort of [...state.held]) abort();
        scopes.clear();
        server.close(() => resolve());
        server.closeAllConnections();
      });
      return closing;
    },
  };
}

/** Runs `fn` with a server and closes it afterwards, also when `fn` throws. */
export async function withServer<T>(
  fn: (server: MockServer) => Promise<T> | T,
  options: StartOptions = {},
): Promise<T> {
  const server = await start(options);
  try {
    return await fn(server);
  } finally {
    await server.close();
  }
}
