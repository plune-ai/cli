import { stripVTControlCharacters } from 'node:util';
import { maskCredentials, type Finding, type ResultFindings } from '@plune-ai/cli/reporter-core';

/**
 * What the browser reported while a test ran: console errors, page errors, requests that failed or
 * were slow. Collected in the test worker and handed to the reporter as one attachment — a reporter
 * is another process, and an attachment is the only thing that crosses.
 *
 * Everything is reduced here, before it leaves the worker: an address to its path, a text to 300
 * cleaned characters with credentials masked. No header, body, cookie, post data or query string is
 * ever read.
 */

/** The content type of the attachment, beside the metadata one: read by the reporter, not a file of the test. */
export const FINDINGS_TYPE = 'application/plune.findings+json';
/** How many findings one result may carry; the rest are only counted. */
export const FINDINGS_MAX = 20;
/** The ceiling of that count. */
export const OMITTED_MAX = 100_000;
const TEXT_MAX = 300;

/** One finding as the worker keeps it: `at` is the time it belongs to, in epoch milliseconds. */
export type CollectedFinding =
  | { kind: 'console' | 'page_error'; text: string; at: number }
  | {
      kind: 'request_failed' | 'request_slow';
      method: string;
      path: string;
      status?: number;
      durationMs?: number;
      at: number;
    };

/** The attachment's body. `{ items: [], omitted: 0 }` says «collected, nothing found». */
export interface CollectedFindings {
  items: CollectedFinding[];
  /** Seen and not kept: past the limit, or impossible to make valid. */
  omitted: number;
}

export interface Collector {
  console(text: string, at: number): void;
  pageError(message: string, at: number): void;
  /** A request that got an answer; `at` is when the request started. */
  response(seen: {
    url: string;
    method: string;
    status: number;
    at: number;
    durationMs: number;
  }): void;
  /** A request that never got one. */
  failed(seen: { url: string; method: string; errorText?: string; at: number }): void;
  result(): CollectedFindings;
}

const METHOD = /^[A-Z]{1,16}$/;
const PATH = /^\/(?!\/)[^?#]*$/;

/** At most `max`, and not half of a character pair at the cut. */
function clip(text: string, max = TEXT_MAX): string {
  const cut = text.slice(0, max);
  return /[\ud800-\udbff]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/**
 * How much of a raw text is ever read. A page can write a megabyte to its console, and the cleaning runs
 * inside the listener, in the test's own worker: nothing below may cost more than this length allows.
 * 300 are kept in the end; the rest is room for what the cutting takes away.
 */
const WORK_MAX = 4000;

/**
 * What ends a word: a space, a quote or an angle bracket. Defined once, for the split into words and for the
 * search of the word the working length cut through — two ideas of a word would let half of one out.
 */
const SEPARATORS = String.raw`\s"'\x60<>`;
const SEPARATOR = new RegExp(`[${SEPARATORS}]`);
/** One word: where an address written into a text ends. */
const TOKEN = new RegExp(`[^${SEPARATORS}]+`, 'g');
const SCHEME = /(?:https?|wss?):\/\//i;
/** A `/`, `./` or `../` where a word starts: at the head of the token or after an opening mark. */
const PATH_START = /(?:^|[(\[{=:,;])\.{0,2}\//;
/** A query by its shape: `?`, a name, `=`. A name is word characters, `-`, `.`, `[`, `]` and `%`. */
const NAMED_QUERY = /\?[\w\-.[\]%]+=/;

/** The index of the first `?` or `#` at or after `from`, or the length. */
function markIn(token: string, from: number): number {
  const at = token.slice(from).search(/[?#]/);
  return at === -1 ? token.length : from + at;
}

/**
 * One token without what an address must not carry out of the worker. Three rules, each a single pass:
 * 1. `?name=` anywhere in it: cut at that `?` (`api.x/y?id=5`, `localhost:3000/a?x=1`, `./api?x=1`).
 * 2. `http(s)://` or `ws(s)://` in it: cut at the first `?` or `#` after it, and the user and password go.
 * 3. a `/`, `./` or `../` where a word starts: cut at the first `?` or `#` after it (`/cb#access_token=…`).
 * Removed, not masked: as from a request's own address.
 *
 * ponytail: by shape, not by parsing. Named so nobody takes it for more:
 * - the cut runs to the end of the token, so punctuation after an address goes with it (`…/a?x=1).` loses `).`);
 * - a value with a raw space, quote or angle bracket in it ends the token there, and what follows is kept;
 * - a query with no `name=` on an address with no scheme and no leading slash (`api.x/y?abc`) is not seen,
 *   nor is a fragment on one (`api.x/y#token`);
 * - prose shaped like rule 1 (`what?no=yes`) is cut too.
 */
function withoutQuery(token: string): string {
  const named = token.search(NAMED_QUERY);
  let out = named === -1 ? token : token.slice(0, named);

  const scheme = SCHEME.exec(out);
  if (scheme !== null) {
    const from = scheme.index + scheme[0].length;
    const rest = out.slice(from, markIn(out, from));
    const slash = rest.indexOf('/');
    const user = rest.lastIndexOf('@', slash === -1 ? rest.length : slash);
    return out.slice(0, from) + rest.slice(user + 1);
  }
  const path = PATH_START.exec(out);
  if (path !== null) out = out.slice(0, markIn(out, path.index));
  return out;
}

/** What stands where the value of a named environment variable stood: the marker the shape masking writes for one. */
const SECRET_MARK = '‹env-secret›';
/**
 * ponytail: a value under four characters is not masked. Replacing every `123` or `dev` of a text would
 * shred it and hide nothing: so short a value is found by trying. Give such a secret a longer value.
 */
const SECRET_MIN = 4;

/**
 * The values to mask, from the NAMES of environment variables: each value as it is, and as an address carries
 * it (`encodeURIComponent`, and `encodeURI`, which is how a path keeps `/` and `@` and encodes a space).
 * Longest first, so a value that holds another is masked whole. A name that is not set, or set to nothing, is skipped.
 *
 * ponytail: a value the page transformed in any other way (base64, a hash, lower-case percent escapes,
 * split over two lines) is another string, and is not recognised.
 */
export function secretValues(
  names: readonly string[],
  env: Record<string, string | undefined> = process.env,
): string[] {
  const forms = new Set<string>();
  for (const name of Array.isArray(names) ? (names as unknown[]) : []) {
    const value = typeof name === 'string' ? env[name] : undefined;
    if (value === undefined || value.length < SECRET_MIN) continue;
    forms.add(value);
    for (const encode of [encodeURIComponent, encodeURI]) {
      try {
        forms.add(encode(value));
      } catch {
        // half of a character pair has no encoded form
      }
    }
  }
  return [...forms].sort((a, b) => b.length - a.length);
}

/** Every occurrence of every value, as written: no pattern is made of a value. */
function withoutSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) out = out.split(secret).join(SECRET_MARK);
  return out;
}

/**
 * A text as it may leave the worker. The order is the point; each step would lose something to an earlier one:
 * 0. the values of the named environment variables, on the raw text: before any cut can leave the head of one
 *    behind, and before a shape rule can take a part of one. Read a value's length past the working length,
 *    so one that the cut would go through is still seen whole;
 * 1. the head of the text only (`WORK_MAX`), without the word the cut went through — half a credential is
 *    not a credential the masking knows;
 * 2. credentials masked while the line breaks are still there: a header line (`Cookie: …`) is known by its line;
 * 3. addresses cut;
 * 4. control characters and line breaks to single spaces;
 * 5. the clip to 300.
 */
function cleaned(raw: string, secrets: readonly string[]): string {
  const window = raw.slice(0, WORK_MAX + (secrets[0]?.length ?? 0));
  const text = withoutSecrets(window, secrets);
  let head = clip(text, WORK_MAX);
  // The character after the cut, in the masked text or, when that was all of it, in what was never read.
  const next = text.length > head.length ? text[head.length] : raw[window.length];
  // A cut that falls on a separator went through no word. With no separator before it the whole text is
  // the cut word: nothing is left, and the caller drops and counts it.
  if (next !== undefined && !SEPARATOR.test(next)) {
    let end = head.length;
    while (end > 0 && !SEPARATOR.test(head[end - 1]!)) end -= 1;
    head = head.slice(0, end);
  }
  const masked = maskCredentials(stripVTControlCharacters(head));
  const flat = masked.replace(TOKEN, withoutQuery).replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ');
  return clip(flat.trim());
}

/** `secrets` are values, from `secretValues`: masked in every text and every path before it is kept. */
export function createCollector(slowMs: number, secrets: readonly string[] = []): Collector {
  let items: CollectedFinding[] = [];
  let omitted = 0;

  const drop = (): void => {
    omitted = Math.min(OMITTED_MAX, omitted + 1);
  };
  /** The first `FINDINGS_MAX` by time, whatever order they arrive in: a slow request is known late and started early. */
  const keep = (finding: CollectedFinding): void => {
    items.push(finding);
    items.sort((a, b) => a.at - b.at);
    if (items.length > FINDINGS_MAX) {
      items = items.slice(0, FINDINGS_MAX);
      drop();
    }
  };
  const text = (kind: 'console' | 'page_error', raw: string, at: number): void => {
    const clean = cleaned(String(raw), secrets);
    if (clean === '') drop();
    else keep({ kind, text: clean, at });
  };
  /** `null`: not a web request, so neither a finding nor counted. `undefined`: one that cannot be sent, counted. */
  const place = (
    url: string,
    rawMethod: string,
  ): { method: string; path: string } | null | undefined => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    const method = String(rawMethod).toUpperCase();
    // A path made invalid or too long by a marker is dropped and counted below, like any other.
    const path = maskCredentials(withoutSecrets(parsed.pathname, secrets));
    return METHOD.test(method) && PATH.test(path) && path.length <= TEXT_MAX
      ? { method, path }
      : undefined;
  };
  const request = (
    kind: 'request_failed' | 'request_slow',
    seen: { url: string; method: string; at: number },
    extra: { status?: number; durationMs?: number },
  ): void => {
    const where = place(seen.url, seen.method);
    if (where === null) return;
    if (where === undefined) drop();
    else keep({ kind, ...where, ...extra, at: seen.at });
  };

  return {
    console(raw, at) {
      // ponytail: Chromium prints «Failed to load resource: …» for every failed request, which is already a
      // request finding. Matched by the text and by Chromium's wording: another browser's echo is kept as a console
      // line, and a page's own console.error starting with these words is lost. Compare by request if that matters.
      if (String(raw).startsWith('Failed to load resource:')) return;
      text('console', raw, at);
    },
    pageError(message, at) {
      text('page_error', message, at);
    },
    response({ status, durationMs, ...seen }) {
      const ms = Number.isFinite(durationMs) ? Math.max(0, Math.round(durationMs)) : undefined;
      const extra = {
        ...(Number.isInteger(status) && status >= 100 && status <= 599 ? { status } : {}),
        ...(ms !== undefined ? { durationMs: ms } : {}),
      };
      // A slow 5xx is a failed request with its duration, not two findings.
      if (status >= 400) request('request_failed', seen, extra);
      else if (ms !== undefined && ms >= slowMs) request('request_slow', seen, extra);
    },
    failed({ errorText, ...seen }) {
      // A navigation away or a cancelled load aborts what was in flight: the page's doing, not a failure of the
      // request. ponytail: Chromium's wording only; another browser's aborted request is reported as failed.
      if (errorText?.includes('net::ERR_ABORTED') === true) return;
      request('request_failed', seen, {});
    },
    result() {
      return { items: [...items], omitted };
    },
  };
}

/** A top-level declared step of the attempt, in order: its title, and the time it ran from and up to (not including). */
export interface StepSpan {
  title: string;
  start: number;
  end: number;
}

const isCount = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
const isText = (value: unknown): value is string =>
  typeof value === 'string' && value.length >= 1 && value.length <= TEXT_MAX;

/**
 * The attachment as the platform takes it, or `undefined` for what is not the attachment at all.
 *
 * The platform's objects are strict and one bad item refuses the whole batch of results, so each item is
 * built again from the keys of the contract and checked against it; one that does not pass is dropped and
 * counted, never sent. The fixture already reduced everything — this is the reporter not taking the word
 * of another process, or of another version of the fixture.
 *
 * ponytail: only top-level declared steps are matched. A finding inside a nested step is given the
 * top-level one around it; one inside a hook's or a fixture's step is given none. Walk the tree if the
 * run page ever shows nested steps.
 */
export function toWire(raw: unknown, steps: readonly StepSpan[]): ResultFindings | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { items, omitted } = raw as { items?: unknown; omitted?: unknown };
  if (!Array.isArray(items)) return undefined;

  const kept: Finding[] = [];
  let dropped = isCount(omitted, 0, OMITTED_MAX) ? omitted : 0;
  for (const item of items as unknown[]) {
    const finding = kept.length < FINDINGS_MAX ? wireItem(item, steps) : undefined;
    if (finding === undefined) dropped += 1;
    else kept.push(finding);
  }
  return { items: kept, omitted: Math.min(OMITTED_MAX, dropped) };
}

function wireItem(item: unknown, steps: readonly StepSpan[]): Finding | undefined {
  if (typeof item !== 'object' || item === null) return undefined;
  const { kind, text, method, path, status, durationMs, at } = item as Record<string, unknown>;
  if (typeof at !== 'number' || !Number.isFinite(at)) return undefined;
  // The start is in and the end is out: two steps that share a millisecond give it to the later one.
  const index = steps.findIndex((s) => s.start <= at && at < s.end);
  const title = index === -1 ? '' : clip(steps[index]!.title);
  const step = title === '' ? {} : { step: { index: index + 1, title } };

  if (kind === 'console' || kind === 'page_error') {
    return isText(text) ? { kind, text, ...step } : undefined;
  }
  if (kind !== 'request_failed' && kind !== 'request_slow') return undefined;
  if (typeof method !== 'string' || !METHOD.test(method)) return undefined;
  if (!isText(path) || !PATH.test(path)) return undefined;
  if (status !== undefined && !isCount(status, 100, 599)) return undefined;
  if (durationMs !== undefined && !isCount(durationMs, 0, Number.MAX_SAFE_INTEGER))
    return undefined;
  return {
    kind,
    method,
    path,
    ...(status !== undefined ? { status } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...step,
  };
}

/** What `watch` needs of a browser context: Playwright's `BrowserContext`, or anything that emits the same. */
export interface Watched {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- one listener shape for five event payloads
  on(event: string, listener: (arg: any) => void): unknown;
}

interface SeenRequest {
  url(): string;
  method(): string;
  timing(): { startTime: number; responseEnd: number };
  failure(): { errorText: string } | null;
}

interface SeenResponse {
  request(): SeenRequest;
  status(): number;
  finished(): Promise<unknown>;
}

/**
 * Listen to a browser context and collect what it reports. Nothing here may fail a test: every listener
 * swallows its own errors, and a context that cannot be listened to collects nothing.
 */
export function watch(
  context: Watched,
  slowMs: number,
  secrets: readonly string[] = [],
): Collector {
  const collector = createCollector(slowMs, secrets);
  /** When each request started by this process's clock: a request that never answers has an empty `timing()`. */
  const started = new WeakMap<SeenRequest, number>();
  /** A response whose body breaks off is announced twice, as a response and as a failed request. */
  const settled = new WeakSet<SeenRequest>();

  const startOf = (request: SeenRequest): number => {
    const own = request.timing().startTime;
    return own > 0 ? own : (started.get(request) ?? Date.now());
  };
  const once = (request: SeenRequest): boolean => {
    if (settled.has(request)) return false;
    settled.add(request);
    return true;
  };
  const quiet =
    <T>(listener: (arg: T) => void | Promise<void>) =>
    (arg: T): void => {
      try {
        void Promise.resolve(listener(arg)).catch(() => undefined);
      } catch {
        // a finding lost, never a test failed
      }
    };

  try {
    context.on(
      'console',
      quiet((message: { type(): string; text(): string }) => {
        if (message.type() === 'error') collector.console(message.text(), Date.now());
      }),
    );
    context.on(
      'weberror',
      quiet((webError: { error(): Error }) =>
        collector.pageError(webError.error().message, Date.now()),
      ),
    );
    context.on(
      'request',
      quiet((request: SeenRequest) => {
        started.set(request, Date.now());
      }),
    );
    context.on(
      'requestfailed',
      quiet((request: SeenRequest) => {
        if (!once(request)) return;
        const errorText = request.failure()?.errorText;
        collector.failed({
          url: request.url(),
          method: request.method(),
          at: startOf(request),
          ...(errorText !== undefined ? { errorText } : {}),
        });
      }),
    );
    context.on(
      'response',
      quiet(async (response: SeenResponse) => {
        const request = response.request();
        // The end of the response is known only once its body is in.
        // ponytail: a response still arriving when the test ends is not reported; wait at teardown if that loses findings.
        await response.finished();
        if (!once(request)) return;
        const end = request.timing().responseEnd;
        collector.response({
          url: request.url(),
          method: request.method(),
          status: response.status(),
          at: startOf(request),
          durationMs: end >= 0 ? end : Date.now() - (started.get(request) ?? Date.now()),
        });
      }),
    );
  } catch {
    // collects nothing
  }
  return collector;
}
