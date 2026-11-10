// `plune mcp serve` as a real process (dist/cli.cjs) over real stdio, from both protocol eras.
// The in-memory tests in server.test.ts never see stdout, the process exit or the opening exchange; these do.
// Run with `pnpm test:e2e` (it builds first).
//
// Two clients:
// - legacy (2025-11-25, `initialize` handshake): the SDK 1.x Client (a dev dependency kept for exactly this);
// - modern (2026-07-28, per-request `_meta`, no handshake): a few lines of JSON written to stdin by hand,
//   shaped after the specification text, not after any SDK, so the check is against the spec:
//   https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio
//   https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning
//   https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/subscriptions
//   https://modelcontextprotocol.io/specification/2026-07-28/schema
//
// Measured on the dual-era transport (@modelcontextprotocol/server 2.4.0, serveStdio):
//
// | request (stdio)                                       | server answer                                                  |
// |-------------------------------------------------------|----------------------------------------------------------------|
// | `server/discover` with modern `_meta`, first message  | DiscoverResult: supportedVersions ["2026-07-28"], ttlMs 0      |
// | `tools/list` with modern `_meta`                      | resultType "complete", ttlMs 0, cacheScope "private"           |
// | modern request naming version 1900-01-01              | -32022, data.supported / data.requested                        |
// | `subscriptions/listen` {toolsListChanged}             | acknowledged, stamped subscriptionId                           |
// | `tools/call` plune_discover_tools, then `tools/list`  | the same list; no list_changed; a hidden tool runs by its name |
// | `initialize` with protocolVersion 2025-11-25          | result, protocolVersion 2025-11-25                             |
// | `initialize` with protocolVersion 1900-01-01          | result, protocolVersion 2025-11-25 (the server's latest)       |
// | stdin closed                                          | process exits with code 0 well under a second                  |
//
// Before the move (SDK 1.x transport) `server/discover` got -32601 «Method not found» and a modern request was served
// under legacy rules. The compatibility matrix below is today's truth; a change in the server turns it red until the
// row is rewritten on purpose.

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_VISIBLE_TOOLS, defaultVisibleTools } from '../../mcp-tools/index.js';

const here = path.dirname(fileURLToPath(import.meta.url)); // src/mcp/__tests__
const root = path.resolve(here, '..', '..', '..');
const cli = path.join(root, 'dist', 'cli.cjs');

/** Made up; it must never come back out of the process (AC-4). */
const TOKEN = 'plt_e2e_never_printed_7f3a9c';
const LEGACY = '2025-11-25';
const MODERN = '2026-07-28';
/** Past this the SDK 1.x client stops waiting for a clean exit and sends SIGTERM, so a slower exit is a hang. */
const EXIT_BUDGET_MS = 2000;
/** A server that says nothing within this is «could not determine», never «works». */
const ANSWER_TIMEOUT_MS = 5000;

// ---------------------------------------------------------------------------------------------------------
// The platform: a stub on localhost that answers the reads plune_project_context makes.

let platform: http.Server;
let apiUrl = '';
const seenAuth: string[] = [];

beforeAll(async () => {
  if (!fs.existsSync(cli)) throw new Error('dist/cli.cjs not found — run `pnpm test:e2e` (it builds first), not plain vitest.');
  platform = http.createServer((req, res) => {
    seenAuth.push(String(req.headers.authorization ?? ''));
    const p = new URL(req.url ?? '/', 'http://x').pathname;
    const body: Record<string, unknown> =
      p === '/v1/projects' ? { projects: [{ id: 'p1', name: 'John Doe shop' }] }
      : p === '/v1/test-cases' ? { cases: [], total: 3 }
      : p === '/v1/runs/missing' ? { error: 'not found' }
      : { suites: [], missions: [], items: [] };
    res.writeHead(p === '/v1/runs/missing' ? 404 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => platform.listen(0, '127.0.0.1', resolve));
  apiUrl = `http://127.0.0.1:${(platform.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => platform.close(() => resolve()));
});

/** The process environment: our token and stub, nothing this machine happens to have exported for Plune. */
function serveEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('PLUNE_')) env[k] = v;
  return { ...env, PLUNE_TOKEN: TOKEN, PLUNE_API_URL: apiUrl, ...extra };
}

// ---------------------------------------------------------------------------------------------------------
// The modern client: JSON lines on stdin, JSON lines from stdout. Nothing else.

type Message = { jsonrpc?: string; id?: number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: { code: number; message: string } };

interface RawServe {
  send(msg: Record<string, unknown>): void;
  /** Write these bytes to stdin as they are (a broken message). */
  raw(text: string): void;
  /** The response with this id, or 'timeout' when the server stays silent. */
  answer(id: number, timeoutMs?: number): Promise<Message | 'timeout'>;
  /** Close stdin, wait for the exit. `ms` is null when it did not exit within the budget (then it is killed). */
  end(): Promise<{ code: number | null; ms: number | null }>;
  stdout(): string;
  stderr(): string;
  messages(): Message[];
}

function spawnServe(env = serveEnv(), args: string[] = []): RawServe {
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [cli, 'mcp', 'serve', ...args], { env });
  let out = '';
  let err = '';
  let buffered = '';
  const got: Message[] = [];
  const waiters: (() => void)[] = [];
  child.stdout.setEncoding('utf8').on('data', (d: string) => {
    out += d;
    buffered += d;
    let nl: number;
    while ((nl = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, nl);
      buffered = buffered.slice(nl + 1);
      try {
        got.push(JSON.parse(line) as Message);
      } catch {
        // not protocol; the stdout test reads `out` and fails on it
      }
    }
    for (const w of waiters.splice(0)) w();
  });
  child.stderr.setEncoding('utf8').on('data', (d: string) => (err += d));
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));

  return {
    send: (msg) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`),
    raw: (text) => child.stdin.write(text),
    answer: (id, timeoutMs = ANSWER_TIMEOUT_MS) =>
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve('timeout'), timeoutMs);
        const check = () => {
          const m = got.find((g) => g.id === id && (g.result !== undefined || g.error !== undefined));
          if (m) {
            clearTimeout(timer);
            resolve(m);
          } else waiters.push(check);
        };
        check();
      }),
    async end() {
      const started = Date.now();
      child.stdin.end();
      const code = await Promise.race([exited, new Promise<'late'>((r) => setTimeout(() => r('late'), EXIT_BUDGET_MS))]);
      if (code === 'late') {
        child.kill();
        return { code: null, ms: null };
      }
      return { code, ms: Date.now() - started };
    },
    stdout: () => out,
    stderr: () => err,
    messages: () => got,
  };
}

/** `_meta` every 2026-07-28 request carries (RequestMetaObject: version and capabilities are required). */
const modernMeta = (version = MODERN) => ({
  'io.modelcontextprotocol/protocolVersion': version,
  'io.modelcontextprotocol/clientCapabilities': {},
  'io.modelcontextprotocol/clientInfo': { name: 'plune-e2e-modern', version: '1' },
});

// ---------------------------------------------------------------------------------------------------------
// The matrix (AC-3). How a client of each era judges the server, by the spec's own rules.

type Outcome = 'works' | 'refused' | 'could-not-run';

/** A legacy client: `initialize` at its revision, then `tools/list`. */
async function legacyClientOutcome(): Promise<{ outcome: Outcome; evidence: unknown }> {
  const s = spawnServe();
  try {
    s.send({ id: 1, method: 'initialize', params: { protocolVersion: LEGACY, capabilities: {}, clientInfo: { name: 'plune-e2e-legacy', version: '1' } } });
    const init = await s.answer(1);
    if (init === 'timeout') return { outcome: 'could-not-run', evidence: 'no answer to initialize' };
    if (init.error || init.result?.['protocolVersion'] !== LEGACY) return { outcome: 'refused', evidence: init };
    s.send({ method: 'notifications/initialized' });
    s.send({ id: 2, method: 'tools/list', params: {} });
    const list = await s.answer(2);
    if (list === 'timeout') return { outcome: 'could-not-run', evidence: 'no answer to tools/list' };
    const tools = list.result?.['tools'];
    return Array.isArray(tools) && tools.length > 0 ? { outcome: 'works', evidence: tools.length } : { outcome: 'refused', evidence: list };
  } finally {
    await s.end();
  }
}

/**
 * A modern-only client: probes with `server/discover` first (stdio, Backward Compatibility: «probing is still
 * RECOMMENDED»), and goes on only on a `DiscoverResult` that lists its version; then `tools/list` must come back
 * as a 2026-07-28 result (`resultType`, `ttlMs`, `cacheScope`).
 */
async function modernClientOutcome(): Promise<{ outcome: Outcome; evidence: unknown }> {
  const s = spawnServe();
  try {
    s.send({ id: 1, method: 'server/discover', params: { _meta: modernMeta() } });
    const discover = await s.answer(1);
    if (discover === 'timeout') return { outcome: 'could-not-run', evidence: 'no answer to server/discover' };
    const versions = discover.result?.['supportedVersions'];
    if (discover.error || !Array.isArray(versions) || !versions.includes(MODERN)) return { outcome: 'refused', evidence: discover.error ?? discover.result };
    s.send({ id: 2, method: 'tools/list', params: { _meta: modernMeta() } });
    const list = await s.answer(2);
    if (list === 'timeout') return { outcome: 'could-not-run', evidence: 'no answer to tools/list' };
    const r = list.result ?? {};
    const modern = typeof r['resultType'] === 'string' && typeof r['ttlMs'] === 'number' && typeof r['cacheScope'] === 'string';
    return modern && Array.isArray(r['tools']) ? { outcome: 'works', evidence: (r['tools'] as unknown[]).length } : { outcome: 'refused', evidence: list };
  } finally {
    await s.end();
  }
}

const COMPATIBILITY: { client: string; run: () => Promise<{ outcome: Outcome; evidence: unknown }>; expected: Outcome; answer?: unknown }[] = [
  { client: `legacy ${LEGACY} (initialize)`, run: legacyClientOutcome, expected: 'works', answer: defaultVisibleTools('write').length },
  // Before the move to a dual-era transport this row was 'refused' with -32601 «Method not found».
  { client: `modern ${MODERN} (server/discover probe)`, run: modernClientOutcome, expected: 'works', answer: defaultVisibleTools('write').length },
];

describe('CLI · mcp serve · compatibility matrix by client era', () => {
  for (const row of COMPATIBILITY) {
    it(`CLI · mcp serve · ${row.client} → ${row.expected}`, async () => {
      const { outcome, evidence } = await row.run();
      expect({ outcome, evidence: row.answer === undefined ? undefined : evidence }).toEqual({ outcome: row.expected, evidence: row.answer });
    });
  }
});

// ---------------------------------------------------------------------------------------------------------
// AC-1: the legacy client is the SDK's own, over a real process.

describe('CLI · mcp serve · legacy client (SDK 1.x, 2025-11-25)', () => {
  it('CLI · mcp serve · initialize, list, a platform call, discover_tools, a longer list, exit on stdin close', async () => {
    const transport = new StdioClientTransport({ command: process.execPath, args: [cli, 'mcp', 'serve'], env: serveEnv(), stderr: 'pipe' });
    let stderr = '';
    transport.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
    const client = new Client({ name: 'plune-e2e-legacy', version: '1' });
    let listChanged = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      listChanged++;
    });
    await client.connect(transport);
    try {
      expect(client.getServerVersion()?.name).toBe('plune');

      const before = (await client.listTools()).tools.map((t) => t.name);
      expect(before).toEqual(defaultVisibleTools('write'));

      const ctx = await client.callTool({ name: 'plune_project_context', arguments: {} });
      expect(ctx.isError).toBeFalsy();
      expect(ctx.structuredContent).toMatchObject({ projectId: 'p1', cases: { total: 3 } });
      expect(seenAuth).toContain(`Bearer ${TOKEN}`);

      const reveal = ['plune_cases_update', 'plune_run_create', 'plune_results_write'];
      const r = await client.callTool({ name: 'plune_discover_tools', arguments: { names: reveal } });
      expect(r.isError).toBeFalsy();
      const after = (await client.listTools()).tools.map((t) => t.name);
      expect(after).toHaveLength(MAX_VISIBLE_TOOLS);
      expect(after).toEqual([...before, ...reveal]);
      expect(listChanged).toBeGreaterThan(0);
    } finally {
      const started = Date.now();
      await client.close();
      // close() ends stdin and escalates to SIGTERM only after EXIT_BUDGET_MS; quicker means the server left on its own.
      expect(Date.now() - started).toBeLessThan(EXIT_BUDGET_MS);
    }
    expect(stderr).not.toContain(TOKEN);
  });
});

// ---------------------------------------------------------------------------------------------------------
// AC-2: the modern client by hand, and what the server actually answers.

describe('CLI · mcp serve · modern client (2026-07-28, JSON lines)', () => {
  const names = (m: Message) => ((m.result?.['tools'] as { name: string }[] | undefined) ?? []).map((t) => t.name);
  const subscriptionOf = (m: Message) => (m.params?.['_meta'] as Record<string, unknown> | undefined)?.['io.modelcontextprotocol/subscriptionId'];

  it('CLI · mcp serve · server/discover as the first message returns a DiscoverResult naming 2026-07-28', async () => {
    const s = spawnServe();
    s.send({ id: 1, method: 'server/discover', params: { _meta: modernMeta() } });
    const a = await s.answer(1);
    await s.end();
    if (a === 'timeout') throw new Error('no answer to server/discover');
    expect(a.error).toBeUndefined();
    expect(a.result).toMatchObject({ resultType: 'complete', capabilities: { tools: {} }, ttlMs: expect.any(Number), cacheScope: expect.any(String) });
    expect(a.result?.['supportedVersions']).toContain(MODERN);
  });

  it('CLI · mcp serve · a version the server does not speak is refused with -32022 and the supported list', async () => {
    const s = spawnServe();
    s.send({ id: 1, method: 'tools/list', params: { _meta: modernMeta('1900-01-01') } });
    const a = await s.answer(1);
    await s.end();
    if (a === 'timeout') throw new Error('no answer');
    expect(a.error?.code).toBe(-32022);
    expect((a.error as { data?: { supported?: string[]; requested?: string } }).data).toMatchObject({ requested: '1900-01-01', supported: expect.arrayContaining([MODERN]) });
  });

  // 2026-07-28: the set in tools/list «MUST NOT vary per-connection or as a side effect of other requests on the connection»
  // (https://modelcontextprotocol.io/specification/2026-07-28/server/tools). discover_tools describes, a hidden tool is
  // called by its name, and the list stays what it was — so no list_changed, even to a client that listens.
  it('CLI · mcp serve · list, a platform call, discover_tools and a hidden tool by name; the list stays, no list_changed', async () => {
    const s = spawnServe();
    s.send({ id: 1, method: 'server/discover', params: { _meta: modernMeta() } });
    await s.answer(1);
    s.send({ id: 2, method: 'subscriptions/listen', params: { _meta: modernMeta(), notifications: { toolsListChanged: true } } });
    s.send({ id: 3, method: 'tools/list', params: { _meta: modernMeta() } });
    const list = await s.answer(3);
    s.send({ id: 4, method: 'tools/call', params: { name: 'plune_project_context', arguments: {}, _meta: modernMeta() } });
    const ctx = await s.answer(4);
    s.send({ id: 5, method: 'tools/call', params: { name: 'plune_discover_tools', arguments: { names: ['plune_run_create'] }, _meta: modernMeta() } });
    const reveal = await s.answer(5);
    s.send({ id: 6, method: 'tools/list', params: { _meta: modernMeta() } });
    const again = await s.answer(6);
    s.send({ id: 7, method: 'tools/call', params: { name: 'plune_run_create', arguments: { run: { name: 'Checkout' } }, _meta: modernMeta() } });
    const run = await s.answer(7);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await s.end();

    if (list === 'timeout' || ctx === 'timeout' || reveal === 'timeout' || again === 'timeout' || run === 'timeout') throw new Error('the server stayed silent');
    expect(list.result).toMatchObject({ resultType: 'complete', ttlMs: 0 });
    expect(names(list)).toEqual(defaultVisibleTools('write'));
    expect(ctx.result).toMatchObject({ resultType: 'complete', structuredContent: { projectId: 'p1', cases: { total: 3 } } });
    expect(ctx.result?.['isError']).toBeFalsy();
    expect(reveal.result?.['isError']).toBeFalsy();
    const described = (reveal.result?.['structuredContent'] as { available: { name: string; inputSchema?: { type?: string } }[] }).available;
    expect(described.find((t) => t.name === 'plune_run_create')?.inputSchema?.type).toBe('object');
    expect(again.result?.['tools']).toEqual(list.result?.['tools']);
    expect(run.error).toBeUndefined();
    expect(run.result).toMatchObject({ resultType: 'complete', structuredContent: { dryRun: false } });
    expect(run.result?.['isError']).toBeFalsy();

    const ack = s.messages().find((m) => m.method === 'notifications/subscriptions/acknowledged');
    expect(ack && subscriptionOf(ack)).toBe(2);
    expect(s.messages().filter((m) => m.method === 'notifications/tools/list_changed')).toEqual([]);
  });

  it('CLI · mcp serve · without a subscription discover_tools sends nothing and the list stays', async () => {
    const s = spawnServe();
    s.send({ id: 1, method: 'tools/call', params: { name: 'plune_discover_tools', arguments: { names: ['plune_run_create'] }, _meta: modernMeta() } });
    const reveal = await s.answer(1);
    s.send({ id: 2, method: 'tools/list', params: { _meta: modernMeta() } });
    const again = await s.answer(2);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await s.end();
    if (reveal === 'timeout' || again === 'timeout') throw new Error('the server stayed silent');
    expect(names(again)).toEqual(defaultVisibleTools('write'));
    expect(s.messages().filter((m) => m.method !== undefined)).toEqual([]);
  });

  it('CLI · mcp serve · --read-only: a hidden writer called by its name is refused, and the platform is not asked', async () => {
    const s = spawnServe(serveEnv(), ['--read-only']);
    const asked = seenAuth.length;
    s.send({ id: 1, method: 'tools/list', params: { _meta: modernMeta() } });
    const list = await s.answer(1);
    s.send({ id: 2, method: 'tools/call', params: { name: 'plune_run_create', arguments: { run: { name: 'Checkout' } }, _meta: modernMeta() } });
    const run = await s.answer(2);
    await s.end();
    if (list === 'timeout' || run === 'timeout') throw new Error('the server stayed silent');
    expect(names(list)).toEqual(defaultVisibleTools('read'));
    expect(run.error?.code).toBe(-32602);
    expect(run.error?.message).toContain('plune_run_create');
    expect(seenAuth.length).toBe(asked);
  });

  it('CLI · mcp serve · initialize with an unknown version is answered with the server\'s own latest legacy revision', async () => {
    const s = spawnServe();
    s.send({ id: 1, method: 'initialize', params: { protocolVersion: '1900-01-01', capabilities: {}, clientInfo: { name: 'x', version: '1' } } });
    const a = await s.answer(1);
    await s.end();
    if (a === 'timeout') throw new Error('no answer');
    expect(a.result?.['protocolVersion']).toBe(LEGACY);
  });
});

// ---------------------------------------------------------------------------------------------------------
// AC-4: the stdio rules that hold in every era.

describe('CLI · mcp serve · stdio lifecycle', () => {
  it('CLI · mcp serve · stdout is protocol only, one message per line; stdin closed → exit 0; the token never shows', async () => {
    const s = spawnServe();
    s.send({ id: 1, method: 'server/discover', params: { _meta: modernMeta() } });
    s.send({ id: 2, method: 'initialize', params: { protocolVersion: LEGACY, capabilities: {}, clientInfo: { name: 'x', version: '1' } } });
    await s.answer(2);
    s.send({ method: 'notifications/initialized' });
    s.send({ id: 3, method: 'tools/call', params: { name: 'plune_project_context', arguments: {} } });
    s.send({ id: 4, method: 'tools/call', params: { name: 'plune_get', arguments: { kind: 'run', id: 'missing' } } });
    s.send({ id: 5, method: 'tools/list', params: {} });
    for (const id of [1, 3, 4, 5]) expect(await s.answer(id), `answer ${id}`).not.toBe('timeout');
    const exit = await s.end();

    const out = s.stdout();
    expect(out.endsWith('\n')).toBe(true);
    const lines = out.slice(0, -1).split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(5);
    for (const line of lines) {
      expect(line, 'a line of stdout').not.toMatch(/\r/);
      const msg = JSON.parse(line) as Message; // a stray print, or a message with a line break inside, throws here
      expect(msg.jsonrpc).toBe('2.0');
      expect(msg.id !== undefined || msg.method !== undefined).toBe(true);
    }
    expect(exit).toEqual({ code: 0, ms: expect.any(Number) });
    expect(out).not.toContain(TOKEN);
    expect(s.stderr()).not.toContain(TOKEN);
  });

  it('CLI · mcp serve · a broken line on stdin is reported on stderr; stdout stays protocol, the token stays out', async () => {
    const s = spawnServe();
    s.send({ id: 1, method: 'initialize', params: { protocolVersion: LEGACY, capabilities: {}, clientInfo: { name: 'x', version: '1' } } });
    await s.answer(1);
    // JSON, but not a JSON-RPC message: there is no id to answer, so the only place to say so is stderr. (A line that
    // is not JSON at all the transport skips without a word.) The token inside must not be echoed.
    s.raw(`{"jsonrpc":"2.0","token":"${TOKEN}","params":[1]}\n`);
    s.send({ id: 3, method: 'tools/list', params: {} });
    expect(await s.answer(3), 'the server still answers after the broken line').not.toBe('timeout');
    const exit = await s.end();

    expect(s.stderr().trim().length).toBeGreaterThan(0);
    expect(s.stderr()).not.toContain(TOKEN);
    for (const line of s.stdout().slice(0, -1).split('\n')) expect((JSON.parse(line) as Message).jsonrpc).toBe('2.0');
    expect(exit.code).toBe(0);
  });

  it('CLI · mcp serve · without a token the reason goes to stderr, stdout stays empty, exit 2', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'plune-mcp-'));
    try {
      const env = serveEnv({ XDG_CONFIG_HOME: empty });
      delete env['PLUNE_TOKEN'];
      const r = spawnSync(process.execPath, [cli, 'mcp', 'serve'], { env, input: '', encoding: 'utf8', timeout: 10000 });
      expect(r.status).toBe(2);
      expect(r.stdout).toBe('');
      expect(r.stderr.trim().length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});
