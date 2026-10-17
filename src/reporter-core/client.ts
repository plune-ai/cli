/**
 * The only thing in this package that talks to the platform.
 *
 * It classifies rather than throws. Every caller has to decide something different about a
 * failure — a batch goes to the fallback file, a rejected token silences the rest of the run, a
 * closed run is a configuration mistake worth naming — and an exception hierarchy would make each
 * of those a `catch` that re-derives what already happened here.
 *
 * It also does not log. Anything printed about a failure is printed by the session, which knows
 * the context; keeping the token's only home in this file is what makes AC-12 structural rather
 * than a rule someone has to remember.
 */

import { createReadStream, openAsBlob } from 'node:fs';
import { pipeline } from 'node:stream';
import { Agent as HttpAgent, request as httpRequest } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';

/** The pause before retry `n` (from 0) when the platform named none: 300, 600, 1 200 ms … (x2), at most `BACKOFF_CAP_MS`. */
const BACKOFF_BASE_MS = 300;
const BACKOFF_CAP_MS = 10_000;
/** Retries a request gets by default. An upload asks for more (`uploadRetries`). */
export const DEFAULT_RETRIES = 2;
/** The longest `Retry-After` honoured: a platform that says an hour does not park a CI job for one. */
export const RETRY_AFTER_CAP_MS = 60_000;

/**
 * `Retry-After` as the milliseconds to wait: a count of seconds or an HTTP date, never more than
 * `RETRY_AFTER_CAP_MS`, never negative. `null` when the header is absent or says nothing usable.
 */
export function parseRetryAfter(raw: string | null | undefined, now: number = Date.now()): number | null {
  const text = raw?.trim();
  if (text === undefined || text === '') return null;
  const seconds = /^\d+(\.\d+)?$/.test(text) ? Number(text) : (Date.parse(text) - now) / 1000;
  if (!Number.isFinite(seconds)) return null;
  return Math.min(Math.max(seconds, 0) * 1000, RETRY_AFTER_CAP_MS);
}

/**
 * One pool per scheme, shared by every request of the process: a new connection to the platform costs
 * about 200 ms to the first byte (TLS ~70 ms of it), so a run's tens of requests reuse sockets (plune-ai/plune#1393).
 * An idle socket in the pool is unref'd by Node, so it never keeps the process alive after the last request.
 */
const POOLS = { 'http:': new HttpAgent({ keepAlive: true }), 'https:': new HttpsAgent({ keepAlive: true }) };

/** How long a silent platform is waited for — the idle limit `fetch` had (undici's 300 s). */
const IDLE_MS = 300_000;

/** What the client reads of an answer: all a transport has to give. `Response` is one. */
interface Reply {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}

interface Outgoing {
  method: string;
  headers: Record<string, string>;
  body?: string | Buffer;
}

/**
 * The transport when nobody hands one in: `node:http(s)`, whose parser is native. `fetch` goes through
 * undici, whose first request compiles a WASM parser that V8 re-optimizes on a background thread; on
 * Windows a `process.exit` during that — Playwright calls it as a run ends — trips a libuv assertion,
 * and a green run exits 0xC0000409 (#58). The body is read whole before the answer is handed back.
 */
// ponytail: redirects are not followed (fetch followed them); no platform route redirects.
export function nodeTransport(url: string, init: Outgoing, idleMs: number = IDLE_MS): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
    // `end(body)` with nothing written before it sends a Content-Length of its own, not chunks.
    const agent = POOLS[target.protocol === 'https:' ? 'https:' : 'http:'];
    const req = send(target, { method: init.method, headers: init.headers, agent }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        const status = res.statusCode ?? 0;
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({
          ok: status >= 200 && status <= 299,
          status,
          headers: {
            get: (name) => {
              const value = res.headers[name.toLowerCase()];
              return value === undefined ? null : Array.isArray(value) ? value.join(', ') : value;
            },
          },
          json: async () => JSON.parse(text) as unknown,
        });
      });
    });
    req.setTimeout(idleMs, () => req.destroy(new Error(`no answer from ${target.origin} in ${idleMs} ms`)));
    req.on('error', reject);
    req.end(init.body);
  });
}

export type ClientFailureKind =
  /** The token was refused. Retrying sends the same token to the same door. */
  | 'auth'
  /** The server understood and said no: a closed run, an impossible lifecycle transition. */
  | 'conflict'
  /** The body was refused. It will be refused identically next time. */
  | 'invalid'
  /** Nobody answered, or answered with their own failure. Worth another try. */
  | 'unavailable'
  /** Everything else — reported, never retried, because we cannot say retrying would help. */
  | 'other';

export type ClientOutcome<T> =
  | { ok: true; status: number; body: T }
  | { ok: false; kind: ClientFailureKind; status: number | null; detail: string; code?: string; shardsExpected?: number };

/** What a PUT to a bucket carries: a file on disk, streamed at a length known beforehand, or bytes in memory. */
export type PutSource = { path: string; size: number } | { body: Buffer };

/**
 * How a PUT ended. Never a URL, never a message: the link is a write key to someone's bucket, and the
 * errors of the transports (`getaddrinfo ENOTFOUND <host>`, `no answer from <origin>`) name the host. All
 * that survives is a status and a short code.
 */
export type PutOutcome = { ok: true } | { ok: false; status: number | null; code: string };

export interface ClientOptions {
  apiUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
  /** Test seam — the same idea as `fetchImpl`, so a retry test costs milliseconds, not seconds. */
  wait?: (ms: number) => Promise<void>;
  /** Retries of a file's requests (default 2 for the platform's, 3 for a bucket's): what `uploadRetries` is. */
  uploadRetries?: number;
  /** Test seam for the jitter: a number in [0, 1). */
  random?: () => number;
  /** Test seam for the clock the shared pause is read against. */
  now?: () => number;
  /** Called once for every retry that is about to wait. */
  onRetry?: () => void;
}

export interface PlatformClient {
  /** `retries` after the first try: the default is 2; a file's requests ask for more. */
  post<T>(path: string, body: unknown, retries?: number): Promise<ClientOutcome<T>>;
  /**
   * A file's bytes as the body, under the file's own type (platform ADR 0040) — not JSON. Through the
   * same retries as a POST, so a 429 on the platform's upload limit waits out its `Retry-After`.
   */
  upload<T>(path: string, bytes: Buffer, contentType: string): Promise<ClientOutcome<T>>;
  /**
   * A DELETE, through the same retries, the same classification and the same token scrubbing as a
   * POST. It is here rather than as a bare `fetch` in the one command that needs it because all
   * three of those matter at least as much for a delete: an unclassified 404 reads as an outage, and
   * a proxy error page that echoes the request would put a token in a CI log.
   */
  del<T>(path: string): Promise<ClientOutcome<T>>;
  /** A GET, through the same retries, classification and token scrubbing. */
  get<T>(path: string): Promise<ClientOutcome<T>>;
  /**
   * The bytes to a short-lived link of the customer's bucket (plune-ai/plune#946): exactly the headers the
   * link came with, no token of ours. Network failures and 5xx wait and try again, up to three times; a 403
   * (the link has expired) comes back at once, for the caller to ask for a new one.
   */
  put(url: string, headers: Record<string, string>, source: PutSource): Promise<PutOutcome>;
}


const withoutLength = (headers: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'content-length'));

/**
 * A PUT over `node:http(s)` with the length stated up front (the link is signed on it) and the file piped from
 * disk, never read whole. Why not `fetch`: see `nodeTransport` (#58). Resolves with the status and `Retry-After`.
 *
 * What the bucket SAID wins over what the socket then did: a 403 sent while the body was still going out
 * arrives as a status first and a reset after, and it must be read as the 403 it is (a new link), not as a
 * network failure (three more tries of 100 MB). The file is closed whichever way it ends.
 */
function nodePut(
  url: string,
  headers: Record<string, string>,
  source: PutSource,
  idleMs: number,
): Promise<{ status: number; retryAfter: string | null }> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
    const length = 'body' in source ? source.body.length : source.size;
    let answered: { status: number; retryAfter: string | null } | undefined;
    const settle = (err?: unknown): void => (answered !== undefined ? resolve(answered) : reject(err));
    const req = send(
      target,
      { method: 'PUT', headers: { ...withoutLength(headers), 'content-length': String(length) } },
      (res) => {
        const retry = res.headers['retry-after'];
        answered = { status: res.statusCode ?? 0, retryAfter: Array.isArray(retry) ? (retry[0] ?? null) : (retry ?? null) };
        res.on('error', settle);
        res.on('close', () => {
          resolve(answered as NonNullable<typeof answered>);
          req.destroy(); // the answer is in: no more of the file is wanted
        });
        res.resume();
      },
    );
    req.setTimeout(idleMs, () => req.destroy(Object.assign(new Error('idle'), { code: 'ETIMEDOUT' })));
    req.on('error', settle);
    if ('body' in source) req.end(source.body);
    else pipeline(createReadStream(source.path), req, (err) => (err ? settle(err) : undefined));
  });
}

/** The error's own code (`ECONNRESET`), or `network` — its message may hold the host. */
const codeOfError = (err: unknown): string => {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{2,40}$/.test(code) ? code : 'network';
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Read the server's error message, draining the body either way.
 *
 * A `quota` object in the body is returned as it came (cli#111). The drain is not tidiness: an unread response body leaves undici's socket half-open, which
 * blocks a clean process exit and — on Windows — trips a libuv teardown assertion. `plune sync`
 * learned this one in production.
 */
async function detailOf(res: Reply): Promise<{ detail: string; code?: string; quota?: Record<string, unknown>; shardsExpected?: number }> {
  try {
    const body = (await res.json()) as { error?: unknown; code?: unknown; quota?: unknown; shardsExpected?: unknown };
    const q = body.quota;
    return {
      ...(typeof body.shardsExpected === 'number' && Number.isInteger(body.shardsExpected) ? { shardsExpected: body.shardsExpected } : {}),
      detail: typeof body.error === 'string' ? body.error : '',
      ...(typeof q === 'object' && q !== null && !Array.isArray(q) ? { quota: q as Record<string, unknown> } : {}),
      ...(typeof body.code === 'string' && /^[a-z0-9_]{1,60}$/.test(body.code) ? { code: body.code } : {}),
    };
  } catch {
    return { detail: '' };
  }
}

/** The limit a quota object names, whatever of it the platform gave: `runs: 50 of 50 used, resets 2026-10-18T00:00:00Z`. */
function describeQuota(q: Record<string, unknown>): string {
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const kind = typeof q['kind'] === 'string' ? q['kind'].slice(0, 60) : 'limit';
  const [used, limit] = [num(q['used']), num(q['limit'])];
  const parts = [used !== undefined && limit !== undefined ? `${kind}: ${used} of ${limit} used` : kind];
  if (typeof q['resetsAt'] === 'string' && q['resetsAt'] !== '') parts.push(`resets ${q['resetsAt'].slice(0, 40)}`);
  return parts.join(', ');
}

function classify(status: number): ClientFailureKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 409) return 'conflict';
  if (status === 400) return 'invalid';
  if (status === 429 || status >= 500) return 'unavailable';
  return 'other';
}

export function createClient(opts: ClientOptions): PlatformClient {
  const doFetch: (url: string, init: Outgoing) => Promise<Reply> = opts.fetchImpl ?? nodeTransport;
  const wait = opts.wait ?? sleep;
  const uploadRetries = opts.uploadRetries === undefined ? undefined : Math.max(0, Math.floor(opts.uploadRetries));
  const random = opts.random ?? Math.random;
  const now = opts.now ?? Date.now;
  /**
   * When the platform last asked for patience, until when. Shared by every request of this client: one
   * told to wait holds the next try of all the others, so a limit is met by a pause, not by a hundred
   * requests each finding out for itself (and a 429 storm each paying its own retries).
   */
  let pausedUntil = 0;
  /** [d, 1.5d): never earlier than asked, and spread so that what waited together does not return together. */
  const jittered = (ms: number): number => Math.round(ms * (1 + random() * 0.5));
  /** Sleep for a retry of this request, and make every other request sleep through it as well. */
  async function backOff(attempt: number, said: number | null): Promise<number> {
    opts.onRetry?.();
    const ms = jittered(said ?? Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_CAP_MS));
    const until = now() + ms;
    pausedUntil = Math.max(pausedUntil, until);
    await wait(ms);
    return until;
  }
  /** Before a try: whatever is left of a pause ANOTHER request started (`mine` is the one this request slept through). */
  async function respectPause(mine: number): Promise<void> {
    const left = pausedUntil - now();
    if (pausedUntil > mine && left > 0) await wait(left + Math.round(random() * 250));
  }
  const base = opts.apiUrl.replace(/\/+$/, '');

  /**
   * Strip the token from anything the far side said back to us.
   *
   * The platform does not echo tokens, and this is not aimed at the platform: a proxy, a gateway
   * or a captive-portal error page sits on the same wire, and this string is on its way to a CI
   * log that anyone with read access can scroll.
   */
  const scrub = (text: string): string =>
    opts.token === '' ? text : text.split(opts.token).join('***');

  async function send<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    payload?: { body: string | Buffer; type: string },
    retries: number = DEFAULT_RETRIES,
  ): Promise<ClientOutcome<T>> {
    let last: { kind: ClientFailureKind; status: number | null; detail: string; code?: string; shardsExpected?: number } = {
      kind: 'unavailable',
      status: null,
      detail: 'no attempt was made',
    };

    let mine = 0;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      await respectPause(mine);
      let res: Reply;
      try {
        res = await doFetch(`${base}${path}`, {
          method,
          headers: { 'content-type': payload?.type ?? 'application/json', authorization: `Bearer ${opts.token}` },
          // A DELETE carries none. Sending `"undefined"` as a body is what a naive
          // `JSON.stringify(body)` would do, and some proxies answer that with a 400 nobody can
          // explain.
          ...(payload === undefined ? {} : { body: payload.body }),
        });
      } catch (err) {
        last = { kind: 'unavailable', status: null, detail: scrub(String(err)) };
        if (attempt >= Math.min(retries, DEFAULT_RETRIES)) break;
        mine = await backOff(attempt, null);
        continue;
      }

      if (res.ok) {
        // 204 is the success shape of a delete, and it has no body — `res.json()` on it throws, and
        // the throw would land in the retry loop as "unavailable". The success has to be read as a
        // success by the code that expects a JSON answer everywhere else.
        if (res.status === 204) return { ok: true, status: res.status, body: undefined as T };
        // A success that is not JSON is not the platform's answer — a proxy's page, say. Classified,
        // not thrown: a throw here left `add` with a batch nobody delivered or deferred (#790).
        try {
          return { ok: true, status: res.status, body: (await res.json()) as T };
        } catch {
          return { ok: false, kind: 'other', status: res.status, detail: 'the answer was not JSON' };
        }
      }

      const said = await detailOf(res);
      const kind = classify(res.status);
      last = { kind, status: res.status, detail: scrub(said.detail), ...(said.code !== undefined ? { code: said.code } : {}), ...(said.shardsExpected !== undefined ? { shardsExpected: said.shardsExpected } : {}) };
      if (kind !== 'unavailable') break;

      // A 429 is a quota when its body has a `quota` object, whatever the header says: waiting frees nothing
      // (cli#111). With neither object nor Retry-After it is read the same way, for a platform that predates
      // the object. Only a bare Retry-After is a throttle. Retrying a quota with short delays is useless.
      const said429 = parseRetryAfter(res.headers.get('retry-after'), now());
      if (res.status === 429 && (said.quota !== undefined || said429 === null)) {
        last.kind = 'invalid';
        // The appended text is the same one `scrub` already had a look at above. Appending it raw
        // put whatever a proxy echoed back — the bearer token among it — straight into a CI log.
        last.detail = `quota exceeded (${said.quota === undefined ? 'no Retry-After' : scrub(describeQuota(said.quota))})`;
        if (said.detail) last.detail += ` — ${scrub(said.detail)}`;
        break;
      }

      // Only a platform that SAID when to come back earns the long budget; a dead one does not stall a thousand files six times each.
      if (attempt >= (said429 === null ? Math.min(retries, DEFAULT_RETRIES) : retries)) break;
      mine = await backOff(attempt, said429);
    }

    return { ok: false, ...last };
  }

  return {
    post: <T>(path: string, body: unknown, retries?: number) =>
      send<T>('POST', path, { body: JSON.stringify(body), type: 'application/json' }, retries),
    upload: <T>(path: string, bytes: Buffer, contentType: string) =>
      send<T>('POST', path, { body: bytes, type: contentType }, uploadRetries ?? DEFAULT_RETRIES),
    del: <T>(path: string) => send<T>('DELETE', path),
    get: <T>(path: string) => send<T>('GET', path),
    async put(url, headers, source) {
      const putRetries = uploadRetries ?? 3;
      let last: PutOutcome = { ok: false, status: null, code: 'network' };
      let mine = 0;
      for (let attempt = 0; attempt <= putRetries; attempt += 1) {
        await respectPause(mine);
        try {
          let status: number;
          let retryAfter: string | null;
          if (opts.fetchImpl === undefined) ({ status, retryAfter } = await nodePut(url, headers, source, IDLE_MS));
          else {
            // The length is the Blob's own: `fetch` refuses a `content-length` it did not write.
            const body = 'body' in source ? source.body : await openAsBlob(source.path);
            const res = await opts.fetchImpl(url, { method: 'PUT', headers: withoutLength(headers), body });
            await res.arrayBuffer().catch(() => undefined);
            status = res.status;
            retryAfter = res.headers.get('retry-after');
          }
          if (status >= 200 && status <= 299) return { ok: true };
          last = { ok: false, status, code: `bucket_${status}` };
          // A 429 is a bucket asking for patience, like a 5xx.
          if (status < 500 && status !== 429) return last;
          const said = parseRetryAfter(retryAfter, now());
          if (attempt >= (said === null ? Math.min(putRetries, 3) : putRetries)) return last;
          mine = await backOff(attempt, said);
          continue;
        } catch (err) {
          last = { ok: false, status: null, code: codeOfError(err) };
        }
        if (attempt >= Math.min(putRetries, 3)) return last;
        mine = await backOff(attempt, null);
      }
      return last;
    },
  };
}
