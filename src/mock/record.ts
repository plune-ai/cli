// A recording proxy: a local HTTP server that forwards each request to one fixed target and writes the
// answers as a stub file (version 1), so that the same requests can be answered later by the stub server
// with no network. This is the only file of the module that makes an outbound request.
//
// Where a request goes. The target is given once, as an origin. The upstream request is made of that
// origin's protocol, host and port, and of the path and query of the request target after the scope
// segment. Nothing else takes part: not the `Host` header, not `X-Forwarded-*` or `Forwarded` (they are not
// sent on), not an absolute-form request target (refused), not a redirect (an upstream 3xx is passed back
// to the client as it is, never followed, and not recorded). Like the stub server, the recorder serves
// only a request addressed to it by a loopback name and its own port, and none that a web page of another
// origin sent.
//
// What is written. For each exchange one stub with `match: exact`: the method, the path, the whole JSON
// body of the request, the status, the `content-type` and `retry-after` response headers, and the response
// body. Prompts and answers are stored as they were sent and received and may hold personal or
// confidential text. Never written: request headers, the query string, any other response header
// (`set-cookie` included), and timing.
//
// Credentials. A value is taken for a credential when the request carried it in a header or a query
// parameter whose name looks like one (the pattern of the stub server's journal), in a cookie, or in a
// field of the JSON body whose name `isSecretBodyKey` accepts, at any depth. Such a body field is stored
// with the mask for its value, which a replay reads as "any value, but there". Every credential value is
// then searched for in everything written, the path included, whatever the letter case, as it is and
// URL-encoded, JSON-escaped, in base64, base64url and hex, and each find is replaced by the mask. A stream
// whose events carry a credential in pieces, under the same key of event after event, is not recorded.
//
// Limits of the masking: a value under `MIN_SECRET_LENGTH` characters is not searched for (it would wipe
// ordinary text); a value in another form (inside a longer base64 text, compressed, hashed) is not
// found; a credential the request did not carry in one of the places above is not known to the recorder.
//
// Not recorded, passed through and warned about with the method and the status only: a body over the size
// cap, a body that is not UTF-8 text, a compressed body, a redirect, a 304. A failed upstream, one that
// cuts its answer, and one that answers with a status outside 200-599 are not recorded; the client gets a
// 502 when nothing was sent to it yet.
//
// The same request recorded several times is replayed in the order recorded; the last recording of it
// answers every later repeat (`times: always`), the earlier ones once each.

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import { parseStubFile, stubSchema, STUB_FILE_VERSION } from './schema.js';
import {
  DOT_SEGMENT,
  MASK,
  MAX_BODY_BYTES,
  NOT_LOCAL_MESSAGE,
  notLocal,
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
// A rename over a file another program has open fails on Windows; it is tried again after 20, 40, 80, 160
// and 320 ms before the write counts as failed.
const RENAME_RETRIES = 5;
const RENAME_FIRST_WAIT_MS = 20;

/** The comment lines every recording starts with, after the line with the date and the origin. */
export const RECORDING_NOTES = [
  '# Prompts and answers are stored as they were sent and received: they may hold personal or confidential text.',
  `# A credential the request carried in a header, the query, a cookie or a body field is replaced by ${MASK} wherever its value was found.`,
  `# Not found: a value under ${MIN_SECRET_LENGTH} characters, and a value in a form other than plain, URL-encoded, JSON-escaped, base64 or hex.`,
  '# Request headers, query strings and timing are not stored. Keep this file local.',
];

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
  /** Replace a file that is there, if it is a stub file or empty. */
  force?: boolean;
  /** The first path segment of every request, as on the stub server. */
  scope?: string;
  port?: number;
  maxBodyBytes?: number;
  upstreamTimeoutMs?: number;
  /** One line per exchange that was not recorded, and per write that failed. */
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
  /** Exchanges in the file. */
  readonly recorded: number;
  /** Exchanges held in memory that no write has put into the file yet. */
  readonly unwritten: number;
  /**
   * Stops listening, drops what is in flight unrecorded, and writes what is still unwritten; `unwritten`
   * says afterwards what could not be. Safe to call twice.
   */
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

// The names a field of a request body holds a credential under. Narrower than the pattern for header
// names, which would also take `max_tokens`: a name is read without its case and its separators, and is a
// secret when it is one of the first list or ends with one of the second (`api_key`, `apiKey`,
// `client_secret`, `access_token`; not `max_tokens`, `tokenizer`, `keywords`, `author`).
const SECRET_BODY_NAMES = ['key', 'auth'];
const SECRET_BODY_ENDINGS = [
  'apikey',
  'accesskey',
  'secretkey',
  'privatekey',
  'secret',
  'password',
  'passwd',
  'passphrase',
  'pwd',
  'token',
  'authorization',
  'credential',
  'credentials',
  'cookie',
  'jwt',
  'signature',
  'sessionid',
];

export function isSecretBodyKey(name: string): boolean {
  const plain = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  return SECRET_BODY_NAMES.includes(plain) || SECRET_BODY_ENDINGS.some((e) => plain.endsWith(e));
}

/** Every string under `value`, at any depth. */
function strings(value: unknown, into: string[] = []): string[] {
  if (typeof value === 'string') into.push(value);
  else if (value !== null && typeof value === 'object')
    for (const item of Object.values(value)) strings(item, into);
  return into;
}

/**
 * The request body as it is stored, and the credential values it held: a field with a secret name keeps
 * its place and gets the mask for a value.
 */
function storedBody(value: unknown, secrets: Set<string>): unknown {
  if (Array.isArray(value)) return value.map((item) => storedBody(item, secrets));
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => {
      if (!isSecretBodyKey(k)) return [k, storedBody(v, secrets)];
      for (const held of strings(v)) secrets.add(held);
      return [k, MASK];
    }),
  );
}

/**
 * One pattern for every form a credential value may take in what is written, whatever the letter case, or
 * nothing when no value is long enough to search for.
 */
function secretPattern(values: Iterable<string>): RegExp | undefined {
  // Each form as the source of a pattern.
  const forms = new Set<string>();
  const literal = (text: string): string => text.replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&');
  for (const value of values) {
    // The whole value, and its parts: `Bearer <key>`, `name=<value>; name=<value>`.
    const parts = [
      value,
      ...value.split(/[\s;,]+/).flatMap((p) => [p, p.slice(p.indexOf('=') + 1)]),
    ];
    for (const part of parts) {
      if (part.length < MIN_SECRET_LENGTH) continue;
      const bytes = Buffer.from(part);
      forms.add(literal(part));
      forms.add(literal(encodeURIComponent(part)));
      forms.add(literal(JSON.stringify(part).slice(1, -1)));
      // With its padding or without.
      forms.add(`${literal(bytes.toString('base64').replace(/=+$/, ''))}={0,2}`);
      forms.add(`${literal(bytes.toString('base64url'))}={0,2}`);
      forms.add(bytes.toString('hex'));
    }
  }
  if (forms.size === 0) return undefined;
  // The longest first: a whole header value before the key inside it.
  const sorted = [...forms].sort((a, b) => b.length - a.length);
  return new RegExp(sorted.join('|'), 'gi');
}

const maskText = (text: string, pattern: RegExp | undefined): string =>
  pattern === undefined ? text : text.replace(pattern, MASK);

/** `value` with every known credential replaced in every string, keys included. */
function maskDeep(value: unknown, pattern: RegExp | undefined): unknown {
  if (typeof value === 'string') return maskText(value, pattern);
  if (Array.isArray(value)) return value.map((item) => maskDeep(item, pattern));
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [maskText(k, pattern), maskDeep(v, pattern)]),
    );
  return value;
}

type SseChunk = string | { event?: string; data: unknown };

/**
 * Whether the events of a stream, each already masked, still hold a credential between them: the strings
 * found at the same place of event after event are joined, as a client joins the pieces of an answer.
 */
function splitOverEvents(chunks: readonly SseChunk[], pattern: RegExp | undefined): boolean {
  if (pattern === undefined) return false;
  const joined = new Map<string, string>();
  const walk = (value: unknown, at: string): void => {
    if (typeof value === 'string') joined.set(at, (joined.get(at) ?? '') + value);
    else if (value !== null && typeof value === 'object')
      for (const [k, v] of Object.entries(value)) walk(v, `${at}/${k}`);
  };
  for (const chunk of chunks) walk(typeof chunk === 'string' ? chunk : chunk.data, '');
  return [...joined.values()].some((text) => text.search(pattern) !== -1);
}

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

type BodyForm = { sse: SseChunk[] } | { json: unknown } | { text: string };

/**
 * The body in the first form of the stub format that the stub server sends back byte for byte: the chunk
 * list for an event stream, JSON, or else the text. Nothing when no form does (bytes that are not UTF-8).
 */
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
  status: number;
  /** What tells one request from another: the method, the path and the body. */
  request: string;
  /** Everything of the stub but `method` and `times`, as it came: nothing masked yet. */
  rest: {
    path: string;
    body?: unknown;
    match: 'exact';
    response: { status: number; headers: Record<string, string> } & BodyForm;
  };
  /** The lines of `rest` as they go into the file, masked with the credentials known at `maskedAt`. */
  lines?: string;
  maskedAt: number;
  onDisk: boolean;
}

const stubHead = (method: string, times: string): string =>
  `    {\n      "method": ${JSON.stringify(method)},\n      "times": "${times}",\n`;

/**
 * The lines of one stub for the file, or why it cannot be written. Fail closed: the stub goes into the
 * file only if it reads back as what was meant and holds no known credential.
 */
function stubLines(exchange: Exchange, pattern: RegExp | undefined): string | { skip: string } {
  const rest = maskDeep(exchange.rest, pattern) as Exchange['rest'];
  if ('sse' in rest.response && splitOverEvents(rest.response.sse, pattern))
    return { skip: 'a credential is split over the events of the stream' };
  // `{` of the object is replaced by the head with the method and `times`, which change after this.
  const lines = JSON.stringify(rest, null, 2).split('\n').slice(1).join('\n      ');
  const text = `${stubHead(exchange.method, 'once')}      ${lines.slice(0, -1)}    }`;
  const unsafe = { skip: 'it cannot be written safely' };
  try {
    const meant = stubSchema.safeParse({ method: exchange.method, times: 'once', ...rest });
    if (!meant.success) return unsafe;
    const read = parseStubFile(`{"version":${STUB_FILE_VERSION},"stubs":[\n${text}\n]}`).stubs[0];
    if (JSON.stringify(read) !== JSON.stringify(meant.data)) return unsafe;
  } catch {
    return unsafe;
  }
  if (pattern !== undefined && text.search(pattern) !== -1) return unsafe;
  return `      ${lines.slice(0, -1)}    }`;
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
  'origin',
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

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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

  // What is at the path now is looked at before anything is claimed, and nothing is changed yet.
  let exists = false;
  try {
    const stat = fs.statSync(file);
    exists = true;
    if (stat.isDirectory())
      throw new RecordError('The recording path is a folder: give the path of a file');
    if (options.force !== true)
      throw new RecordError(
        'The recording file exists already: give another path, or --force to replace it',
      );
    const old = fs.readFileSync(file, 'utf8');
    try {
      if (old.trim() !== '') parseStubFile(old);
    } catch {
      throw new RecordError(
        '--force replaces only a stub file or an empty file, and this file is neither: give another path',
      );
    }
  } catch (err) {
    if (err instanceof RecordError) throw err;
    if (exists) throw new RecordError('The recording file cannot be read');
  }

  let exchanges: Exchange[] = [];
  const secrets = new Set<string>();
  let pattern: RegExp | undefined;
  // Goes up with every credential value learnt: what was masked before it is masked again.
  let secretsVersion = 0;
  const inFlight = new Set<http.ClientRequest>();
  let closing: Promise<void> | undefined;
  let port = 0;

  const learn = (value: string): void => {
    if (secrets.has(value)) return;
    secrets.add(value);
    secretsVersion += 1;
    pattern = secretPattern(secrets);
  };

  /** The text of the whole file from what is in memory; what cannot be written safely is dropped. */
  const render = (): string => {
    exchanges = exchanges.filter((exchange) => {
      if (exchange.lines !== undefined && exchange.maskedAt === secretsVersion) return true;
      const lines = stubLines(exchange, pattern);
      if (typeof lines === 'string') {
        exchange.lines = lines;
        exchange.maskedAt = secretsVersion;
        return true;
      }
      warn(`not recorded: ${exchange.method} ${exchange.status} (${lines.skip})`);
      return false;
    });
    const last = new Map(exchanges.map((e, i) => [e.request, i]));
    const stubs = exchanges.map(
      (e, i) => stubHead(e.method, last.get(e.request) === i ? 'always' : 'once') + e.lines,
    );
    return [
      firstLine,
      ...RECORDING_NOTES,
      '{',
      `  "version": ${STUB_FILE_VERSION},`,
      stubs.length === 0 ? '  "stubs": []' : `  "stubs": [\n${stubs.join(',\n')}\n  ]`,
      '}',
      '',
    ].join('\n');
  };

  // A temp file with a name nobody can guess, created anew and for the owner only, then renamed over the
  // recording: a reader never sees half a file, and the recording keeps the mode of the temp file.
  // On Windows the rename fails while another program has the recording open, and a temp file whose
  // rename failed once stays refused for seconds: each try writes a temp file of its own.
  const writeAtomic = async (text: string): Promise<void> => {
    for (let attempt = 0; ; attempt += 1) {
      const temp = `${file}.${randomBytes(16).toString('hex')}.tmp`;
      try {
        await fs.promises.writeFile(temp, text, { flag: 'wx', mode: 0o600 });
        await fs.promises.rename(temp, file);
        return;
      } catch (err) {
        await fs.promises.rm(temp, { force: true }).catch(() => undefined);
        const busy = ['EPERM', 'EACCES', 'EBUSY'].includes((err as NodeJS.ErrnoException).code!);
        if (!busy || attempt >= RENAME_RETRIES) throw err;
        // Not a round number of milliseconds: a reader on a timer must not meet every try.
        await wait(RENAME_FIRST_WAIT_MS * 2 ** attempt * (0.5 + Math.random()));
      }
    }
  };

  // At most one write at a time, and each takes everything in memory: exchanges that arrive while a write
  // runs go out together with the next one. An exchange stays in memory until a write that holds it has
  // succeeded, so a failed write loses nothing: the next one carries it.
  // The file is written whole each time, which the rename needs; with thousands of large exchanges the
  // bytes written grow with the square of the count, and an append-only format would be the way out.
  let dirty = false;
  let writing: Promise<void> | undefined;
  const flush = (): Promise<void> => {
    dirty = true;
    writing ??= (async () => {
      try {
        while (dirty) {
          dirty = false;
          const text = render();
          const held = exchanges;
          try {
            await writeAtomic(text);
          } catch (err) {
            const waiting = held.filter((e) => !e.onDisk).length;
            const code = (err as NodeJS.ErrnoException).code ?? 'error';
            warn(
              `the file could not be written (${code}): ${waiting} ${waiting === 1 ? 'exchange waits' : 'exchanges wait'} in memory for the next write`,
            );
            return;
          }
          for (const exchange of held) {
            if (exchange.onDisk) continue;
            exchange.onDisk = true;
            options.onRecorded?.(exchange.method, exchange.status);
          }
        }
      } finally {
        writing = undefined;
      }
    })();
    return writing;
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
      if (SECRET_NAME.test(name)) learn(one(value));
      if (NOT_FORWARDED.has(name) || named.has(name) || name.startsWith('x-forwarded-')) continue;
      headers[name] = value;
    }
    for (const [name, value] of new URLSearchParams(query))
      if (SECRET_NAME.test(name)) learn(value);
    let stored: unknown;
    try {
      const held = new Set<string>();
      stored = storedBody(JSON.parse(body.toString('utf8')), held);
      for (const value of held) learn(value);
    } catch {
      stored = undefined;
    }
    headers['host'] = target.host;
    // The body is recorded as text, so the upstream is asked not to compress it.
    headers['accept-encoding'] = 'identity';
    if (body.length > 0 || (method !== 'GET' && method !== 'HEAD'))
      headers['content-length'] = String(body.length);

    let failed = false;
    const fail = (code: unknown): void => {
      if (failed) return;
      failed = true;
      upstream.destroy();
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
    upstream.setTimeout(timeoutMs, () => fail('ETIMEDOUT'));
    upstream.on('error', (err: NodeJS.ErrnoException) => fail(err.code));
    // An answer that is not a final one: a 1xx with nothing after it would hold the client for good, and a
    // 101 hands over a connection this proxy has no use for.
    upstream.on('information', () => fail('BAD_STATUS'));
    upstream.on('upgrade', (_up, socket) => {
      socket.destroy();
      fail('BAD_STATUS');
    });
    res.on('close', () => {
      if (!res.writableFinished) upstream.destroy();
    });
    upstream.on('response', (up) => {
      const status = up.statusCode ?? 0;
      if (status < 200 || status > 599) {
        up.resume();
        fail('BAD_STATUS');
        return;
      }
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
      up.on('error', () => fail(undefined));
      up.on('aborted', () => fail(undefined));
      up.on('end', () => {
        // A body with no declared length ends when the target closes; one the target cut with a reset
        // ends here too, incomplete.
        if (failed || !up.complete) {
          fail(undefined);
          return;
        }
        res.end();
        const skip = (why: string): void => warn(`not recorded: ${method} ${status} (${why})`);
        if (status === 304) return skip('a 304 has no body to replay');
        if (status >= 300 && status < 400) return skip('a redirect is passed back, not followed');
        if (size > cap) return skip(`the body is over ${cap} bytes`);
        if (!/^(identity)?$/i.test(one(up.headers['content-encoding']).trim()))
          return skip('the body is compressed');
        const form = bodyForm(Buffer.concat(chunks), one(up.headers['content-type']));
        if (form === undefined) return skip('the body is not UTF-8 text');
        const kept: Record<string, string> = {};
        for (const name of RECORDED_RESPONSE_HEADERS) {
          const value = one(up.headers[name]);
          if (value !== '') kept[name] = value;
        }
        exchanges.push({
          method,
          status,
          request: JSON.stringify([method, stubPath, stored]),
          rest: {
            path: stubPath,
            ...(stored === undefined ? {} : { body: stored }),
            match: 'exact',
            response: { status, headers: kept, ...form },
          },
          maskedAt: -1,
          onDisk: false,
        });
        void flush();
      });
    });
    upstream.end(body);
  }

  const server = http.createServer((req, res) => {
    const method = req.method ?? 'GET';
    if (notLocal(req, port)) {
      req.resume();
      refuse(res, 403, 'mock_not_local', NOT_LOCAL_MESSAGE, method);
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('error', () => undefined);
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) chunks.push(chunk);
      else chunks.length = 0;
    });
    req.on('end', () => {
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

  // The port is claimed before the file is touched: a recorder that cannot start changes nothing.
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
    throw new RecordError(
      `Cannot listen on 127.0.0.1: ${(err as NodeJS.ErrnoException).code ?? 'error'}`,
    );
  }
  ({ port } = server.address() as AddressInfo);

  // An empty stub file: over the old one when that was asked for, otherwise only if nothing is there.
  try {
    if (exists) await writeAtomic(render());
    else await fs.promises.writeFile(file, render(), { flag: 'wx', mode: 0o600 });
  } catch (err) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new RecordError(
      (err as NodeJS.ErrnoException).code === 'EEXIST'
        ? 'The recording file exists already: give another path, or --force to replace it'
        : 'The recording file cannot be created',
    );
  }

  return {
    url: `http://127.0.0.1:${port}/${scope}`,
    port,
    file,
    get recorded() {
      return exchanges.filter((e) => e.onDisk).length;
    },
    get unwritten() {
      return exchanges.filter((e) => !e.onDisk).length;
    },
    close() {
      closing ??= (async () => {
        const closed = new Promise<void>((resolve) => server.close(() => resolve()));
        for (const upstream of inFlight) upstream.destroy();
        server.closeAllConnections();
        await closed;
        await writing;
        // What a failed write left in memory gets one more write.
        if (exchanges.some((e) => !e.onDisk)) await flush();
      })();
      return closing;
    },
  };
}
