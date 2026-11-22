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

/** At most 300, and not half of a character pair at the cut. */
function clip(text: string): string {
  const cut = text.slice(0, TEXT_MAX);
  return /[\ud800-\udbff]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/** Where an address written into a text ends: a space, a quote or an angle bracket. */
const END = String.raw`\s"'\x60<>`;
/** `scheme://`, a user and password, the host and path, then the query and fragment. */
const ABSOLUTE = new RegExp(
  String.raw`\b((?:https?|wss?):\/\/)(?:[^${END}/?#@]*@)?([^${END}?#]*)(?:[?#][^${END}]*)?`,
  'gi',
);
/** A path written without its host, with a query: `/api/cart?id=5`. Only where a word starts, so `and/or?` stays. */
const RELATIVE = new RegExp(String.raw`(^|[\s"'\x60<>(\[{=:,;])(\/[^${END}?#]*)\?[^${END}]*`, 'g');

/**
 * An address inside a text keeps its host and path and loses the rest: a query string and a fragment are
 * removed, not masked, as they are from a request's own address, and so are a user and password.
 *
 * ponytail: found by its shape. Everything from the `?` or `#` to the next space, quote or angle bracket goes,
 * the punctuation after an address with it (`…/a?x=1).` loses `).`); a query written after a space, or an
 * address with no scheme and no leading slash (`api.x/y?id=5`), is not seen. Parse the text if that matters.
 */
function withoutQueries(text: string): string {
  return text.replace(ABSOLUTE, '$1$2').replace(RELATIVE, '$1$2');
}

/** Addresses cut and credentials masked first, clipped after: a clip before could halve what they would then not recognise. */
function cleaned(raw: string): string {
  const flat = stripVTControlCharacters(raw).replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ');
  return clip(maskCredentials(withoutQueries(flat)).trim());
}

export function createCollector(slowMs: number): Collector {
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
    const clean = cleaned(String(raw));
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
    const path = maskCredentials(parsed.pathname);
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
export function watch(context: Watched, slowMs: number): Collector {
  const collector = createCollector(slowMs);
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
