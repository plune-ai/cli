// The connection core against real servers: stdio processes from ./fixtures and HTTP servers on 127.0.0.1. Nothing
// here reaches past this machine. What is checked: the server is reached on each transport, what it answers comes back
// as sent, nothing secret lands in any output, no credential leaves the server's origin, and no process outlives
// close().

import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { ConnectError, openSession, closeAllSessions, type Session } from '../connect/session.js';
import {
  addConnectionOptions,
  connectionConfig,
  type ConnectConfig,
  type ConnectionFlags,
} from '../connect/options.js';
import { MCP_EXIT } from '../exit-codes.js';
import {
  recorder,
  redirectServer,
  sseServer,
  streamableServer,
  type Fixture,
} from './fixtures/http-servers.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const node = process.execPath;
const isWindows = process.platform === 'win32';

const sessions: Session[] = [];
const servers: Fixture[] = [];
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.close();
  for (const f of servers.splice(0)) await f.close();
  vi.restoreAllMocks();
});

async function open(config: ConnectConfig): Promise<Session> {
  const s = await openSession(config);
  sessions.push(s);
  return s;
}

async function serve(start: Promise<Fixture>): Promise<Fixture> {
  const f = await start;
  servers.push(f);
  return f;
}

const tmp = () => mkdtempSync(join(tmpdir(), 'plune-connect-'));

function stdio(
  file: string,
  args: string[] = [],
  env: Record<string, string> = {},
  extra: Partial<ConnectConfig> = {},
): ConnectConfig {
  return {
    target: { kind: 'stdio', command: node, args: [join(FIXTURES, file), ...args], env },
    timeoutMs: 15_000,
    ...extra,
  };
}

/** The config the flags make, as a command would build it. */
function fromFlags(argv: string[], env: NodeJS.ProcessEnv): ConnectConfig {
  let config: ConnectConfig | undefined;
  addConnectionOptions(new Command('check').exitOverride())
    .action((server: string[], flags: ConnectionFlags) => {
      config = connectionConfig(flags, server, env);
    })
    .parse(argv, { from: 'user' });
  return config!;
}

async function connectError(config: ConnectConfig): Promise<ConnectError> {
  try {
    await open(config);
  } catch (err) {
    expect(err).toBeInstanceOf(ConnectError);
    return err as ConnectError;
  }
  throw new Error('expected the connection to fail');
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitFor<T>(read: () => T | undefined, ms = 10_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > until) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 50));
  }
}

const pidsIn = (file: string) =>
  existsSync(file)
    ? (JSON.parse(readFileSync(file, 'utf8')) as { pid: number; grandchild: number })
    : undefined;

type Line = {
  ts: string;
  dtMs: number;
  dir: string;
  frame?: { method?: string; id?: number };
  line?: string;
};
const journal = (file: string): Line[] =>
  readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as Line);

const toolsOf = (result: unknown) =>
  (result as { tools: { name: string }[] }).tools.map((t) => t.name).sort();
const textOf = (result: unknown) => (result as { content: { text: string }[] }).content[0]!.text;

describe('CLI · mcp connect · stdio', () => {
  it('CLI · mcp connect · a stdio server after -- is reached and tools/list comes back (AC-1)', async () => {
    const s = await open(stdio('stdio-server.mjs'));
    expect(toolsOf(await s.request('tools/list'))).toEqual(['cwd', 'env', 'leak']);
  });

  it('CLI · mcp connect · the environment of plune does not reach the server unless --env names it (AC-6)', async () => {
    vi.stubEnv('PLUNE_TOKEN', 'plune-token-of-the-user');
    vi.stubEnv('PROVIDER_API_KEY', 'provider-key-of-the-user');
    const bare = await open(stdio('stdio-server.mjs'));
    const names = JSON.parse(
      textOf(await bare.request('tools/call', { name: 'env', arguments: {} })),
    ) as string[];
    expect(names).not.toContain('PLUNE_TOKEN');
    expect(names).not.toContain('PROVIDER_API_KEY');
    expect(names.some((n) => n.toUpperCase() === 'PATH')).toBe(true);

    const passed = await open(
      fromFlags(
        ['--env', 'PLUNE_TOKEN', '--', node, join(FIXTURES, 'stdio-server.mjs')],
        process.env,
      ),
    );
    expect(
      JSON.parse(textOf(await passed.request('tools/call', { name: 'env', arguments: {} }))),
    ).toContain('PLUNE_TOKEN');
  });

  it('CLI · mcp connect · --cwd is the working directory of the server', async () => {
    const dir = tmp();
    const s = await open(
      fromFlags(['--cwd', dir, '--', node, join(FIXTURES, 'stdio-server.mjs')], {}),
    );
    expect(JSON.parse(textOf(await s.request('tools/call', { name: 'cwd', arguments: {} })))).toBe(
      dir,
    );
  });

  it('CLI · mcp connect · inputSchema without type does not break request(): the raw result comes back (AC-10)', async () => {
    const s = await open(stdio('raw-stdio.mjs', ['loose-schema']));
    expect(await s.request('tools/list')).toEqual({
      tools: [{ name: 'odd', inputSchema: { properties: { q: {} } }, 'x-extra': 1 }],
    });
    // A JSON-RPC error is the server's answer, not a lost connection: it keeps its code.
    await expect(s.request('prompts/list')).rejects.toMatchObject({
      name: 'ProtocolError',
      code: -32601,
    });
  });

  it('CLI · mcp connect · a command that does not exist is could-not-start', async () => {
    const err = await connectError({
      target: { kind: 'stdio', command: 'plune-no-such-server-cmd', args: [], env: {} },
      timeoutMs: 10_000,
    });
    expect(err.kind).toBe('could-not-start');
    expect(err.exitCode).toBe(MCP_EXIT.usage);
  });

  it('CLI · mcp connect · a server that exits before initialize is exited-early, with the last 20 stderr lines and no home folder (AC-9)', async () => {
    const dir = tmp();
    const out = join(dir, 'frames.jsonl');
    const err = await connectError(stdio('raw-stdio.mjs', ['crash'], {}, { debugOut: out }));
    expect(err.kind).toBe('exited-early');
    expect(err.exitCode).not.toBe(0);
    expect(err.stderrTail).toHaveLength(20);
    expect(err.stderrTail[0]).toMatch(/^line 6: /);
    expect(err.stderrTail[19]).toMatch(/^line 25: /);
    expect(err.stderrTail.join('\n')).not.toContain(homedir());
    // AC-11: the journal is there after a failed connection, with the server's stderr in it.
    expect(journal(out).filter((l) => l.dir === 'stderr')).toHaveLength(25);
  });

  it('CLI · mcp connect · a server that never answers is a timeout within --timeout + 5 s (AC-9)', async () => {
    const started = Date.now();
    const err = await connectError(stdio('raw-stdio.mjs', ['silent'], {}, { timeoutMs: 1_000 }));
    expect(err.kind).toBe('timeout');
    expect(err.exitCode).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(6_000);
  });

  it('CLI · mcp connect · --debug-out holds both directions in order with a monotonic dtMs (AC-11)', async () => {
    const out = join(tmp(), 'frames.jsonl');
    const s = await open(stdio('stdio-server.mjs', [], {}, { debugOut: out }));
    await s.request('tools/list');
    await s.close();
    const lines = journal(out);
    const frames = lines.filter((l) => l.dir === 'in' || l.dir === 'out');
    expect(frames.map((l) => `${l.dir} ${l.frame?.method ?? `#${l.frame?.id}`}`)).toEqual([
      'out initialize',
      'in #0',
      'out notifications/initialized',
      'out tools/list',
      'in #1',
    ]);
    const dts = lines.map((l) => l.dtMs);
    expect([...dts].sort((a, b) => a - b)).toEqual(dts);
    expect(lines.every((l) => !Number.isNaN(Date.parse(l.ts)))).toBe(true);
  });

  // File modes are a POSIX idea; on Windows the file inherits the folder's ACL.
  it.runIf(!isWindows)(
    'CLI · mcp connect · the journal is created with mode 0600 (AC-11)',
    async () => {
      const out = join(tmp(), 'frames.jsonl');
      await connectError(stdio('raw-stdio.mjs', ['crash'], {}, { debugOut: out }));
      expect(statSync(out).mode & 0o777).toBe(0o600);
    },
  );
});

describe('CLI · mcp connect · no process outlives the session (AC-7)', () => {
  const withGrandchild = (pidFile: string, file = 'stdio-server.mjs', args: string[] = []) =>
    stdio(file, args, { FIXTURE_GRANDCHILD: '1', FIXTURE_PID_FILE: pidFile });

  it('CLI · mcp connect · close() ends the server and the grandchild it started', async () => {
    const pidFile = join(tmp(), 'pids.json');
    const s = await open(withGrandchild(pidFile));
    const { pid, grandchild } = await waitFor(() => pidsIn(pidFile));
    expect(alive(pid) && alive(grandchild)).toBe(true);
    await s.close();
    expect(alive(pid)).toBe(false);
    await waitFor(() => (alive(grandchild) ? undefined : true), 3_000);
  }, 20_000);

  it('CLI · mcp connect · close() twice, at once, closes once and leaves nothing', async () => {
    const pidFile = join(tmp(), 'pids.json');
    const s = await open(withGrandchild(pidFile));
    const { pid, grandchild } = await waitFor(() => pidsIn(pidFile));
    await Promise.all([s.close(), s.close()]);
    await s.close();
    expect(alive(pid)).toBe(false);
    await waitFor(() => (alive(grandchild) ? undefined : true), 3_000);
  }, 20_000);

  it('CLI · mcp connect · closing while the server is still connecting leaves no process and fails the open', async () => {
    const pidFile = join(tmp(), 'pids.json');
    const opening = openSession(withGrandchild(pidFile, 'raw-stdio.mjs', ['silent']));
    const { pid, grandchild } = await waitFor(() => pidsIn(pidFile));
    await closeAllSessions();
    await expect(opening).rejects.toThrow(/closed/);
    expect(alive(pid)).toBe(false);
    await waitFor(() => (alive(grandchild) ? undefined : true), 3_000);
  }, 20_000);
});

describe('CLI · mcp connect · HTTP', () => {
  it('CLI · mcp connect · --url reaches a Streamable HTTP server (AC-1)', async () => {
    const f = await serve(streamableServer());
    const s = await open({
      target: { kind: 'http', url: `${f.origin}/mcp`, headers: {} },
      timeoutMs: 10_000,
    });
    expect(toolsOf(await s.request('tools/list'))).toEqual(['whoami']);
  });

  it('CLI · mcp connect · --url with --sse reaches a server on the older SSE transport (AC-1)', async () => {
    const f = await serve(sseServer());
    const s = await open({
      target: { kind: 'sse', url: `${f.origin}/sse`, headers: { 'X-Api-Key': 'sse-key-1234' } },
      timeoutMs: 10_000,
    });
    expect(toolsOf(await s.request('tools/list'))).toEqual(['whoami']);
    expect(
      f.requests.filter((r) => r.headers['x-api-key'] === 'sse-key-1234').length,
    ).toBeGreaterThan(1);
  });

  it('CLI · mcp connect · a server nobody listens on is network', async () => {
    const f = await serve(recorder());
    const url = `${f.origin}/mcp`;
    await f.close();
    servers.pop();
    const err = await connectError({
      target: { kind: 'http', url, headers: {} },
      timeoutMs: 5_000,
    });
    expect(err.kind).toBe('network');
  });

  it('CLI · mcp connect · over SSE, a server nobody listens on is network and a 401 is auth', async () => {
    const gone = await serve(recorder());
    const url = `${gone.origin}/sse`;
    await gone.close();
    servers.pop();
    expect(
      (await connectError({ target: { kind: 'sse', url, headers: {} }, timeoutMs: 5_000 })).kind,
    ).toBe('network');

    const guarded = await serve(streamableServer({ token: 'the-right-token' }));
    const err = await connectError({
      target: {
        kind: 'sse',
        url: `${guarded.origin}/sse`,
        headers: { Authorization: 'Bearer wrong-token-value' },
      },
      timeoutMs: 5_000,
    });
    expect(err.kind).toBe('auth');
  });

  it('CLI · mcp connect · a 401 is auth, and the credential the server repeats in its body does not leak', async () => {
    const f = await serve(streamableServer({ token: 'the-right-token' }));
    const err = await connectError({
      target: {
        kind: 'http',
        url: `${f.origin}/mcp`,
        headers: { Authorization: 'Bearer wrong-token-value' },
      },
      timeoutMs: 5_000,
    });
    expect(err.kind).toBe('auth');
    expect(`${err.message}${err.stderrTail.join('')}`).not.toContain('wrong-token-value');
  });
});

describe('CLI · mcp connect · secrets do not reach any output (AC-3)', () => {
  const SECRETS = ['bearer-token-value-1', 'header-env-value-2', 'api-token-value-3'] as const;

  function capture() {
    const written: string[] = [];
    for (const stream of [process.stdout, process.stderr]) {
      vi.spyOn(stream, 'write').mockImplementation((chunk: string | Uint8Array) => {
        written.push(String(chunk));
        return true;
      });
    }
    return written;
  }

  function expectNoSecret(bytes: string) {
    for (const secret of SECRETS) expect(bytes).not.toContain(secret);
  }

  it('CLI · mcp connect · a server repeating the token in its error leaks nothing into --debug-out, stderr or stdout', async () => {
    const f = await serve(streamableServer({ token: SECRETS[0] }));
    const out = join(tmp(), 'frames.jsonl');
    const written = capture();
    const config = fromFlags(
      [
        '--url',
        `${f.origin}/mcp`,
        '--header',
        `Authorization: Bearer ${SECRETS[0]}`,
        '--header-env',
        'X-Api-Key=FIXTURE_KEY',
        '--debug-out',
        out,
      ],
      { FIXTURE_KEY: SECRETS[1] },
    );
    const s = await open(config);
    const result = await s.request('tools/call', { name: 'whoami', arguments: {} });
    // The raw answer is the server's, unmasked (a command masks before it prints) …
    expect(JSON.stringify(result)).toContain(SECRETS[0]);
    // … and the session's redactor is how it does that.
    expectNoSecret(s.redact.text(JSON.stringify(result)));
    await s.close();
    const bytes = readFileSync(out, 'utf8');
    expect(bytes).toContain('whoami');
    expectNoSecret(bytes);
    expectNoSecret(written.join(''));
  });

  it('CLI · mcp connect · API_TOKEN from --env in stderr and in a tool error leaks nothing', async () => {
    const out = join(tmp(), 'frames.jsonl');
    const written = capture();
    const config = fromFlags(
      [
        '--env',
        `API_TOKEN=${SECRETS[2]}`,
        '--debug-out',
        out,
        '--',
        node,
        join(FIXTURES, 'stdio-server.mjs'),
      ],
      {},
    );
    const s = await open(config);
    const result = await s.request('tools/call', { name: 'leak', arguments: {} });
    expect(JSON.stringify(result)).toContain(SECRETS[2]);
    await s.close();
    const bytes = readFileSync(out, 'utf8');
    expect(bytes).toContain('starting with API_TOKEN=***');
    expect(bytes).toContain('"API_TOKEN":"***"');
    expectNoSecret(bytes);
    expectNoSecret(written.join(''));
  });
});

describe('CLI · mcp connect · credentials stay on the server origin (AC-5)', () => {
  it('CLI · mcp connect · a redirect to another origin is not followed and carries no header there', async () => {
    const foreign = await serve(recorder());
    const redirecting = await serve(redirectServer(foreign.origin));
    const err = await connectError({
      target: {
        kind: 'http',
        url: `${redirecting.origin}/mcp`,
        headers: { 'X-Api-Key': 'redirect-key-123', Authorization: 'Bearer redirect-tok-1' },
      },
      timeoutMs: 5_000,
    });
    expect(err.kind).toBe('network');
    expect(err.message).toMatch(/redirect/i);
    expect(err.message).toMatch(/not followed/i);
    expect(foreign.requests).toEqual([]);
    expect(redirecting.requests.length).toBeGreaterThan(0);
  });

  it('CLI · mcp connect · fetchForOrigin adds the headers on the server origin only', async () => {
    const server = await serve(streamableServer());
    const foreign = await serve(recorder());
    const s = await open({
      target: {
        kind: 'http',
        url: `${server.origin}/mcp`,
        headers: { 'X-Api-Key': 'origin-key-123' },
      },
      timeoutMs: 10_000,
    });

    await s.fetchForOrigin(foreign.origin)(
      `${foreign.origin}/.well-known/oauth-protected-resource`,
    );
    expect(foreign.requests).toHaveLength(1);
    expect(foreign.requests[0]!.headers['x-api-key']).toBeUndefined();

    const before = server.requests.length;
    await s.fetchForOrigin(server.origin)(`${server.origin}/.well-known/oauth-protected-resource`);
    expect(server.requests[before]!.headers['x-api-key']).toBe('origin-key-123');

    await expect(s.fetchForOrigin(server.origin)(`${foreign.origin}/x`)).rejects.toThrow(/origin/);
  });
});
