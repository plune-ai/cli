// A recording proxy: a local HTTP server that forwards each request to one fixed target and writes the
// answers as a stub file (version 1), so that the same requests can be answered later by the stub server
// with no network. This is the only file of the module that makes an outbound request.
//
// Where a request goes. The target is given once, as an origin. The upstream request is made of that
// origin's protocol, host and port, and of the path and query of the request target after the scope
// segment. Nothing else takes part: not the `Host` header, not `X-Forwarded-*` or `Forwarded` (they are not
// sent on), not an absolute-form request target (refused), not a redirect (an upstream 3xx is passed back
// to the client as it is, never followed, and not recorded).
//
// What is written. For each exchange: the method, the path, the request body as the JSON subset a replay
// matches on, the status, the `content-type` and `retry-after` response headers, and the response body.
// Prompts and answers are stored as they were sent and received and may hold personal or confidential
// text. Never written: request headers, the query string, any other response header (`set-cookie`
// included), keys of the request body whose name looks like a credential (left out with their values, so
// a replay matches whatever they hold), and timing. Every value that came in a credential-looking request
// header or query parameter is known by value, and is replaced wherever it shows up in what is written:
// by the mask in a body or a header, by `*` in a path.
//
// Limits of the masking: a value under `MIN_SECRET_LENGTH` characters is not searched for (it would wipe
// ordinary text); a value an upstream sends back split over several stream events or re-encoded (base64,
// for one) is not found; a credential the tool never saw in a header or the query is not known to it.
//
// Not recorded, passed through and warned about with the method and the status only: a body over the size
// cap, a body that is not UTF-8 text, a compressed body, a redirect. A failed upstream is answered with a
// 502 and not recorded.
//
// The same request recorded several times is replayed in the order recorded; the last recording of it
// answers every later repeat (`times: always`), the earlier ones once each. A stub with a smaller body
// subset also matches a larger request, as in any stub file: replay the requests in the order recorded.

import * as fs from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import { parseStubFile, stubFileSchema, STUB_FILE_VERSION, type StubInput } from './schema.js';
import {
  DOT_SEGMENT,
  MASK,
  MAX_BODY_BYTES,
  renderBody,
  SCOPE_NAME,
  SECRET_NAME,
} from './server.js';

/** A known credential shorter than this is not searched for in what is written. */
export const MIN_SECRET_LENGTH = 8;
/** A response body over this is passed through and not recorded. */
export const RECORD_BODY_CAP = 8 * 1024 * 1024;
/** The response headers a recording keeps; a replay needs no other. */
export const RECORDED_RESPONSE_HEADERS = ['content-type', 'retry-after'] as const;

const DEFAULT_UPSTREAM_TIMEOUT_MS = 10 * 60 * 1000;

/** What the user gave is wrong: a bad target, a path outside the project, a file that exists. */
export class RecordError extends Error {
  readonly code = 'MOCK_RECORD_ERROR' as const;
  constructor(message: string) {
    super(message);
    this.name = 'RecordError';
  }
}

/** The one function that opens a connection out of this process. */
export type Outbound = (options: https.RequestOptions) => http.ClientRequest;
const realOutbound: Outbound = (options) =>
  (options.protocol === 'https:' ? https : http).request(options);

export interface RecordOptions {
  /** An origin: `http://host[:port]` or `https://host[:port]`, nothing after it. */
  target: string;
  /** Where the stub file goes, resolved against `cwd`; it must stay inside `cwd`. */
  file: string;
  cwd?: string;
  /** Replace a file that is there. */
  force?: boolean;
  /** The first path segment of every request, as on the stub server. */
  scope?: string;
  port?: number;
  maxBodyBytes?: number;
  upstreamTimeoutMs?: number;
  /** One line per exchange that was not recorded: the method, the status and why. */
  warn?: (line: string) => void;
  /** Called after an exchange is in the file, with the method and the status. */
  onRecorded?: (method: string, status: number) => void;
  outbound?: Outbound;
  /** `YYYY-MM-DD` for the file's first line. */
  today?: () => string;
}

export interface Recorder {
  readonly url: string;
  readonly port: number;
  /** The file being written, absolute. */
  readonly file: string;
  /** Exchanges in the file so far. */
  readonly recorded: number;
  /** Stops listening, drops what is in flight unrecorded, waits for the file. Safe to call twice. */
  close(): Promise<void>;
}

/** The target as a URL, or a `RecordError` that repeats nothing of it. */
export function parseTarget(target: string): URL {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    throw new RecordError('--target is not a URL: give an origin such as https://api.example.com');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new RecordError('--target must be an http: or https: URL');
  if (url.username !== '' || url.password !== '')
    throw new RecordError('--target must hold no user name or password');
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '')
    throw new RecordError(
      '--target is an origin, with no path or query: put the path into the base URL of the client, after the scope',
    );
  return url;
}

/** `file` as an absolute path, refused unless its folder is `cwd` or under it once links are resolved. */
export function resolveInside(cwd: string, file: string): string {
  const outside = new RecordError(
    'The recording is written inside the current project folder only: give a path under it, in a folder that exists',
  );
  let root: string;
  let dir: string;
  const abs = path.resolve(cwd, file);
  try {
    root = fs.realpathSync.native(cwd);
    dir = fs.realpathSync.native(path.dirname(abs));
  } catch {
    throw outside;
  }
  const rel = path.relative(root, dir);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw outside;
  return path.join(dir, path.basename(abs));
}

/** Every form a credential value may take in what is written, the longest first. */
function secretForms(values: Iterable<string>): string[] {
  const forms = new Set<string>();
  for (const value of values) {
    // The whole value, and its parts: `Bearer <key>`, `name=<value>; name=<value>`.
    const parts = [
      value,
      ...value.split(/[\s;,]+/).flatMap((p) => [p, p.slice(p.indexOf('=') + 1)]),
    ];
    for (const part of parts) {
      if (part.length < MIN_SECRET_LENGTH) continue;
      forms.add(part);
      forms.add(encodeURIComponent(part));
      forms.add(JSON.stringify(part).slice(1, -1));
    }
  }
  return [...forms].sort((a, b) => b.length - a.length);
}

function replaceForms(text: string, forms: readonly string[], by: string): string {
  let out = text;
  for (const form of forms) out = out.split(form).join(by);
  return out;
}

/** `value` with every known credential replaced in every string, keys included. */
function maskDeep(value: unknown, forms: readonly string[]): unknown {
  if (typeof value === 'string') return replaceForms(value, forms, MASK);
  if (Array.isArray(value)) return value.map((item) => maskDeep(item, forms));
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [replaceForms(k, forms, MASK), maskDeep(v, forms)]),
    );
  return value;
}

/** A request body without the keys whose name looks like a credential, at any depth. */
function withoutSecretKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutSecretKeys);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => !SECRET_NAME.test(k))
        .map(([k, v]) => [k, withoutSecretKeys(v)]),
    );
  return value;
}

type SseChunk = string | { event?: string; data: unknown };

/** An event stream as the chunk list of the stub format, or nothing when it holds more than that format. */
function parseSse(text: string): SseChunk[] | undefined {
  if (!text.endsWith('\n\n')) return undefined;
  const chunks: SseChunk[] = [];
  for (const block of text.slice(0, -2).split('\n\n')) {
    const found = /^(?:event: ([^\n]+)\n)?data: ([^\n]*)$/.exec(block);
    if (found === null) return undefined;
    const [, event, line = ''] = found;
    let data: unknown = line;
    try {
      const parsed: unknown = JSON.parse(line);
      // Kept as JSON only where it is sent back the same, byte for byte.
      if (typeof parsed !== 'string' && JSON.stringify(parsed) === line) data = parsed;
    } catch {
      // Not JSON (`[DONE]`): the line as written.
    }
    chunks.push(
      event === undefined && typeof data === 'string'
        ? data
        : { ...(event === undefined ? {} : { event }), data },
    );
  }
  return chunks;
}

/**
 * The body in the first form of the stub format that the stub server sends back byte for byte: the chunk
 * list for an event stream, JSON, or else the text. Nothing when no form does (bytes that are not UTF-8).
 */
type BodyForm = { sse: SseChunk[] } | { json: unknown } | { text: string };

function bodyForm(body: Buffer, contentType: string): BodyForm | undefined {
  const text = body.toString('utf8');
  const forms: BodyForm[] = [];
  if (/^text\/event-stream/i.test(contentType)) {
    const sse = parseSse(text);
    if (sse !== undefined) forms.push({ sse });
  }
  try {
    forms.push({ json: JSON.parse(text) as unknown });
  } catch {
    // Not JSON: the text form below.
  }
  forms.push({ text });
  return forms.find((form) => renderBody({ status: 200, headers: {}, ...form }).body.equals(body));
}

interface Exchange {
  method: string;
  path: string;
  body?: unknown;
  response: NonNullable<StubInput['response']>;
}

const sameRequest = (e: Exchange): string => JSON.stringify([e.method, e.path, e.body]);

/** The text of the stub file for these exchanges, or nothing when it cannot be written safely. */
function renderFile(
  exchanges: readonly Exchange[],
  forms: readonly string[],
  firstLine: string,
): string | undefined {
  const last = new Map(exchanges.map((e, i) => [sameRequest(e), i]));
  const stubs = exchanges.map((e, i) => ({
    method: e.method,
    path: replaceForms(e.path, forms, '*'),
    ...(e.body === undefined ? {} : { body: maskDeep(e.body, forms) }),
    times: last.get(sameRequest(e)) === i ? ('always' as const) : ('once' as const),
    response: maskDeep(e.response, forms) as Exchange['response'],
  }));
  const file = { version: STUB_FILE_VERSION, stubs };
  const text = [
    firstLine,
    '# Prompts and answers are stored as they were sent and received: they may hold personal or confidential text.',
    `# Credentials are replaced by ${MASK}; request headers, query strings and timing are not stored. Keep this file local.`,
    JSON.stringify(file, null, 2),
    '',
  ].join('\n');
  // Fail closed: the file is written only if it reads back as what was meant and holds no known credential.
  try {
    const expected = stubFileSchema.safeParse(file);
    if (!expected.success) return undefined;
    if (JSON.stringify(parseStubFile(text)) !== JSON.stringify(expected.data)) return undefined;
  } catch {
    return undefined;
  }
  return forms.some((form) => text.includes(form)) ? undefined : text;
}

// Hop-by-hop headers, and the ones this proxy sets itself or never passes on.
const NOT_FORWARDED = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
  'accept-encoding',
  'expect',
  'forwarded',
]);
const NOT_PASSED_BACK = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-connection',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const one = (value: string | string[] | undefined): string =>
  value === undefined ? '' : Array.isArray(value) ? value.join(', ') : value;

export async function startRecorder(options: RecordOptions): Promise<Recorder> {
  const target = parseTarget(options.target);
  const scope = options.scope ?? 'default';
  if (!SCOPE_NAME.test(scope))
    throw new RecordError(
      'Bad --scope: letters, digits, ".", "_" and "-" only, and not "." or ".."',
    );
  const file = resolveInside(options.cwd ?? process.cwd(), options.file);
  const cap = options.maxBodyBytes ?? RECORD_BODY_CAP;
  const timeoutMs = options.upstreamTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS;
  const outbound = options.outbound ?? realOutbound;
  const warn = options.warn ?? (() => undefined);
  const today = (options.today ?? (() => new Date().toISOString().slice(0, 10)))();
  const firstLine = `# Recorded by \`plune mock --record\` on ${today} from ${target.origin}`;

  const exchanges: Exchange[] = [];
  const secrets = new Set<string>();
  const inFlight = new Set<http.ClientRequest>();
  let closing: Promise<void> | undefined;

  // Temp file then rename, so a reader never sees half a file. One write at a time, in order.
  const temp = `${file}.${process.pid}.tmp`;
  const writeAtomic = async (text: string): Promise<void> => {
    try {
      await fs.promises.writeFile(temp, text);
      await fs.promises.rename(temp, file);
    } catch (err) {
      await fs.promises.rm(temp, { force: true });
      throw err;
    }
  };
  let writes: Promise<void> = Promise.resolve();
  let written = 0;

  // The file is claimed before the port is: an empty stub file, created only if nothing is there.
  const empty = renderFile([], [], firstLine) ?? '';
  if (options.force === true) await writeAtomic(empty);
  else {
    try {
      await fs.promises.writeFile(file, empty, { flag: 'wx' });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST')
        throw new RecordError(
          'The recording file exists already: give another path, or --force to replace it',
        );
      throw new RecordError('The recording file cannot be created');
    }
  }

  // The whole file is rewritten after each exchange, so a kill loses nothing and stopping has
  // nothing left to flush. Append-only writing if a recording ever grows past a few thousand exchanges.
  const store = (exchange: Exchange, status: number): void => {
    writes = writes.then(async () => {
      exchanges.push(exchange);
      const text = renderFile(exchanges, secretForms(secrets), firstLine);
      if (text === undefined) {
        exchanges.pop();
        warn(`not recorded: ${exchange.method} ${status} (it cannot be written safely)`);
        return;
      }
      try {
        await writeAtomic(text);
        written = exchanges.length;
        options.onRecorded?.(exchange.method, status);
      } catch {
        exchanges.pop();
        warn(`not recorded: ${exchange.method} ${status} (the file cannot be written)`);
      }
    });
  };

  const refuse = (
    res: http.ServerResponse,
    status: number,
    type: string,
    message: string,
    method: string,
  ): void => {
    const text = JSON.stringify({ error: { type, message, method } });
    res.writeHead(status, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(text),
    });
    res.end(text);
  };

  function forward(req: http.IncomingMessage, res: http.ServerResponse, body: Buffer): void {
    const method = req.method ?? 'GET';
    // Taken apart by hand and as written, like the stub server: only an origin-form target that starts
    // with the scope goes on, and only its path and query.
    const requestTarget = req.url ?? '';
    const queryAt = requestTarget.indexOf('?');
    const rawPath = queryAt === -1 ? requestTarget : requestTarget.slice(0, queryAt);
    const segments = rawPath.split('/');
    if (segments[0] !== '' || segments[1] !== scope || segments.some((s) => DOT_SEGMENT.test(s))) {
      refuse(
        res,
        400,
        'mock_bad_target',
        `Bad request target: it starts with "/${scope}" and holds no "." or ".." segment`,
        method,
      );
      return;
    }
    const stubPath = rawPath.slice(scope.length + 1) || '/';
    const query = queryAt === -1 ? '' : requestTarget.slice(queryAt + 1);

    const headers: Record<string, string | string[]> = {};
    const named = new Set(
      one(req.headers.connection)
        .toLowerCase()
        .split(/[\s,]+/),
    );
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      if (SECRET_NAME.test(name)) secrets.add(one(value));
      if (NOT_FORWARDED.has(name) || named.has(name) || name.startsWith('x-forwarded-')) continue;
      headers[name] = value;
    }
    for (const [name, value] of new URLSearchParams(query))
      if (SECRET_NAME.test(name)) secrets.add(value);
    headers['host'] = target.host;
    // The body is recorded as text, so the upstream is asked not to compress it.
    headers['accept-encoding'] = 'identity';
    if (body.length > 0 || (method !== 'GET' && method !== 'HEAD'))
      headers['content-length'] = String(body.length);

    const fail = (code: unknown): void => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const reason = typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? code : 'no answer';
      refuse(
        res,
        502,
        'mock_upstream_failed',
        `The target did not answer this ${method} request (${reason}); nothing was recorded`,
        method,
      );
    };

    let upstream: http.ClientRequest;
    try {
      upstream = outbound({
        protocol: target.protocol,
        hostname: target.hostname.replace(/^\[|\]$/g, ''),
        port: target.port === '' ? (target.protocol === 'https:' ? 443 : 80) : Number(target.port),
        method,
        path: stubPath + (queryAt === -1 ? '' : `?${query}`),
        headers,
        // A connection of its own, closed after the answer: nothing stays open when the recorder stops.
        agent: false,
      });
    } catch {
      refuse(res, 400, 'mock_bad_target', 'Bad request target: it cannot be sent on', method);
      return;
    }
    inFlight.add(upstream);
    upstream.on('close', () => inFlight.delete(upstream));
    upstream.setTimeout(timeoutMs, () =>
      upstream.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })),
    );
    upstream.on('error', (err: NodeJS.ErrnoException) => fail(err.code));
    res.on('close', () => {
      if (!res.writableFinished) upstream.destroy();
    });
    upstream.on('response', (up) => {
      const status = up.statusCode ?? 502;
      const passed: string[] = [];
      for (let i = 0; i + 1 < up.rawHeaders.length; i += 2)
        if (!NOT_PASSED_BACK.has(up.rawHeaders[i]!.toLowerCase()))
          passed.push(up.rawHeaders[i]!, up.rawHeaders[i + 1]!);
      res.writeHead(status, passed);
      res.flushHeaders();
      const chunks: Buffer[] = [];
      let size = 0;
      // No backpressure, the client is a local test run. Pipe if a slow client ever matters.
      up.on('data', (chunk: Buffer) => {
        res.write(chunk);
        size += chunk.length;
        if (size <= cap) chunks.push(chunk);
        else chunks.length = 0;
      });
      up.on('error', () => res.destroy());
      up.on('end', () => {
        res.end();
        const skip = (why: string): void => warn(`not recorded: ${method} ${status} (${why})`);
        if (status >= 300 && status < 400) return skip('a redirect is passed back, not followed');
        if (size > cap) return skip(`the body is over ${cap} bytes`);
        if (!/^(identity)?$/i.test(one(up.headers['content-encoding']).trim()))
          return skip('the body is compressed');
        const contentType = one(up.headers['content-type']);
        const form = bodyForm(Buffer.concat(chunks), contentType);
        if (form === undefined) return skip('the body is not UTF-8 text');
        const kept: Record<string, string> = {};
        for (const name of RECORDED_RESPONSE_HEADERS) {
          const value = one(up.headers[name]);
          if (value !== '') kept[name] = value;
        }
        let subset: unknown;
        try {
          subset = withoutSecretKeys(JSON.parse(body.toString('utf8')));
        } catch {
          subset = undefined;
        }
        store(
          {
            method,
            path: stubPath,
            ...(subset === undefined ? {} : { body: subset }),
            response: { status, headers: kept, ...form },
          },
          status,
        );
      });
    });
    upstream.end(body);
  }

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('error', () => undefined);
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) chunks.push(chunk);
      else chunks.length = 0;
    });
    req.on('end', () => {
      const method = req.method ?? 'GET';
      if (size > MAX_BODY_BYTES) {
        refuse(res, 413, 'mock_body_too_large', 'Request body over 16 MiB', method);
        return;
      }
      try {
        forward(req, res, Buffer.concat(chunks));
      } catch {
        if (res.headersSent) res.destroy();
        else refuse(res, 500, 'mock_internal', 'The recorder failed on this request', method);
      }
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      // Loopback only, always: a recorder open to the network would forward anyone's request.
      server.listen(options.port ?? 0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (err) {
    // The empty file claimed above goes with the recorder that never started; a replaced one stays.
    if (options.force !== true) await fs.promises.rm(file, { force: true });
    throw new RecordError(
      `Cannot listen on 127.0.0.1: ${(err as NodeJS.ErrnoException).code ?? 'error'}`,
    );
  }
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/${scope}`,
    port,
    file,
    get recorded() {
      return written;
    },
    close() {
      closing ??= (async () => {
        const closed = new Promise<void>((resolve) => server.close(() => resolve()));
        for (const upstream of inFlight) upstream.destroy();
        server.closeAllConnections();
        await closed;
        await writes;
      })();
      return closing;
    },
  };
}
