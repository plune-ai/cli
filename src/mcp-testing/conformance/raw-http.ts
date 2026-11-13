/**
 * Raw HTTP for the Streamable HTTP checks: one request as written (method, headers in the order and case given, body)
 * and the answer as it came (status, headers, the body's bytes and its SSE events with their id and retry, the time).
 * No MCP client stands between: a client library would normalise a status, drop a header or accept an empty body,
 * and hide the very thing a check looks for.
 *
 * Every request goes to the URL under test and nowhere else: through the session's `fetchForOrigin`, which adds the
 * `--header` values (Authorization among them) only for that origin and follows no redirect. A request that sets
 * `Host` goes through `node:http` instead, to the same address, because `fetch` replaces any `Host` it is given.
 * What is written down of an exchange (`Exchange`) has secret headers masked and every value through the redactor.
 */

import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import { ConnectError } from '../connect/session.js';
import { isSecretHeader, MASK, maskUrl, type Redactor } from '../connect/redact.js';

/** The target under test, over Streamable HTTP. */
export interface HttpTarget {
  url: string;
  /** The session's fetch for the target's origin: `--header` values added, no redirect followed. */
  fetch: (input: string | URL, init?: RequestInit) => Promise<Response>;
  /** The `--header` values, for the one path that cannot use `fetch` (a `Host` of its own). */
  headers: Record<string, string>;
  redact: Redactor;
}

export type HeaderList = [string, string][];

export interface RawRequest {
  method: string;
  headers: HeaderList;
  body?: string;
}

export interface SseEvent {
  id?: string;
  event?: string;
  retry?: number;
  data: string;
}

export interface RawResponse {
  status: number;
  headers: HeaderList;
  /** The body as text, cut to MAX_BYTES; bytes that are not UTF-8 read as U+FFFD. */
  body: string;
  /** The body is valid UTF-8 (as far as it was read). */
  utf8: boolean;
  /** The SSE events, when the answer is `text/event-stream`. */
  events: SseEvent[];
  /** The body ended (the server closed it) before a limit or `stopWhen` stopped the reading. */
  ended: boolean;
  ms: number;
}

export interface Limits {
  /** The most the whole exchange may take; reaching it stops the reading (the body so far is kept). */
  timeoutMs?: number;
  maxBytes?: number;
  maxEvents?: number;
  /** Stop once an event matches, waiting at most `lingerMs` more for the body to end. */
  stopWhen?: (e: SseEvent) => boolean;
  lingerMs?: number;
  /** Stop as soon as the status and headers are in. */
  headersOnly?: boolean;
  /** Called once the status and headers are in. */
  onOpen?: () => void;
  /** Stops the reading early, as the time limit does. */
  signal?: AbortSignal;
}

/** The SSE reads of these checks are short: 5 s a stream, then the reading stops. */
export const STREAM_MS = 5000;
export const MAX_BYTES = 1024 * 1024;
export const MAX_EVENTS = 100;
/** What an exchange keeps of a body for the report. */
const BODY_TEXT = 2000;

/** One SSE event block (the lines between blank lines); undefined for a block with no field (a comment). */
function eventOf(block: string): SseEvent | undefined {
  const e: SseEvent = { data: '' };
  const data: string[] = [];
  let any = false;
  for (const line of block.split(/\r\n|\r|\n/)) {
    if (line === '' || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
    any = true;
    if (field === 'data') data.push(value);
    else if (field === 'id') e.id = value;
    else if (field === 'event') e.event = value;
    else if (field === 'retry' && /^\d+$/.test(value)) e.retry = Number(value);
  }
  if (!any) return undefined;
  e.data = data.join('\n');
  return e;
}

/** A fetch to the same address with a `Host` of its own, through node:http; no redirect is followed here either. */
function hostFetch(target: HttpTarget, req: RawRequest, signal: AbortSignal): Promise<Response> {
  const url = new URL(target.url);
  const given = new Set(req.headers.map(([n]) => n.toLowerCase()));
  // The --header values first, unless the request names the same header; then the request's own, as written.
  const headers: string[] = [];
  for (const [n, v] of Object.entries(target.headers)) if (!given.has(n.toLowerCase())) headers.push(n, v);
  for (const [n, v] of req.headers) headers.push(n, v);
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const r = send(url, { method: req.method, headers, signal }, (res) => {
      const pairs: HeaderList = [];
      for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) pairs.push([res.rawHeaders[i]!, res.rawHeaders[i + 1]!]);
      const nobody = res.statusCode === 204 || res.statusCode === 304;
      resolve(
        new Response(nobody ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>), {
          status: res.statusCode ?? 0,
          headers: pairs,
        }),
      );
    });
    r.on('error', reject);
    r.end(req.body);
  });
}

/**
 * One request to the target and its answer, read within the limits. Rejects with a `ConnectError` only when no answer
 * came: `timeout` when the status did not arrive in time, `network` when the server could not be reached. Its message
 * is masked.
 */
export async function rawRequest(target: HttpTarget, req: RawRequest, limits: Limits = {}): Promise<RawResponse> {
  const timeoutMs = limits.timeoutMs ?? STREAM_MS;
  const maxBytes = limits.maxBytes ?? MAX_BYTES;
  const maxEvents = limits.maxEvents ?? MAX_EVENTS;
  const started = performance.now();
  const abort = new AbortController();
  let timer = setTimeout(() => abort.abort(), timeoutMs);
  limits.signal?.addEventListener('abort', () => abort.abort(), { once: true });
  const ownHost = req.headers.some(([n]) => n.toLowerCase() === 'host');
  let res: Response;
  try {
    res = ownHost
      ? await hostFetch(target, req, abort.signal)
      : await target.fetch(target.url, {
          method: req.method,
          headers: req.headers,
          ...(req.body === undefined ? {} : { body: req.body }),
          redirect: 'manual',
          signal: abort.signal,
        });
  } catch (err) {
    clearTimeout(timer);
    if (abort.signal.aborted)
      throw new ConnectError('timeout', `No answer to ${req.method} within ${timeoutMs / 1000} s.`, []);
    const message = err instanceof Error ? err.message : String(err);
    throw new ConnectError('network', `Could not reach the server: ${target.redact.text(message)}`, []);
  }
  limits.onOpen?.();
  const sse = (res.headers.get('content-type') ?? '').toLowerCase().includes('text/event-stream');
  const chunks: Uint8Array[] = [];
  const events: SseEvent[] = [];
  let bytes = 0;
  let ended = false;
  let pending = '';
  const decoder = new TextDecoder();
  if (res.body !== null && limits.headersOnly !== true) {
    const reader = res.body.getReader();
    try {
      read: for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          ended = true;
          break;
        }
        chunks.push(value);
        bytes += value.length;
        if (sse) {
          pending += decoder.decode(value, { stream: true });
          const blocks = pending.split(/\r\n\r\n|\n\n|\r\r/);
          pending = blocks.pop() ?? '';
          for (const block of blocks) {
            const e = eventOf(block);
            if (e === undefined) continue;
            events.push(e);
            if (events.length >= maxEvents) break read;
            if (limits.stopWhen?.(e) === true) {
              if ((limits.lingerMs ?? 0) <= 0) break read;
              clearTimeout(timer);
              timer = setTimeout(() => abort.abort(), limits.lingerMs);
            }
          }
        }
        if (bytes >= maxBytes) break;
      }
    } catch {
      // The time ran out while the body was read: what came so far stands.
    }
    await reader.cancel().catch(() => {});
  } else await res.body?.cancel().catch(() => {});
  clearTimeout(timer);
  const all = Buffer.concat(chunks).subarray(0, maxBytes);
  let utf8 = true;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(all);
  } catch {
    utf8 = false;
  }
  return {
    status: res.status,
    headers: [...res.headers],
    body: new TextDecoder().decode(all),
    utf8,
    events,
    ended,
    ms: Math.round(performance.now() - started),
  };
}

/**
 * One request and its answer as a report keeps them: the request's headers and then the `--header` values it did not
 * name (as sent), secret headers masked, every value through the redactor.
 */
export interface Exchange {
  request: { method: string; url: string; headers: HeaderList; body?: string };
  response?: { status: number; headers: HeaderList; body: string; events: number; ms: number };
}

export function exchange(target: HttpTarget, req: RawRequest, res?: RawResponse): Exchange {
  const r = target.redact;
  const headers = (list: HeaderList): HeaderList =>
    list.map(([n, v]) => [n, isSecretHeader(n) ? MASK : r.text(v)]);
  // Masked whole, then cut: a secret that straddles the cut would otherwise be left in part.
  const text = (t: string) => {
    const masked = r.text(t);
    return masked.length <= BODY_TEXT ? masked : `${masked.slice(0, BODY_TEXT)}… (cut: ${t.length} characters)`;
  };
  return {
    request: {
      method: req.method,
      url: r.text(maskUrl(target.url)),
      headers: headers([
        ...req.headers,
        ...Object.entries(target.headers).filter(([n]) => !req.headers.some(([g]) => g.toLowerCase() === n.toLowerCase())),
      ]),
      ...(req.body === undefined ? {} : { body: text(req.body) }),
    },
    ...(res === undefined
      ? {}
      : {
          response: {
            status: res.status,
            headers: headers(res.headers),
            body: text(res.body),
            events: res.events.length,
            ms: res.ms,
          },
        }),
  };
}

/** The header's value, by name in any case; undefined when absent. */
export const header = (headers: HeaderList, name: string): string | undefined =>
  headers.find(([n]) => n.toLowerCase() === name.toLowerCase())?.[1];

/** Loopback names: `localhost`, `127.0.0.1`, `[::1]` and any `*.localhost`. Any other host is not local. */
export function isLocal(url: string): boolean {
  const host = new URL(url).hostname.toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost');
}
