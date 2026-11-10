import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
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
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
  /**
   * A fetch for requests the session makes besides MCP (discovery, later OAuth). It refuses a URL outside `origin`,
   * adds the `--header` values only when `origin` is the server's own, and follows no redirect.
   */
  fetchForOrigin(origin: string): (input: string | URL, init?: RequestInit) => Promise<Response>;
  /** Ends the connection and every process it started. A second call returns the first one's promise. */
  close(): Promise<void>;
}

const TAIL_LINES = 20;

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
  on: { error: (err: Error) => void; closed: () => void },
): void {
  const send = transport.send.bind(transport);
  transport.send = (message, options) => {
    journal.write('out', { frame: message });
    return send(message, options);
  };
  const logged = new WeakSet<object>();
  intercept(transport, 'onmessage', (message: object) => {
    if (logged.has(message)) return;
    logged.add(message);
    journal.write('in', { frame: message });
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
 * keeps the process to itself; it is reached after start, before any output can have arrived.
 */
function watchStdout(transport: StdioClientTransport, journal: Journal): void {
  const start = transport.start.bind(transport);
  transport.start = async () => {
    await start();
    const stdout = (transport as unknown as { _process?: { stdout?: Readable | null } })._process
      ?.stdout;
    if (stdout === null || stdout === undefined) return;
    createInterface({ input: stdout, crlfDelay: Infinity }).on('line', (line) => {
      if (!isJsonRpc(line)) journal.write('noise', { line });
    });
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
  timeout: ['The server did not answer within --timeout', false],
  protocol: ['The server did not answer as an MCP server', true],
  auth: ['The server refused the credentials', true],
  network: ['Could not reach the server', true],
};

export async function openSession(config: ConnectConfig): Promise<Session> {
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
  tap(transport, journal, {
    closed: () => (transportClosed = true),
    error: (err) => {
      if (
        spawnError === undefined &&
        (err as NodeJS.ErrnoException).syscall?.startsWith('spawn') === true
      )
        spawnError = err;
    },
  });

  const tail: string[] = [];
  let stderrDone: Promise<void> = Promise.resolve();
  if (transport instanceof StdioClientTransport && transport.stderr !== null) {
    const lines = createInterface({ input: transport.stderr as Readable, crlfDelay: Infinity });
    lines.on('line', (line) => {
      journal.write('stderr', { line });
      tail.push(clean(line));
      if (tail.length > TAIL_LINES) tail.shift();
    });
    stderrDone = new Promise((resolve) => lines.once('close', resolve));
    watchStdout(transport, journal);
  }

  const toConnectError = async (err: unknown): Promise<ConnectError> => {
    // The process may have said why it stopped; let the last of its stderr arrive (bounded: a helper can hold it open).
    if (transportClosed) await Promise.race([stderrDone, new Promise((r) => setTimeout(r, 500))]);
    const cause = spawnError ?? err;
    const kind = kindOf(cause, stdio, transportClosed);
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

  const serverPid = () => (transport instanceof StdioClientTransport ? transport.pid : null);
  let closing: Promise<void> | undefined;
  // What a close noted: the SDK forgets the process as soon as its close begins, and killNow may still need it.
  let noted: { pid: number; tree: Proc[] } | undefined;
  const shutdown = async () => {
    // Note the descendants while the server is alive to name them: once it is gone, nothing points at them.
    const pid = serverPid();
    if (pid !== null) noted = { pid, tree: descendantsOf(pid) };
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
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      client.connect(transport, { timeout: config.timeoutMs }),
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

  return {
    redact,
    async request(method, params) {
      try {
        return await client.request(
          params === undefined ? { method } : { method, params },
          AS_SENT,
          { timeout: config.timeoutMs },
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
    close: closable.close,
  };
}
