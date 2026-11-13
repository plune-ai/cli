import type { ChildProcess } from 'node:child_process';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
// A static import on purpose, as in src/mcp/server.ts: the CLI bundle is CommonJS, and a dynamic import() of the
// package there would load its other build. This module is itself loaded lazily, only by a `plune mcp` action.
import {
  Client,
  ProtocolError,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  SSEClientTransport,
  SseError,
  StreamableHTTPClientTransport,
  UnauthorizedError,
  type StandardSchemaV1,
  type Transport,
} from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { machineless, printable } from '../../reporter-core/failure-detail.js';
import { MCP_EXIT } from '../exit-codes.js';
import { openJournal, type Journal } from './journal.js';
import type { ConnectConfig, ConnectTarget } from './options.js';
import { descendantsOf, killAll, killSurvivors, track, type Proc } from './processes.js';
import { describeTarget, redactorFor, type Redactor } from './redact.js';

export { closeAllSessions } from './processes.js';

export type ConnectErrorKind =
  | 'could-not-start'
  | 'exited-early'
  | 'too-large'
  | 'timeout'
  | 'protocol'
  | 'auth'
  | 'network';

/** Why a server could not be reached or stopped answering. Message and tail are masked and free of this machine. */
export class ConnectError extends Error {
  readonly exitCode = MCP_EXIT.usage;
  constructor(
    readonly kind: ConnectErrorKind,
    message: string,
    /** The last lines the server process wrote to stderr (stdio only). */
    readonly stderrTail: string[],
  ) {
    super(message);
    this.name = 'ConnectError';
  }
}

export interface Session {
  /** The masking of this connection: what a command prints of the server's answers goes through it. */
  readonly redact: Redactor;
  /**
   * A request with the result as the server sent it: no schema stands between, so a malformed answer is seen. A
   * JSON-RPC error from the server rejects with a `ProtocolError` (its code kept, its text masked); a lost or silent
   * server with a `ConnectError`.
   */
  request(
    method: string,
    params?: Record<string, unknown>,
    options?: { timeoutMs?: number },
  ): Promise<unknown>;
  /** The `serverInfo` of the handshake, as the server sent it (undefined when it sent none). */
  readonly server: { name: string; version: string } | undefined;
  /**
   * The handshake as it went: the protocol version this client offered, and the `initialize` result as the server
   * sent it (before any schema), so a malformed answer is seen. Not masked: what is printed of it goes through `redact`.
   */
  readonly handshake: { offered: unknown; result: unknown };
  /** The last lines the server process wrote to stderr so far, masked (stdio only; empty otherwise). */
  stderrTail(): string[];
  /**
   * A fetch for requests the session makes besides MCP (discovery, later OAuth). It refuses a URL outside `origin`,
   * adds the `--header` values only when `origin` is the server's own, and follows no redirect.
   */
  fetchForOrigin(origin: string): (input: string | URL, init?: RequestInit) => Promise<Response>;
  /** Ends the connection and every process it started. A second call returns the first one's promise. */
  close(): Promise<void>;
  /**
   * The thin JSON-RPC layer under `plune mcp conformance`: `body` goes to the server as written, beside the SDK (one
   * line on stdin, or one POST to the Streamable HTTP endpoint with this session's headers), and the first answer whose
   * `id` is `id` comes back parsed, with no schema between, so a malformed answer is seen as sent. `id: null` waits for
   * an error with no id or a null one (the answer to a message whose id could not be read). Rejects with a
   * `ConnectError`: `timeout` when no such answer came. Not for HTTP+SSE.
   */
  raw(body: string, id: string | number | null, options?: RawOptions): Promise<RawReply>;
  /**
   * Writes a message that has no answer (a notification) to a stdio server as one line, as written. Rejects with a
   * `ConnectError` when the process is gone or its stdin is closed. Not for HTTP.
   */
  notify(body: string): Promise<void>;
  /**
   * Every JSON-RPC message the server sent that the raw layer saw, in order: each line of a stdio server's stdout, and
   * each message of a raw POST's answer (its SSE events included). A response carries the method of the raw request
   * whose id it holds. Not masked: what is printed of it goes through `redact`.
   */
  traffic(): readonly Traffic[];
  /** How many lines a stdio server wrote on stdout that are not JSON-RPC messages, and the first few, masked. */
  stdoutNoise(): { count: number; first: string[] };
  /** Closes a stdio server's stdin and says whether the process exited within `waitMs` (true over HTTP). */
  endInput(waitMs: number): Promise<boolean>;
  /** How many notifications named `method` the server has sent on this connection so far. */
  notified(method: string): number;
}

export interface RawReply {
  /** The answer, parsed; undefined when the server answered with no JSON-RPC message (an HTTP error page). */
  frame: Record<string, unknown> | undefined;
  /** The HTTP status (HTTP only). */
  status?: number;
  /** What came back, masked and cut to RAW_TEXT characters. */
  text: string;
}

export interface RawOptions {
  timeoutMs?: number;
  /** Streamable HTTP: headers set on this POST over the ones the session derives (a value of null drops the header). */
  headers?: [string, string | null][];
}

export interface Traffic {
  frame: Record<string, unknown>;
  /** For a response: the method of the raw request with its id. */
  method?: string;
}

/**
 * `modern`: the 2026-07-28 era. No `initialize` handshake is made: every request carries its own `_meta`, and over
 * Streamable HTTP a raw POST gets the standard headers from its body (`MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`).
 */
export interface SessionOptions {
  modern?: { version: string };
}

const RAW_TEXT = 2000;

/** A header value as the 2026-07-28 Streamable HTTP transport writes it: plain when safe, else the Base64 sentinel. */
export function headerValue(value: string): string {
  const plain = /^[\x21-\x7e]([\x20-\x7e]*[\x21-\x7e])?$/.test(value) && !/^=\?base64\?.*\?=$/.test(value);
  return plain ? value : `=?base64?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

/** The standard headers of a modern request, read from its body (Streamable HTTP, Request Metadata). */
function modernHeaders(body: string, version: string): [string, string][] {
  const m = parsed(body);
  if (m === null || typeof m !== 'object' || Array.isArray(m)) return [];
  const { method, params } = m as { method?: unknown; params?: Record<string, unknown> };
  if (typeof method !== 'string') return [];
  const meta = params?.['_meta'] as Record<string, unknown> | undefined;
  const v = meta?.['io.modelcontextprotocol/protocolVersion'];
  const headers: [string, string][] = [
    ['mcp-protocol-version', typeof v === 'string' ? v : version],
    ['mcp-method', method],
  ];
  const name = method === 'resources/read' ? params?.['uri'] : params?.['name'];
  if (['tools/call', 'resources/read', 'prompts/get'].includes(method) && typeof name === 'string')
    headers.push(['mcp-name', headerValue(name)]);
  return headers;
}

/** Whether `frame` answers the message `id` (for null: an error with no id, or a null one). */
function answers(frame: unknown, id: string | number | null): frame is Record<string, unknown> {
  if (frame === null || typeof frame !== 'object' || Array.isArray(frame)) return false;
  const f = frame as Record<string, unknown>;
  if (!('result' in f) && !('error' in f)) return false;
  return id === null ? 'error' in f && (f['id'] === null || f['id'] === undefined) : f['id'] === id;
}

const parsed = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** The first `data:` line of an SSE body that answers `id`. One line per event: a JSON-RPC message holds no newline. */
function fromEventStream(text: string, id: string | number | null): Record<string, unknown> | undefined {
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const frame = parsed(line.slice(5).trim());
    if (answers(frame, id)) return frame;
  }
  return undefined;
}

const TAIL_LINES = 20;

/**
 * The most one message on a stdio server's stdout may hold, in bytes: the SDK's default, stated so the error can name
 * it. The SDK copies its read buffer on every chunk, so the cost of reading a message grows with its square (about
 * 0.2 s for 9 MB, 2 s for 38 MB, 29 s for 150 MB); a list that large belongs in pages.
 */
export const STDIO_MESSAGE_LIMIT = 10 * 1024 * 1024;

/** Accepts any result as it is: `tools/list` reaches the caller as sent, not as the SDK's schema would parse it. */
const AS_SENT: StandardSchemaV1<unknown> = {
  '~standard': { version: 1, vendor: 'plune', validate: (value) => ({ value }) },
};

function createTransport(target: ConnectTarget): Transport {
  if (target.kind === 'stdio') {
    // `env` holds only what --env named; the SDK adds its short list of safe variables (PATH, HOME, …), never the
    // rest of this process's environment.
    return new StdioClientTransport({
      command: target.command,
      args: target.args,
      env: target.env,
      stderr: 'pipe',
      maxBufferSize: STDIO_MESSAGE_LIMIT,
      ...(target.cwd !== undefined ? { cwd: target.cwd } : {}),
    });
  }
  // Stated, not left to the default: a redirect to another origin would otherwise carry the --header values with it.
  const options = {
    requestInit: { headers: target.headers },
    redirectPolicy: 'same-origin' as const,
  };
  return target.kind === 'sse'
    ? new SSEClientTransport(new URL(target.url), options)
    : new StreamableHTTPClientTransport(new URL(target.url), options);
}

/** Writes every frame both ways to the journal and reports the transport's errors and its close, changing nothing. */
function tap(
  transport: Transport,
  journal: Journal,
  on: {
    error: (err: Error) => void;
    closed: () => void;
    frame: (dir: 'out' | 'in', message: object) => void;
  },
): void {
  const send = transport.send.bind(transport);
  transport.send = (message, options) => {
    journal.write('out', { frame: message });
    on.frame('out', message);
    return send(message, options);
  };
  const logged = new WeakSet<object>();
  intercept(transport, 'onmessage', (message: object) => {
    if (logged.has(message)) return;
    logged.add(message);
    journal.write('in', { frame: message });
    on.frame('in', message);
  });
  intercept(transport, 'onclose', on.closed);
  intercept(transport, 'onerror', on.error);
}

/**
 * Runs `before` ahead of whatever handler the client sets on `name`. The client reads a handler and sets one that
 * calls it, so a read returns a wrapper bound to the handler of that moment (never a later one, which would call
 * itself), and `before` is told only once per message.
 */
function intercept(
  transport: Transport,
  name: 'onmessage' | 'onclose' | 'onerror',
  before: (...args: never[]) => void,
): void {
  let handler: ((...args: unknown[]) => void) | undefined;
  Object.defineProperty(transport, name, {
    configurable: true,
    get: () => {
      const current = handler;
      return (
        current &&
        ((...args: unknown[]) => {
          (before as (...args: unknown[]) => void)(...args);
          current(...args);
        })
      );
    },
    set: (fn: ((...args: unknown[]) => void) | undefined) => (handler = fn),
  });
}

/**
 * Journals the lines on a stdio server's stdout that are not JSON-RPC messages. The SDK drops such a line with a
 * parse error that does not carry it, so the stream is read here as well, beside the SDK's own reader. The transport
 * keeps the process to itself; it is reached after start, before any output can have arrived. Every line also goes to
 * `seen`: the noise count and the raw layer read stdout here.
 */
function watchStdout(
  transport: StdioClientTransport,
  journal: Journal,
  seen: (line: string, isMessage: boolean) => void,
): void {
  const start = transport.start.bind(transport);
  transport.start = async () => {
    await start();
    const stdout = (transport as unknown as { _process?: { stdout?: Readable | null } })._process
      ?.stdout;
    if (stdout === null || stdout === undefined) return;
    createInterface({ input: stdout, crlfDelay: Infinity }).on('line', (line) => {
      const isMessage = isJsonRpc(line);
      if (!isMessage) journal.write('noise', { line });
      seen(line, isMessage);
    });
  };
}

/**
 * Calls `over` when a message on a stdio server's stdout passes STDIO_MESSAGE_LIMIT, before the SDK acts on it. The SDK
 * then reports a bare error and closes the process, which would read as a server that exited. Its read buffer is
 * private, reached as `_process` is above; without it nothing is watched and the old message stays.
 */
function watchOverflow(transport: StdioClientTransport, over: () => void): void {
  const buffer = (transport as unknown as { _readBuffer?: { append?: (chunk: Buffer) => void } })
    ._readBuffer;
  const append = buffer?.append?.bind(buffer);
  if (buffer === undefined || append === undefined) return;
  buffer.append = (chunk) => {
    try {
      append(chunk);
    } catch (err) {
      over();
      throw err;
    }
  };
}

function isJsonRpc(line: string): boolean {
  try {
    const parsed = JSON.parse(line) as { jsonrpc?: unknown } | null;
    return parsed !== null && typeof parsed === 'object' && parsed.jsonrpc === '2.0';
  } catch {
    return false;
  }
}

const firstLine = (text: string) => text.split(/\r?\n/)[0] ?? '';

function kindOf(err: unknown, stdio: boolean, transportClosed: boolean): ConnectErrorKind {
  if (err instanceof SdkError && err.code === SdkErrorCode.RequestTimeout) return 'timeout';
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (stdio && typeof code === 'string' && /^(ENOENT|EACCES|EPERM|ENOTDIR|EINVAL)$/.test(code))
    return 'could-not-start';
  if (stdio) return transportClosed ? 'exited-early' : 'protocol';
  if (err instanceof UnauthorizedError) return 'auth';
  // The HTTP status, where the transport kept one: Streamable HTTP in SdkHttpError, SSE in SseError (none = no answer).
  const status =
    err instanceof SdkHttpError
      ? Number(err.status)
      : err instanceof SseError
        ? err.code
        : undefined;
  if (status === 401 || status === 403) return 'auth';
  // A redirect the transport did not follow (another origin, or a changed method) ends here too.
  if (status !== undefined && status >= 300 && status < 400) return 'network';
  if (err instanceof SseError && status === undefined) return 'network';
  if (
    err instanceof TypeError ||
    (err as { cause?: { code?: unknown } } | undefined)?.cause?.code !== undefined
  )
    return 'network';
  return 'protocol';
}

/** The sentence each kind opens with, and whether the SDK's text follows it (not where the stderr tail says why). */
const LEAD: Record<ConnectErrorKind, [string, boolean]> = {
  'could-not-start': ['Could not start the server command', true],
  'exited-early': ['The server process exited before it answered', false],
  'too-large': [
    `The server sent a message larger than ${STDIO_MESSAGE_LIMIT / 1024 / 1024} MB, the most plune reads in one stdio message; a long list belongs in pages (nextCursor)`,
    false,
  ],
  timeout: ['The server did not answer within --timeout', false],
  protocol: ['The server did not answer as an MCP server', true],
  auth: ['The server refused the credentials', true],
  network: ['Could not reach the server', true],
};

export async function openSession(config: ConnectConfig, options: SessionOptions = {}): Promise<Session> {
  const { target } = config;
  const stdio = target.kind === 'stdio';
  const redact = redactorFor(target);
  const clean = (text: string) => printable(redact.text(machineless(text, undefined, homedir())));
  const journal = openJournal(config.debugOut, redact);
  journal.write('meta', describeTarget(target, redact));

  const transport = createTransport(target);
  let transportClosed = false;
  // On Windows a command that does not exist still "spawns"; the ENOENT comes after, as a transport error.
  let spawnError: Error | undefined;
  // The raw layer's waiters on a stdio server that stops: a process that is gone answers nothing more.
  const stopped = new Set<() => void>();
  // The initialize request and its answer, kept as they went (the SDK keeps only what its schema let through).
  const handshake: { id?: unknown; offered: unknown; result: unknown } = {
    offered: undefined,
    result: undefined,
  };
  const notifications = new Map<string, number>();
  tap(transport, journal, {
    frame: (dir, message) => {
      const m = message as { id?: unknown; method?: unknown; params?: unknown; result?: unknown };
      if (dir === 'out' && m.method === 'initialize') {
        handshake.id = m.id;
        handshake.offered = (
          m.params as { protocolVersion?: unknown } | undefined
        )?.protocolVersion;
      } else if (dir === 'in' && handshake.id !== undefined && m.id === handshake.id)
        handshake.result = m.result;
      if (dir === 'in' && m.id === undefined && typeof m.method === 'string')
        notifications.set(m.method, (notifications.get(m.method) ?? 0) + 1);
    },
    closed: () => {
      transportClosed = true;
      for (const stop of [...stopped]) stop();
    },
    error: (err) => {
      if (
        spawnError === undefined &&
        (err as NodeJS.ErrnoException).syscall?.startsWith('spawn') === true
      ) {
        spawnError = err;
        for (const stop of [...stopped]) stop();
      }
    },
  });

  // What a close noted: the SDK forgets the process as soon as its close begins, and killNow may still need it.
  let noted: { pid: number; tree: Proc[] } | undefined;
  const serverPid = () => (transport instanceof StdioClientTransport ? transport.pid : null);
  const note = () => {
    // Note the descendants while the server is alive to name them: once it is gone, nothing points at them.
    const pid = serverPid();
    if (pid !== null) noted = { pid, tree: descendantsOf(pid) };
  };
  // Set when a message passed the limit: the SDK closes the process itself then, so its tree is noted at that moment.
  let tooLarge = false;

  const tail: string[] = [];
  const noise = { count: 0, first: [] as string[] };
  // What the raw layer saw come in, and the method of each raw request by its id.
  const traffic: Traffic[] = [];
  const methods = new Map<unknown, string>();
  const heard = (frame: unknown) => {
    if (frame === null || typeof frame !== 'object' || Array.isArray(frame)) return;
    const f = frame as Record<string, unknown>;
    const method = 'method' in f || f['id'] === undefined ? undefined : methods.get(f['id']);
    traffic.push(method === undefined ? { frame: f } : { frame: f, method });
  };
  // The raw layer's waiters on stdout: each sees every line until it settles.
  const listeners = new Set<(line: string) => void>();
  const seen = (line: string, isMessage: boolean) => {
    if (!isMessage) {
      noise.count++;
      if (noise.first.length < 3) noise.first.push(clean(line).slice(0, 200));
    }
    if (isMessage) heard(parsed(line));
    for (const listener of [...listeners]) listener(line);
  };
  let stderrDone: Promise<void> = Promise.resolve();
  if (transport instanceof StdioClientTransport && transport.stderr !== null) {
    const lines = createInterface({ input: transport.stderr as Readable, crlfDelay: Infinity });
    lines.on('line', (line) => {
      journal.write('stderr', { line });
      tail.push(clean(line));
      if (tail.length > TAIL_LINES) tail.shift();
    });
    stderrDone = new Promise((resolve) => lines.once('close', resolve));
    watchStdout(transport, journal, seen);
    watchOverflow(transport, () => {
      if (tooLarge) return;
      tooLarge = true;
      note();
    });
  }

  const toConnectError = async (err: unknown): Promise<ConnectError> => {
    // The process may have said why it stopped; let the last of its stderr arrive (bounded: a helper can hold it open).
    if (transportClosed) await Promise.race([stderrDone, new Promise((r) => setTimeout(r, 500))]);
    const cause = spawnError ?? err;
    const kind = tooLarge ? 'too-large' : kindOf(cause, stdio, transportClosed);
    const [lead, withDetail] = LEAD[kind];
    const detail = withDetail
      ? clean(firstLine(cause instanceof Error ? cause.message : String(cause)))
      : '';
    const error = new ConnectError(kind, detail === '' ? `${lead}.` : `${lead}: ${detail}`, [
      ...tail,
    ]);
    journal.write('error', { kind, message: error.message });
    return error;
  };

  let closing: Promise<void> | undefined;
  const shutdown = async () => {
    note();
    await transport.close().catch(() => {});
    killSurvivors(noted?.tree ?? []);
    untrack();
    journal.close();
  };
  const closable = {
    close: () => (closing ??= shutdown()),
    killNow: () => {
      const pid = serverPid() ?? noted?.pid;
      if (pid === undefined || pid === null) return;
      const tree = [...descendantsOf(pid), ...(noted?.tree ?? [])].map((p) => p.pid);
      killAll([...new Set([...tree, pid])]);
    },
  };
  const untrack = track(closable);

  const client = new Client({ name: 'plune', version: config.clientVersion ?? '0.0.0' });
  const modern = options.modern;
  if (modern !== undefined) {
    // No client: the transport is only started, and the raw layer is all that speaks. Its handlers are set so that
    // the tap hears a spawn error and the close.
    transport.onmessage = () => {};
    transport.onerror = () => {};
    transport.onclose = () => {};
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      modern === undefined ? client.connect(transport, { timeout: config.timeoutMs }) : transport.start(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new SdkError(SdkErrorCode.RequestTimeout, 'no answer')),
          config.timeoutMs,
        );
      }),
    ]);
  } catch (err) {
    if (closing === undefined) {
      const error = await toConnectError(err);
      await closable.close();
      throw error;
    }
  } finally {
    clearTimeout(timer);
  }
  if (closing !== undefined) {
    await closing;
    throw new Error('The session was closed while it was connecting.');
  }

  const info = client.getServerVersion();
  return {
    redact,
    server:
      info === undefined ? undefined : { name: String(info.name), version: String(info.version) },
    handshake: { offered: handshake.offered, result: handshake.result },
    stderrTail: () => [...tail],
    async request(method, params, options) {
      try {
        return await client.request(
          params === undefined ? { method } : { method, params },
          AS_SENT,
          { timeout: options?.timeoutMs ?? config.timeoutMs },
        );
      } catch (err) {
        // The server answered with a JSON-RPC error: an answer, not a lost connection. Its code stays, its text is masked.
        if (err instanceof ProtocolError)
          throw new ProtocolError(err.code, clean(err.message), redact.value(err.data));
        throw await toConnectError(err);
      }
    },
    fetchForOrigin(origin) {
      const allowed = new URL(origin).origin;
      const own = target.kind !== 'stdio' && new URL(target.url).origin === allowed;
      return async (input, init) => {
        const url = new URL(input);
        if (url.origin !== allowed)
          throw new Error(
            `fetchForOrigin(${allowed}) refuses a request to another origin, ${url.origin}.`,
          );
        const headers = new Headers(init?.headers);
        if (own)
          for (const [name, value] of Object.entries(target.headers))
            if (!headers.has(name)) headers.set(name, value);
        return fetch(url, { ...init, headers, redirect: 'manual' });
      };
    },
    async raw(body, id, options) {
      const ms = options?.timeoutMs ?? config.timeoutMs;
      if (target.kind === 'sse')
        throw new ConnectError('protocol', 'Messages of its own go over stdio and Streamable HTTP only, not HTTP+SSE.', []);
      journal.write('out', { raw: body });
      const noAnswer = () => new ConnectError('timeout', `${LEAD.timeout[0]}.`, [...tail]);

      const sent = parsed(body) as { id?: unknown; method?: unknown } | undefined;
      if (typeof sent?.method === 'string' && sent.id !== undefined) methods.set(sent.id, sent.method);

      if (target.kind === 'stdio') {
        const stdin = (transport as unknown as { _process?: { stdin?: Writable | null } })._process?.stdin;
        if (stdin === null || stdin === undefined || stdin.writableEnded)
          throw spawnError !== undefined
            ? await toConnectError(spawnError)
            : new ConnectError('exited-early', `${LEAD['exited-early'][0]}.`, [...tail]);
        return new Promise<RawReply>((resolve, reject) => {
          const done = () => {
            clearTimeout(timer);
            listeners.delete(listener);
            stopped.delete(stop);
          };
          const timer = setTimeout(() => {
            done();
            reject(noAnswer());
          }, ms);
          const listener = (line: string) => {
            const frame = parsed(line);
            if (!answers(frame, id)) return;
            done();
            resolve({ frame, text: clean(line).slice(0, RAW_TEXT) });
          };
          // The process went away (or never started) while this waited: say why now, not after the time is out.
          const stop = () => {
            done();
            void toConnectError(spawnError ?? new Error('closed')).then(reject);
          };
          listeners.add(listener);
          stopped.add(stop);
          stdin.write(`${body}\n`);
        });
      }

      // The headers the transport sends: --header, and the session and protocol version the handshake gave.
      const state = transport as unknown as { sessionId?: string; _protocolVersion?: string };
      const headers = new Headers(target.headers);
      headers.set('content-type', 'application/json');
      headers.set('accept', 'application/json, text/event-stream');
      if (state.sessionId !== undefined) headers.set('mcp-session-id', state.sessionId);
      if (state._protocolVersion !== undefined) headers.set('mcp-protocol-version', state._protocolVersion);
      if (modern !== undefined) for (const [name, value] of modernHeaders(body, modern.version)) headers.set(name, value);
      for (const [name, value] of options?.headers ?? []) {
        if (value === null) headers.delete(name);
        else headers.set(name, value);
      }
      const lost = async (err: unknown) =>
        (err as Error | undefined)?.name === 'TimeoutError' ? noAnswer() : toConnectError(err);
      let text = '';
      let frame: Record<string, unknown> | undefined;
      let status: number;
      try {
        const res = await fetch(target.url, {
          method: 'POST',
          headers,
          body,
          redirect: 'manual',
          signal: AbortSignal.timeout(ms),
        });
        status = res.status;
        const sse = (res.headers.get('content-type') ?? '').includes('text/event-stream');
        if (res.body !== null) {
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          // An SSE answer is read up to the event that answers; a stream the server keeps open is not waited out.
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            text += decoder.decode(value, { stream: true });
            if (sse && (frame = fromEventStream(text, id)) !== undefined) break;
            if (text.length > STDIO_MESSAGE_LIMIT) break;
          }
          await reader.cancel().catch(() => {});
        }
        if (!sse) {
          const whole = parsed(text);
          // One POST, one answer: kept whatever its id, so an answer under the wrong id is seen, not waited for.
          if (whole !== null && typeof whole === 'object' && !Array.isArray(whole))
            frame = whole as Record<string, unknown>;
          heard(frame);
        } else
          for (const line of text.split(/\r?\n/)) if (line.startsWith('data:')) heard(parsed(line.slice(5).trim()));
      } catch (err) {
        throw await lost(err);
      }
      journal.write('in', frame !== undefined ? { frame } : { status, raw: clean(text).slice(0, RAW_TEXT) });
      return { frame, status, text: clean(text).slice(0, RAW_TEXT) };
    },
    async notify(body) {
      if (target.kind !== 'stdio')
        throw new ConnectError('protocol', 'notify is for a stdio server.', []);
      const stdin = (transport as unknown as { _process?: { stdin?: Writable | null } })._process?.stdin;
      if (stdin === null || stdin === undefined || stdin.writableEnded)
        throw spawnError !== undefined
          ? await toConnectError(spawnError)
          : new ConnectError('exited-early', `${LEAD['exited-early'][0]}.`, [...tail]);
      journal.write('out', { raw: body });
      stdin.write(`${body}
`);
    },
    traffic: () => traffic,
    stdoutNoise: () => ({ count: noise.count, first: [...noise.first] }),
    notified: (method) => notifications.get(method) ?? 0,
    async endInput(waitMs) {
      const proc = (transport as unknown as { _process?: ChildProcess })._process;
      if (proc === undefined) return true;
      if (proc.exitCode !== null || proc.signalCode !== null) return true;
      const exited = new Promise<boolean>((resolve) => proc.once('exit', () => resolve(true)));
      proc.stdin?.end();
      let timer: NodeJS.Timeout | undefined;
      const late = new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), waitMs)));
      const result = await Promise.race([exited, late]);
      clearTimeout(timer);
      return result;
    },
    close: closable.close,
  };
}
