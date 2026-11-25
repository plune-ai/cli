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
// Credentials, two rules and no more.
//
// 1. By name. A field of a JSON body whose name `isSecretBodyKey` accepts is written with the mask in
//    place of its value: in a request whatever the value is, which a replay reads as "any value, but
//    there"; in an answer only when the value is a string that rule 2 searches for from a body field.
// 2. By value. A value is searched for in every string that is written, the path included, when it
//    looks like a credential: it came in a header, a query parameter or a cookie with a secret-looking
//    name, or as the password of Basic authorization, and has `MIN_SECRET_LENGTH` characters or more; or
//    it came in a secret-named field of a JSON or form-encoded body, of the request or of the answer, and
//    has `MIN_BODY_SECRET_LENGTH` or more with no whitespace. Either way it holds a character that is not
//    a letter. The search is a plain text search, with the case of Latin letters ignored, for the value
//    as it is, URL-encoded, JSON-escaped, in base64, base64url and hex; of a value over
//    `MAX_SECRET_LENGTH` its start of that length is searched for, and a find takes the text up to the
//    next whitespace with it. Object keys are never rewritten: a stub that would hold a searched value in a key, or anywhere
//    after the masking, is not written.
//
// An answer that comes in pieces (the events of a stream, lines of JSON, text with lines) is also read
// joined: the payloads one after another, the strings inside their JSON one after another, and the strings
// found under the same key of piece after piece. A searched value found in one of those, across pieces, is
// not something a replacement can remove, so that exchange is not recorded.
//
// What this does not find: a value that fails the rules above (short, letters only, with whitespace in a
// body field); a value in another form (inside a longer base64 text, compressed, hashed); a credential
// the request carried somewhere else, such as a path segment or a body field with another name; a secret
// the answer holds under a name that is not a secret's.
//
// Not recorded, passed through and warned about with the method and the status only: a body over the size
// cap, a body that is not UTF-8 text, a compressed body, a redirect, a 304. A failed upstream, one that
// cuts its answer, and one that answers with a status outside 200-599 are not recorded; the client gets a
// 502 when nothing was sent to it yet. A 1xx is waited through: the final answer after it is the answer,
// and with none the timeout ends the request.
//
// The same request recorded several times is replayed in the order recorded; the last recording of it
// answers every later repeat (`times: always`), the earlier ones once each.
//
// The file is one document and is written whole after each exchange: the bytes written grow with the
// square of the number of exchanges. Each stub is serialised and checked once and kept as text, and is
// done again only when a credential learnt later occurs in it.

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

/** A value from a header, the query or a cookie is searched for from this length on. */
export const MIN_SECRET_LENGTH = 8;
/** A value from a body field is searched for from this length on, if it holds no whitespace. */
export const MIN_BODY_SECRET_LENGTH = 16;
/** Of a longer value only its start of this length is searched for. */
export const MAX_SECRET_LENGTH = 4096;
/** A response body over this is passed through and not recorded. */
export const RECORD_BODY_CAP = 8 * 1024 * 1024;
/** The response headers a recording keeps; a replay needs no other. */
export const RECORDED_RESPONSE_HEADERS = ['content-type', 'retry-after'] as const;
/** `plune run` refuses a stub file over this; the recorder says so once when the file passes it. */
const RUN_STUB_FILE_LIMIT = 1024 * 1024;

const DEFAULT_UPSTREAM_TIMEOUT_MS = 10 * 60 * 1000;
// A rename over a file another program has open fails on Windows; it is tried again after about 20, 40,
// 80, 160 and 320 ms before the write counts as failed.
const RENAME_RETRIES = 5;
const RENAME_FIRST_WAIT_MS = 20;
// A temp file a killed recorder left behind is removed by the next one once it is this old.
const STALE_TEMP_MS = 60_000;

/** The comment lines every recording starts with, after the line with the date and the origin. */
export const RECORDING_NOTES = [
  '# Prompts and answers are stored as they were sent and received: they may hold personal or confidential text.',
  `# A field with a secret's name holds ${MASK} in place of its value: in the JSON body of a request whatever the value is, in the JSON of an answer only a string of ${MIN_BODY_SECRET_LENGTH} characters or more with no whitespace that is not letters only.`,
  `# A credential value is also replaced wherever it is found, if it came in a header, the query or a cookie and has ${MIN_SECRET_LENGTH} characters or more, or in a body field and has ${MIN_BODY_SECRET_LENGTH} or more with no whitespace.`,
  `# Not searched for: a value of letters only, and a value in a form other than plain, URL-encoded, JSON-escaped, base64 or hex; a value over ${MAX_SECRET_LENGTH} characters is found by its first ${MAX_SECRET_LENGTH}.`,
  '# A credential in a path segment, or under an ordinary header, query or body-field name, is not known to the recorder.',
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
  /** One line per exchange that was not recorded, per write that failed, and per thing worth knowing. */
  warn?: (line: string) => void;
  /** Called after an exchange is in the file, with the method and the status. */
  onRecorded?: (method: string, status: number) => void;
  /** Called each time a stub is serialised and checked: once per exchange, unless a credential learnt later occurs in it. */
  onSerialise?: () => void;
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

// The names a field of a body holds a credential under. Narrower than the pattern for header names,
// which would also take `max_tokens`: a name is read without its case and its separators, and is a secret
// when it ends with one of these (`api_key`, `apiKey`, `client_secret`, `access_token`; not `key`,
// `max_tokens`, `tokenizer`, `keywords`, `author`).
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
  return SECRET_BODY_ENDINGS.some((e) => plain.endsWith(e));
}

/** Whether a value is searched for: long enough, and not a plain word. */
const searched = (value: string, min: number): boolean =>
  value.length >= min && /[^A-Za-z]/.test(value);

/** The values of a secret-looking header, query parameter or cookie that are searched for. */
function headerSecrets(value: string): string[] {
  // The whole value, and its parts: `Bearer <key>`, `name=<value>; name=<value>`.
  const parts = [value, ...value.split(/[\s;,]+/).flatMap((p) => [p, p.slice(p.indexOf('=') + 1)])];
  const basic = /^Basic\s+([A-Za-z0-9+/=_-]+)$/i.exec(value.trim());
  if (basic !== null) {
    // `user:password`: the password is the credential.
    const pair = Buffer.from(basic[1]!, 'base64').toString('utf8');
    if (pair.includes(':')) parts.push(pair.slice(pair.indexOf(':') + 1));
  }
  return parts.filter((part) => searched(part, MIN_SECRET_LENGTH));
}

const bodySecret = (value: string): boolean =>
  searched(value, MIN_BODY_SECRET_LENGTH) && !/\s/.test(value);

/** Every string under `value`, at any depth, keys included when asked. */
function strings(value: unknown, keys = false, into: string[] = []): string[] {
  if (typeof value === 'string') into.push(value);
  else if (value !== null && typeof value === 'object')
    for (const [k, v] of Object.entries(value)) {
      if (keys && !Array.isArray(value)) into.push(k);
      strings(v, keys, into);
    }
  return into;
}

/**
 * A JSON body with the mask in place of the value of the fields with a secret's name, at any depth. In a
 * request every such field is masked, whatever it holds. In an answer (`answer`) only one that holds a
 * string a body field is searched for by: an answer names ordinary things this way too (`token` for a
 * piece of text, `next_page_token`), and those stay. The strings the masked fields held go to `held`.
 */
function maskNamed(value: unknown, held: string[], answer = false): unknown {
  if (Array.isArray(value)) return value.map((item) => maskNamed(item, held, answer));
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => {
      const secret = isSecretBodyKey(k) && (!answer || (typeof v === 'string' && bodySecret(v)));
      if (!secret) return [k, maskNamed(v, held, answer)];
      held.push(MASK, ...strings(v));
      return [k, MASK];
    }),
  );
}

/** The strings a form-encoded body holds under secret names. */
function formSecrets(text: string): string[] {
  return [...new URLSearchParams(text)].filter(([k]) => isSecretBodyKey(k)).map(([, v]) => v);
}

// Only A-Z: the text keeps its length, so a place found in the lowered text is the same place in the text.
const lower = (text: string): string =>
  /[A-Z]/.test(text) ? text.replace(/[A-Z]+/g, (run) => run.toLowerCase()) : text;

interface Form {
  /** Lowered. */
  text: string;
  /** A base64 form: `=` signs that follow a find go with it. */
  padded: boolean;
  /** The start of a longer value: a find goes on to the next whitespace, so the rest goes with it. */
  start: boolean;
}

/** The forms a value is searched in. Of a value over `MAX_SECRET_LENGTH`, the forms of its start. */
function formsOf(value: string): Form[] {
  const start = value.length > MAX_SECRET_LENGTH;
  const head = start ? value.slice(0, MAX_SECRET_LENGTH) : value;
  let bytes = Buffer.from(head);
  const hex = bytes.toString('hex');
  // Whole groups of three bytes only: what base64 makes of them does not depend on what follows.
  if (start) bytes = bytes.subarray(0, bytes.length - (bytes.length % 3));
  const plain = [head, encodeURIComponent(head), JSON.stringify(head).slice(1, -1)];
  const base64 = [bytes.toString('base64').replace(/=+$/, ''), bytes.toString('base64url')];
  return [
    ...plain.map((text) => ({ text: lower(text), padded: false, start })),
    { text: hex, padded: false, start },
    ...base64.map((text) => ({ text: lower(text), padded: true, start })),
  ];
}

const holds = (lowered: string, forms: readonly Form[]): boolean =>
  forms.some((form) => lowered.includes(form.text));

/** `text` with every find of every form replaced by the mask. The text is lowered once, and rewritten only on a find. */
function maskText(text: string, forms: readonly Form[]): string {
  let out = text;
  let lowered = lower(text);
  for (const form of forms) {
    let at = lowered.indexOf(form.text);
    if (at === -1) continue;
    let built = '';
    let from = 0;
    while (at !== -1) {
      built += out.slice(from, at) + MASK;
      from = at + form.text.length;
      for (let pad = 0; form.padded && pad < 2 && out[from] === '='; pad += 1) from += 1;
      while (form.start && from < out.length && !/\s/.test(out[from]!)) from += 1;
      at = lowered.indexOf(form.text, from);
    }
    out = built + out.slice(from);
    lowered = lower(out);
  }
  return out;
}

/** `value` with every find replaced in every string value. Keys stay as they are. */
function maskDeep(value: unknown, forms: readonly Form[]): unknown {
  if (typeof value === 'string') return maskText(value, forms);
  if (Array.isArray(value)) return value.map((item) => maskDeep(item, forms));
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskDeep(v, forms)]));
  return value;
}

type SseChunk = string | { event?: string; data: unknown };
type BodyForm = { sse: SseChunk[] } | { json: unknown } | { text: string };

/** The payloads of an answer that comes in pieces: the data of each event, or each line. None for JSON. */
function payloads(body: BodyForm): unknown[] {
  if ('sse' in body)
    return body.sse.map((chunk) => (typeof chunk === 'string' ? chunk : chunk.data));
  if (!('text' in body)) return [];
  const lines = body.text.split(/\r?\n/);
  const data = lines.filter((line) => line.startsWith('data:'));
  return data.length > 0 ? data.map((line) => line.replace(/^data: ?/, '')) : lines;
}

/**
 * An answer in pieces read joined, three ways: the payloads one after another; every string inside their
 * JSON one after another; and the strings under the same keys of piece after piece (the place in an array
 * does not count). A value a client would put together from the pieces is in one of them.
 */
function joined(body: BodyForm): string[] {
  let raw = '';
  let leaves = '';
  const byKey = new Map<string, string>();
  const walk = (value: unknown, at: string): void => {
    if (typeof value === 'string') {
      leaves += value;
      byKey.set(at, (byKey.get(at) ?? '') + value);
    } else if (Array.isArray(value)) for (const item of value) walk(item, at);
    else if (value !== null && typeof value === 'object')
      for (const [k, v] of Object.entries(value)) walk(v, `${at}/${k}`);
  };
  for (const payload of payloads(body)) {
    let parsed = payload;
    if (typeof payload === 'string') {
      raw += payload;
      try {
        parsed = JSON.parse(payload) as unknown;
      } catch {
        // Not JSON: the payload itself is the string.
      }
    } else raw += JSON.stringify(payload);
    walk(parsed, '');
  }
  return [raw, leaves, ...byKey.values()];
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

/**
 * The answer with the first rule applied: secret-named fields of its JSON hold the mask. Text that is
 * JSON with such a field is kept as JSON, since it is no longer the bytes that came. What those fields
 * held, and what a form-encoded answer holds under secret names, goes to `held`.
 */
function namedMasked(body: BodyForm, contentType: string, held: string[]): BodyForm {
  if ('json' in body) return { json: maskNamed(body.json, held, true) };
  if ('sse' in body)
    return {
      sse: body.sse.map((chunk) =>
        typeof chunk === 'string' ? chunk : { ...chunk, data: maskNamed(chunk.data, held, true) },
      ),
    };
  if (/^application\/x-www-form-urlencoded/i.test(contentType))
    held.push(...formSecrets(body.text));
  try {
    const before = held.length;
    const json = maskNamed(JSON.parse(body.text), held, true);
    if (held.length > before) return { json };
  } catch {
    // Not one JSON document: its pieces below.
  }
  // Pieces that are JSON but are kept as text: what their secret-named fields hold is learnt, and so
  // searched for if it qualifies; a shorter value stays in the text.
  for (const payload of payloads(body))
    if (typeof payload === 'string')
      try {
        maskNamed(JSON.parse(payload), held, true);
      } catch {
        // Not JSON.
      }
  return body;
}

interface Exchange {
  method: string;
  status: number;
  /** What tells one request from another: the method, the path and the body. */
  request: string;
  /** Everything of the stub but `method` and `times`, with the first rule applied and the second not. */
  rest: {
    path: string;
    body?: unknown;
    match: 'exact';
    response: { status: number; headers: Record<string, string> } & BodyForm;
  };
  /** Every string of `rest` and its joined readings, lowered: where a value learnt later is looked for. */
  haystack: string;
  /** The lines of `rest` as they go into the file; none when they have to be made (again). */
  lines?: string | undefined;
  onDisk: boolean;
}

const stubHead = (method: string, times: string): string =>
  `    {\n      "method": ${JSON.stringify(method)},\n      "times": "${times}",\n`;

/**
 * The lines of one stub for the file, or why it cannot be written. Fail closed: the stub goes into the
 * file only if it reads back as what was meant and holds no searched value.
 */
function stubLines(exchange: Exchange, known: readonly Form[]): string | { skip: string } {
  // Only the forms that occur somewhere in the exchange are worked with; mostly that is none, and the
  // exchange is then written as it came, with no string of it looked at again.
  const forms = known.filter((form) => exchange.haystack.includes(form.text));
  let rest = exchange.rest;
  if (forms.length > 0) {
    rest = maskDeep(exchange.rest, forms) as Exchange['rest'];
    if (joined(rest.response).some((text) => holds(lower(text), forms)))
      return { skip: 'a credential is split over the pieces of the answer' };
  }
  // `{` of the object is replaced by the head with the method and `times`, which change after this.
  const body = `      ${JSON.stringify(rest, null, 2).split('\n').slice(1).join('\n      ').slice(0, -1)}    }`;
  const text = stubHead(exchange.method, 'once') + body;
  const unsafe = { skip: 'it cannot be written safely' };
  try {
    const meant = stubSchema.safeParse({ method: exchange.method, times: 'once', ...rest });
    if (!meant.success) return unsafe;
    // JSON in printable ASCII is read by a YAML reader as JSON reads it, so it needs no reading back.
    // Anything else is read back with the reader of stub files, which is slow: seconds for megabytes.
    if (!/^[\x20-\x7e\n]*$/.test(text) || text.includes('__proto__')) {
      const read = parseStubFile(`{"version":${STUB_FILE_VERSION},"stubs":[\n${text}\n]}`).stubs[0];
      if (JSON.stringify(read) !== JSON.stringify(meant.data)) return unsafe;
    }
  } catch {
    return unsafe;
  }
  // A key holds one, or the masking made one: nothing a replacement can fix.
  return forms.length > 0 && holds(lower(text), forms) ? unsafe : body;
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

/** The code of a file system error, or a fixed word: never the message, which may hold data. */
const codeOf = (err: unknown): string => {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? code : 'error';
};

const isRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // No right to signal it: it is there.
    return codeOf(err) === 'EPERM';
  }
};

export async function startRecorder(options: RecordOptions): Promise<Recorder> {
  const target = parseTarget(options.target);
  const scope = options.scope ?? 'default';
  if (!SCOPE_NAME.test(scope))
    throw new RecordError(
      'Bad --scope: letters, digits, ".", "_" and "-" only, and not "." or ".."',
    );
  const file = resolveInside(options.cwd ?? process.cwd(), options.file);
  const lock = `${file}.lock`;
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
  // The longest first: a whole header value before the key inside it.
  let forms: Form[] = [];
  const inFlight = new Set<http.ClientRequest>();
  /** Answers handed to their clients whose exchange is not in memory yet. */
  const settling = new Set<Promise<void>>();
  let closing: Promise<void> | undefined;
  let port = 0;

  /**
   * Takes the values into the searched set. A stub made before, in which one of them occurs, is made
   * again; says whether there is such a stub.
   */
  const learn = (values: Iterable<string>): boolean => {
    const fresh: Form[] = [];
    for (const value of values) {
      if (secrets.has(value)) continue;
      secrets.add(value);
      fresh.push(...formsOf(value));
    }
    if (fresh.length === 0) return false;
    forms = [...forms, ...fresh].sort((a, b) => b.text.length - a.text.length);
    let stale = false;
    for (const exchange of exchanges)
      if (exchange.lines !== undefined && holds(exchange.haystack, fresh)) {
        exchange.lines = undefined;
        exchange.onDisk = false;
        stale = true;
      }
    return stale;
  };

  /** The text of the whole file from what is in memory; what cannot be written safely is dropped. */
  const render = (): string => {
    exchanges = exchanges.filter((exchange) => {
      if (exchange.lines !== undefined) return true;
      options.onSerialise?.();
      const lines = stubLines(exchange, forms);
      if (typeof lines === 'string') {
        exchange.lines = lines;
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
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(codeOf(err)) || attempt >= RENAME_RETRIES)
          throw err;
        // Not a round number of milliseconds: a reader on a timer must not meet every try.
        await wait(RENAME_FIRST_WAIT_MS * 2 ** attempt * (0.5 + Math.random()));
      }
    }
  };

  // At most one write at a time, and each takes everything in memory: exchanges that arrive while a write
  // runs go out together with the next one. An exchange stays in memory until a write that holds it has
  // succeeded, so a failed write loses nothing: the next one carries it. Nothing that goes wrong in here
  // leaves it as an error: the words of the warning are fixed, and hold a code at most.
  let dirty = false;
  let writing: Promise<void> | undefined;
  let saidLarge = false;
  const flush = (): Promise<void> => {
    dirty = true;
    writing ??= (async () => {
      try {
        while (dirty) {
          dirty = false;
          let held: Exchange[];
          let text: string;
          try {
            text = render();
            held = exchanges;
            await writeAtomic(text);
          } catch (err) {
            const waiting = exchanges.filter((e) => !e.onDisk).length;
            warn(
              `the file could not be written (${codeOf(err)}): ${waiting} ${waiting === 1 ? 'exchange waits' : 'exchanges wait'} in memory for the next write`,
            );
            return;
          }
          for (const exchange of held) {
            // Made stale while the write ran: the next write puts it on disk.
            if (exchange.onDisk || exchange.lines === undefined) continue;
            exchange.onDisk = true;
            options.onRecorded?.(exchange.method, exchange.status);
          }
          if (!saidLarge && Buffer.byteLength(text) > RUN_STUB_FILE_LIMIT) {
            saidLarge = true;
            warn(
              'the recording is over 1 MiB: `plune run` refuses a stub file over 1 MiB, `plune mock` serves it',
            );
          }
        }
      } catch {
        // `warn` or a callback threw: nothing to say that would be safe to say.
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
    const carried: string[] = [];
    const named = new Set(
      one(req.headers.connection)
        .toLowerCase()
        .split(/[\s,]+/),
    );
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      if (SECRET_NAME.test(name)) carried.push(...headerSecrets(one(value)));
      if (NOT_FORWARDED.has(name) || named.has(name) || name.startsWith('x-forwarded-')) continue;
      headers[name] = value;
    }
    for (const [name, value] of new URLSearchParams(query))
      if (SECRET_NAME.test(name)) carried.push(...headerSecrets(value));
    const sent = body.toString('utf8');
    const inBody: string[] = [];
    let stored: unknown;
    try {
      stored = maskNamed(JSON.parse(sent), inBody);
    } catch {
      stored = undefined;
      if (/^application\/x-www-form-urlencoded/i.test(one(req.headers['content-type'])))
        inBody.push(...formSecrets(sent));
    }
    // A credential seen for the first time here may sit in a stub written before, also when this
    // request ends up not recorded: that stub is written again now.
    // Not in the way of this request: the rewrite starts once it has been sent on.
    if (learn([...carried, ...inBody.filter(bodySecret)])) setImmediate(() => void flush());

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
    // A 101 hands over a connection this proxy has no use for. Any other 1xx is waited through.
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
        // The client has its answer before anything is made of it for the file: reading the body,
        // masking and writing start once the response has been handed over whole.
        const settled = new Promise<void>((resolve) => {
          res.once('close', () => {
            if (!res.writableFinished) resolve();
          });
          res.end(() =>
            setImmediate(() => {
              try {
                if (res.writableFinished) record();
              } catch {
                warn(`not recorded: ${method} ${status} (it cannot be written safely)`);
              }
              resolve();
            }),
          );
        });
        settling.add(settled);
        void settled.then(() => settling.delete(settled));
      });
      const record = (): void => {
        const skip = (why: string): void => warn(`not recorded: ${method} ${status} (${why})`);
        if (status === 304) return skip('a 304 has no body to replay');
        if (status >= 300 && status < 400) return skip('a redirect is passed back, not followed');
        if (size > cap) return skip(`the body is over ${cap} bytes`);
        if (!/^(identity)?$/i.test(one(up.headers['content-encoding']).trim()))
          return skip('the body is compressed');
        const contentType = one(up.headers['content-type']);
        const came = bodyForm(Buffer.concat(chunks), contentType);
        if (came === undefined) return skip('the body is not UTF-8 text');
        const answered: string[] = [];
        const form = namedMasked(came, contentType, answered);
        learn(answered.filter(bodySecret));
        const kept: Record<string, string> = {};
        for (const name of RECORDED_RESPONSE_HEADERS) {
          const value = one(up.headers[name]);
          if (value !== '') kept[name] = value;
        }
        const rest: Exchange['rest'] = {
          path: stubPath,
          ...(stored === undefined ? {} : { body: stored }),
          match: 'exact',
          response: { status, headers: kept, ...form },
        };
        exchanges.push({
          method,
          status,
          request: JSON.stringify([method, stubPath, stored]),
          rest,
          haystack: lower([...strings(rest, true), ...joined(rest.response)].join('\n')),
          onDisk: false,
        });
        void flush();
      };
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
    throw new RecordError(`Cannot listen on 127.0.0.1: ${codeOf(err)}`);
  }
  ({ port } = server.address() as AddressInfo);
  const stopListening = (): Promise<void> =>
    new Promise<void>((resolve) => server.close(() => resolve()));

  // One recorder per file: a second one, with --force, would replace what the first has written and
  // go on replacing it. The lock is a file beside the recording with the process id of its recorder; the
  // lock of a process that is gone is taken over.
  let locked = false;
  try {
    for (let attempt = 0; !locked; attempt += 1) {
      try {
        fs.writeFileSync(lock, `${process.pid}\n`, { flag: 'wx', mode: 0o600 });
        locked = true;
      } catch (err) {
        if (codeOf(err) !== 'EEXIST' || attempt > 0)
          throw new RecordError('The lock file beside the recording cannot be written');
        const pid = Number(fs.readFileSync(lock, 'utf8').trim());
        if (Number.isInteger(pid) && pid > 0 && isRunning(pid))
          throw new RecordError(
            `another recorder (process ${pid}) is writing this file: stop it first, or give another path. Its lock is ${lock}: if no recorder is running, delete that file`,
          );
        fs.rmSync(lock, { force: true });
        warn('a lock of a recorder that is no longer running was found and taken over');
      }
    }

    // Temp files of a recorder of this file that was killed between a write and its rename.
    const name = path.basename(file);
    for (const entry of fs.readdirSync(path.dirname(file))) {
      const left = path.join(path.dirname(file), entry);
      if (
        !entry.startsWith(`${name}.`) ||
        !/^[0-9a-f]{32}\.tmp$/.test(entry.slice(name.length + 1))
      )
        continue;
      if (Date.now() - fs.statSync(left).mtimeMs > STALE_TEMP_MS) fs.rmSync(left, { force: true });
    }

    // An empty stub file: over the old one when that was asked for, otherwise only if nothing is there.
    try {
      if (exists) await writeAtomic(render());
      else await fs.promises.writeFile(file, render(), { flag: 'wx', mode: 0o600 });
    } catch (err) {
      throw new RecordError(
        codeOf(err) === 'EEXIST'
          ? 'The recording file exists already: give another path, or --force to replace it'
          : 'The recording file cannot be created',
      );
    }
  } catch (err) {
    if (locked) fs.rmSync(lock, { force: true });
    await stopListening();
    throw err instanceof RecordError
      ? err
      : new RecordError('The folder of the recording cannot be read or written');
  }

  const local = ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname);
  if (target.protocol === 'http:' && !local)
    warn(
      'the target is http: on another machine: every request, its credential included, travels unencrypted',
    );

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
        const closed = stopListening();
        for (const upstream of inFlight) upstream.destroy();
        server.closeAllConnections();
        await closed;
        await Promise.all(settling);
        await writing;
        // What a failed write left in memory gets one more write.
        if (exchanges.some((e) => !e.onDisk)) await flush();
        fs.rmSync(lock, { force: true });
      })();
      return closing;
    },
  };
}
