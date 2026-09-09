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

/** How long to wait before each retry, and — by its length — how many retries there are. */
const RETRY_DELAYS_MS = [300, 900] as const;

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
  | { ok: false; kind: ClientFailureKind; status: number | null; detail: string };

export interface ClientOptions {
  apiUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
  /** Test seam — the same idea as `fetchImpl`, so a retry test costs milliseconds, not seconds. */
  wait?: (ms: number) => Promise<void>;
}

export interface PlatformClient {
  post<T>(path: string, body: unknown): Promise<ClientOutcome<T>>;
  /**
   * A DELETE, through the same retries, the same classification and the same token scrubbing as a
   * POST. It is here rather than as a bare `fetch` in the one command that needs it because all
   * three of those matter at least as much for a delete: an unclassified 404 reads as an outage, and
   * a proxy error page that echoes the request would put a token in a CI log.
   */
  del<T>(path: string): Promise<ClientOutcome<T>>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Read the server's error message, draining the body either way.
 *
 * The drain is not tidiness: an unread response body leaves undici's socket half-open, which
 * blocks a clean process exit and — on Windows — trips a libuv teardown assertion. `plune sync`
 * learned this one in production.
 */
async function detailOf(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    return typeof body.error === 'string' ? body.error : '';
  } catch {
    return '';
  }
}

/** `Retry-After` in seconds, or `null` if the header is absent or not a count of seconds. */
function retryAfterMs(res: Response): number | null {
  const raw = res.headers.get('retry-after');
  if (raw === null) return null;
  const seconds = Number(raw.trim());
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
}

function classify(status: number): ClientFailureKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 409) return 'conflict';
  if (status === 400) return 'invalid';
  if (status === 429 || status >= 500) return 'unavailable';
  return 'other';
}

export function createClient(opts: ClientOptions): PlatformClient {
  const doFetch = opts.fetchImpl ?? fetch;
  const wait = opts.wait ?? sleep;
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
    method: 'POST' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<ClientOutcome<T>> {
    let last: { kind: ClientFailureKind; status: number | null; detail: string } = {
      kind: 'unavailable',
      status: null,
      detail: 'no attempt was made',
    };

    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
      let res: Response;
      try {
        res = await doFetch(`${base}${path}`, {
          method,
          headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.token}` },
          // A DELETE carries none. Sending `"undefined"` as a body is what a naive
          // `JSON.stringify(body)` would do, and some proxies answer that with a 400 nobody can
          // explain.
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch (err) {
        last = { kind: 'unavailable', status: null, detail: scrub(String(err)) };
        if (attempt < RETRY_DELAYS_MS.length) await wait(RETRY_DELAYS_MS[attempt] as number);
        continue;
      }

      if (res.ok) {
        // 204 is the success shape of a delete, and it has no body — `res.json()` on it throws, and
        // the throw would land in the retry loop as "unavailable". The success has to be read as a
        // success by the code that expects a JSON answer everywhere else.
        if (res.status === 204) return { ok: true, status: res.status, body: undefined as T };
        return { ok: true, status: res.status, body: (await res.json()) as T };
      }

      const detail = scrub(await detailOf(res));
      const kind = classify(res.status);
      last = { kind, status: res.status, detail };
      if (kind !== 'unavailable') break;

      if (attempt < RETRY_DELAYS_MS.length) {
        await wait(retryAfterMs(res) ?? (RETRY_DELAYS_MS[attempt] as number));
      }
    }

    return { ok: false, ...last };
  }

  return {
    post: <T>(path: string, body: unknown) => send<T>('POST', path, body),
    del: <T>(path: string) => send<T>('DELETE', path),
  };
}
