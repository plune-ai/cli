// A local HTTP server that answers like a model provider, from stubs. It never forwards a request anywhere.
//
// Stubs belong to a scope (one case). The scope is the first segment of the request path, so a provider SDK
// carries it in its base URL and the product under test needs no change: point the SDK at `scope.url` plus
// whatever the SDK expects after the host (`<scope.url>/v1` where the base URL holds the version, bare
// `scope.url` where the SDK adds `/v1/...` itself). A stub's `path` is written without the scope.

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
  /** Every request that named this scope, in arrival order. */
  readonly journal: readonly JournalEntry[];
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
  /** Requests whose path named no open scope. */
  readonly unrouted: readonly JournalEntry[];
  scope(name: string, stubs?: StubInput[]): MockScope;
  /** Always resolves, destroys open sockets, safe to call twice. */
  close(): Promise<void>;
}

const MASK = '[masked]';
// By name, not by a list of known providers: any header or query parameter that looks like a credential.
const SECRET_NAME = /auth|key|token|secret|cookie|password|credential/i;
const SCOPE_NAME = /^[A-Za-z0-9._-]+$/;
const MAX_BODY_BYTES = 16 * 1024 * 1024;

interface LiveStub {
  stub: Stub;
  pattern: RegExp;
  calls: number;
}

interface ScopeState {
  stubs: LiveStub[];
  journal: JournalEntry[];
  /** One function per response still held open; calling it destroys the socket. */
  held: Set<() => void>;
}

function pathPattern(path: string): RegExp {
  const source = path
    .split('**')
    .map((part) =>
      part
        .split('*')
        .map((literal) => literal.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('[^/]*'),
    )
    .join('.*');
  return new RegExp(`^${source}$`);
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

function renderBody(response: StubResponse): { type?: string; body: Buffer } {
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

  function answer(req: http.IncomingMessage, res: http.ServerResponse, body: Buffer): void {
    const url = new URL(req.url ?? '/', 'http://local');
    const [, name = '', rest] = /^\/([^/]*)(.*)$/.exec(url.pathname) ?? [];
    const method = req.method ?? 'GET';
    const path = rest === undefined || rest === '' ? '/' : rest;
    const entry: JournalEntry = {
      scope: name,
      method,
      path,
      query: maskedQuery(url.searchParams),
      headers: maskedHeaders(req.headers),
      body: body.subarray(0, journalBodyCap).toString('utf8'),
      bodyTruncated: body.length > journalBodyCap,
      matched: false,
    };
    // The refusal names the method, the path and the scope and nothing else of the request, so no header or
    // query value can leak into an error text.
    const refuse = (message: string): void =>
      sendJson(res, 404, { error: { type: 'mock_no_stub', message, method, path, scope: name } });

    const scope = scopes.get(name);
    if (scope === undefined) {
      unrouted.push(entry);
      refuse(
        `No open scope "${name}" for ${method} ${url.pathname}: the first path segment names the scope`,
      );
      return;
    }
    scope.journal.push(entry);

    let json: unknown;
    let parsed = false;
    const live = scope.stubs.find(({ stub, pattern, calls }) => {
      if (stub.times !== 'always' && calls >= (stub.times === 'once' ? 1 : stub.times))
        return false;
      if (stub.method !== method || !pattern.test(path)) return false;
      if (stub.body === undefined) return true;
      if (!parsed) {
        parsed = true;
        try {
          json = JSON.parse(body.toString('utf8'));
        } catch {
          json = undefined;
        }
      }
      return matchesSubset(stub.body, json);
    });
    if (live === undefined) {
      refuse(`No stub matches ${method} ${path} in scope "${name}"`);
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

  const server = http.createServer((req, res) => {
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
      if (size <= MAX_BODY_BYTES) answer(req, res, Buffer.concat(chunks));
      else
        sendJson(res, 413, {
          error: { type: 'mock_body_too_large', message: 'Request body over 16 MiB' },
        });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  const url = `http://${host.includes(':') ? `[${host}]` : host}:${port}`;

  let closing: Promise<void> | undefined;

  return {
    url,
    port,
    unrouted,
    scope(name, stubs = []) {
      if (!SCOPE_NAME.test(name))
        throw new Error(`Bad scope name "${name}": letters, digits, ".", "_" and "-" only`);
      if (scopes.has(name)) throw new Error(`Scope "${name}" is already open`);
      const state: ScopeState = { stubs: [], journal: [], held: new Set() };
      scopes.set(name, state);
      const scope: MockScope = {
        name,
        url: `${url}/${name}`,
        journal: state.journal,
        add(...inputs) {
          for (const input of inputs) {
            const result = stubSchema.safeParse(input);
            if (!result.success)
              throw new Error(`Invalid stub: ${formatIssues(result.error).join('; ')}`);
            state.stubs.push({
              stub: result.data,
              pattern: pathPattern(result.data.path),
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
