// `plune mcp scan --active`: the probes that need a server to answer. Every server here is on this machine: a fixture
// that keeps what it is told (strict) and one that keeps nothing (lax), each recording what reached it, so a test can
// say what was sent and what was not. The tokens are made-up strings.

import { execSync } from 'node:child_process';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { handleMcpScan, type McpScanFlags } from '../../cli/commands/mcp-scan.js';
import { ProbeGuard, canonical, type Frame, type Reply } from '../scan/probes/guard.js';
import { MAX_PROBE_FILE_BYTES, parseProbeFile } from '../scan/probes/file.js';
import { runProbes } from '../scan/probes/runner.js';
import { renderScan } from '../scan/report.js';
import { ALL_RULES, runScan, type ScanInput } from '../scan/run.js';
import type { ProbeEntry } from '../scan/probes/types.js';
import { buildSnapshot, serializeSnapshot } from '../snapshot/index.js';

const MARK = 'zq7+/Tok=41';
const TOKEN_A = `tokA-${MARK}-a`;
const TOKEN_B = `tokB-${MARK}-b`;
const ARG_MARK = 'ARG-VALUE-MARKER-83';

interface Seen {
  method: string;
  path: string;
  auth: string | undefined;
  rpc: string | undefined;
  tool: string | undefined;
}
interface Opts {
  /** Every token is accepted, and every call runs. */
  lax?: boolean;
  tools?: { name: string; annotations?: Record<string, unknown> }[];
  /** The WWW-Authenticate challenge names this URL as the place of the metadata. */
  challengeUrl?: string;
  /** Every POST is answered with this status (a number) or a redirect to this location (a string). */
  force?: number | string;
  /** The connection is cut for every request. */
  cut?: boolean;
  /** This method is answered with a JSON-RPC error, for everyone. */
  rpcError?: string;
  /** Every tools/call is answered with a result that has isError: true. */
  isErrorForAll?: boolean;
  /** This method is answered 200 with an id and neither result nor error (or, with bareResult, a result that is text). */
  bare?: string;
  bareFor?: 'a' | 'b';
  bareResult?: 'text';
  /** Every request is answered 401, whatever the token. */
  denyAll?: boolean;
  /** The status of the redirect of `force` (302 by default). */
  redirectStatus?: number;
  host?: string;
  /** A tools/call with no `doc` argument is answered with this text, as an isError result or a JSON-RPC error. */
  errorText?: string;
  errorAs?: 'rpc' | 'isError';
}
interface Fixture {
  url: string;
  port: number;
  seen: Seen[];
  calls: () => number;
  close(): Promise<void>;
}

const servers: Fixture[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

const TOOLS = [
  { name: 'export', annotations: { readOnlyHint: true } },
  { name: 'wipe', annotations: { destructiveHint: true } },
];

async function fixture(opts: Opts = {}): Promise<Fixture> {
  const seen: Seen[] = [];
  const tools = opts.tools ?? TOOLS;
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const text = Buffer.concat(chunks).toString('utf8');
    let body: {
      id?: number;
      method?: string;
      params?: { name?: string; arguments?: Record<string, unknown> };
    } = {};
    try {
      body = JSON.parse(text);
    } catch {
      /* a GET */
    }
    seen.push({
      method: req.method ?? '',
      path: req.url ?? '',
      auth: req.headers['authorization'],
      rpc: body.method,
      tool: body.params?.name,
    });
    if (opts.cut === true) return void req.socket.destroy();
    if (req.method === 'GET') return void res.writeHead(404).end();
    if (typeof opts.force === 'number') return void res.writeHead(opts.force).end('overloaded');
    if (typeof opts.force === 'string')
      return void res.writeHead(opts.redirectStatus ?? 302, { Location: opts.force }).end();
    const bearer = /^Bearer (.+)$/.exec(req.headers['authorization'] ?? '')?.[1];
    const who = bearer === TOKEN_A ? 'a' : bearer === TOKEN_B ? 'b' : undefined;
    if (opts.lax !== true && who === undefined) {
      const challenge =
        opts.challengeUrl === undefined
          ? 'Bearer'
          : `Bearer resource_metadata="${opts.challengeUrl}"`;
      return void res
        .writeHead(401, { 'WWW-Authenticate': challenge })
        .end(JSON.stringify({ error: `bad token ${bearer ?? ''}` }));
    }
    if (opts.denyAll === true)
      return void res.writeHead(401, { 'WWW-Authenticate': 'Bearer' }).end();
    if (opts.bare === body.method && (opts.bareFor === undefined || opts.bareFor === who))
      return void res
        .writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 's1' })
        .end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            ...(opts.bareResult === 'text' ? { result: 'text' } : {}),
          }),
        );
    const reply = (result: unknown) =>
      res
        .writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 's1' })
        .end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
    if (opts.rpcError !== undefined && body.method === opts.rpcError)
      return void res.writeHead(200, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          error: { code: -32603, message: 'internal' },
        }),
      );
    if (body.method === 'initialize')
      return reply({
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'f', version: '1' },
      });
    if (body.method === 'notifications/initialized') return void res.writeHead(202).end();
    if (body.method === 'tools/list') return reply({ tools });
    if (
      body.method === 'tools/call' &&
      opts.errorText !== undefined &&
      body.params?.arguments?.['doc'] === undefined
    ) {
      if (opts.errorAs === 'rpc')
        return void res.writeHead(200, { 'Content-Type': 'application/json' }).end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            error: { code: -32602, message: opts.errorText, data: { detail: opts.errorText } },
          }),
        );
      return reply({ isError: true, content: [{ type: 'text', text: opts.errorText }] });
    }
    if (body.method === 'tools/call') {
      // Strict: account B may not read an object of account A.
      const doc = body.params?.arguments?.['doc'];
      if (opts.isErrorForAll === true || (opts.lax !== true && who === 'b' && doc === 'doc-a'))
        return reply({ isError: true, content: [{ type: 'text', text: `forbidden ${bearer}` }] });
      return reply({
        content: [{ type: 'text', text: `ran ${body.params?.name} ${bearer ?? ''} ${ARG_MARK}` }],
      });
    }
    res.writeHead(400).end();
  };
  const server: Server = createServer((req, res) => void handle(req, res));
  await new Promise<void>((resolve) => server.listen(0, opts.host ?? '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const f: Fixture = {
    url: `http://127.0.0.1:${port}/mcp`,
    port,
    seen,
    calls: () => seen.filter((s) => s.rpc === 'tools/call').length,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  servers.push(f);
  return f;
}

const tmp = () => mkdtempSync(join(tmpdir(), 'plune-probes-'));
function probeFile(entries: unknown[]): { dir: string; file: string } {
  const dir = tmp();
  writeFileSync(join(dir, 'probes.json'), JSON.stringify({ probes: entries }));
  return { dir, file: 'probes.json' };
}
const entry = (id: string, as: string, extra: Record<string, unknown> = {}) => ({
  id,
  tool: 'export',
  arguments: { doc: 'doc-a', note: ARG_MARK },
  as,
  ...extra,
});

interface Run {
  /** How many requests the fixture had seen when the line "probes will go to" was printed. */
  before: number;
  code: number;
  out: string;
  err: string;
  json: () => Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}
async function scan(
  dir: string,
  flags: McpScanFlags,
  env: NodeJS.ProcessEnv = {},
  onErr?: (s: string) => void,
): Promise<Run> {
  const sink = { out: '', err: '', before: 0 };
  const code = await handleMcpScan({ format: 'json', ...flags }, [], {
    out: (s) => (sink.out += s),
    err: (s) => {
      sink.err += s;
      if (s.includes('probes will go to'))
        sink.before =
          servers.find((x) => x.url === flags.url || (flags.url ?? '').endsWith(`:${x.port}/mcp`))
            ?.seen.length ?? 0;
      onErr?.(s);
    },
    env,
    cwd: dir,
    today: '2026-11-13',
    clientVersion: '0.0.0',
  });
  return { code, ...sink, json: () => JSON.parse(sink.out) };
}
// H is the header of the static part of a scan (the live snapshot), which the probes never send.
const TOKENS = { A: TOKEN_A, B: TOKEN_B, H: `Bearer ${TOKEN_A}` };
/** The requests of the probes alone: those after the line "probes will go to". */
const probeFrames = (f: Fixture, r: Run) => f.seen.slice(r.before);
const active = (f: Fixture, file: string, extra: McpScanFlags = {}): McpScanFlags => ({
  active: true,
  url: f.url,
  probes: file,
  tokenEnv: 'A',
  otherTokenEnv: 'B',
  headerEnv: ['Authorization=H'],
  ...extra,
});
const noTokens = (f: Fixture, file: string): McpScanFlags => ({
  active: true,
  url: f.url,
  probes: file,
});
const rowsOf = (r: Run) =>
  r.json()['probes'].rows as {
    id: string;
    outcome: string;
    answer: string | null;
    reason?: string;
  }[];
const byId = (r: Run, id: string) => rowsOf(r).find((x) => x.id === id)!;

// ---- the probe file ----------------------------------------------------------------------------------------------------

describe('CLI · mcp scan probes · the probe file is read strictly', () => {
  const ok = { id: 'p1', tool: 'export', arguments: {}, as: 'none', expect: 'refuse' };
  const bad: [string, string][] = [
    ['an unknown key in an entry', JSON.stringify({ probes: [{ ...ok, extra: 1 }] })],
    ['an unknown key at the top', JSON.stringify({ probes: [ok], more: 1 })],
    ['a repeated id', JSON.stringify({ probes: [ok, ok] })],
    ['an unknown as', JSON.stringify({ probes: [{ ...ok, as: 'root' }] })],
    ['an unknown expect', JSON.stringify({ probes: [{ ...ok, expect: 'maybe' }] })],
    ['not JSON', '{'],
    [
      'too large',
      JSON.stringify({ probes: [{ ...ok, arguments: { a: 'x'.repeat(MAX_PROBE_FILE_BYTES) } }] }),
    ],
  ];
  for (const [what, text] of bad)
    it(`${what} is a usage error (exit 2) and nothing is sent`, async () => {
      const f = await fixture();
      const dir = tmp();
      writeFileSync(join(dir, 'p.json'), text);
      const r = await scan(dir, active(f, 'p.json'), TOKENS);
      expect(r.code).toBe(2);
      expect(r.err).toContain('--probes');
      expect(f.seen).toHaveLength(0);
      expect(() => parseProbeFile(text, 'p.json')).toThrow();
    });

  it('a good file is read', () => {
    expect(parseProbeFile(JSON.stringify({ probes: [ok] }), 'p.json')).toEqual([ok]);
  });
});

// ---- the wrapper -------------------------------------------------------------------------------------------------------

describe('CLI · mcp scan probes · the wrapper is the only way out', () => {
  const declared: ProbeEntry[] = [
    { id: 'p1', tool: 'export', arguments: { doc: 'a' }, as: 'none' },
  ];
  const call = (name: string, args: Record<string, unknown>, probe = 'p1'): Frame => ({
    type: 'rpc',
    method: 'tools/call',
    params: { name, arguments: args },
    probe,
    credential: { kind: 'none' },
  });
  const make = (entries = declared, limits = { maxCalls: 8, maxRequests: 40 }) => {
    const sent: Frame[] = [];
    const guard = new ProbeGuard(entries, limits, async (frame): Promise<Reply> => {
      sent.push(frame);
      return { kind: 'http', status: 200 };
    });
    guard.setListedTools([]);
    return { guard, sent };
  };

  it('a tools/call for a tool or arguments that no entry declares is refused and not sent', async () => {
    const { guard, sent } = make();
    expect(await guard.send(call('other', { doc: 'a' }))).toEqual({
      sent: false,
      refusal: 'undeclared',
    });
    expect(await guard.send(call('export', { doc: 'b' }))).toEqual({
      sent: false,
      refusal: 'undeclared',
    });
    expect(
      await guard.send({ type: 'rpc', method: 'resources/read', credential: { kind: 'none' } }),
    ).toEqual({ sent: false, refusal: 'undeclared' });
    expect(sent).toHaveLength(0);
    expect((await guard.send(call('export', { doc: 'a' }))).sent).toBe(true);
    expect(canonical({ b: 1, a: [2] })).toBe(canonical({ a: [2], b: 1 }));
  });

  it('readOnlyHint: true does not allow a call that no entry declares', async () => {
    const { guard, sent } = make();
    guard.setListedTools([{ name: 'peek', annotations: { readOnlyHint: true } }]);
    expect(await guard.send(call('peek', {}))).toEqual({ sent: false, refusal: 'undeclared' });
    expect(sent).toHaveLength(0);
  });

  it('destructiveHint: true blocks a declared call unless the entry says allowDestructive', async () => {
    const { guard, sent } = make([
      { id: 'p1', tool: 'wipe', arguments: {}, as: 'none' },
      { id: 'p2', tool: 'purge', arguments: {}, as: 'none', allowDestructive: true },
    ]);
    guard.setListedTools([
      { name: 'wipe', annotations: { destructiveHint: true } },
      { name: 'purge', annotations: { destructiveHint: true } },
    ]);
    expect(await guard.send(call('wipe', {}))).toEqual({ sent: false, refusal: 'destructive' });
    expect((await guard.send(call('purge', {}, 'p2'))).sent).toBe(true);
    expect(sent).toHaveLength(1);
  });

  it('the 9th tools/call at --max-calls 8 is refused before it is sent', async () => {
    const { guard, sent } = make();
    for (let i = 0; i < 8; i++)
      expect((await guard.send(call('export', { doc: 'a' }))).sent).toBe(true);
    expect(await guard.send(call('export', { doc: 'a' }))).toEqual({
      sent: false,
      refusal: 'budget',
    });
    expect(sent).toHaveLength(8);
    expect(guard.calls).toBe(8);
  });

  it('requests of any kind are counted in the same place', async () => {
    const { guard, sent } = make(declared, { maxCalls: 8, maxRequests: 3 });
    const list: Frame = { type: 'rpc', method: 'tools/list', credential: { kind: 'none' } };
    for (let i = 0; i < 3; i++) expect((await guard.send(list)).sent).toBe(true);
    expect(await guard.send(list)).toEqual({ sent: false, refusal: 'budget' });
    expect(await guard.send({ type: 'discovery' })).toEqual({ sent: false, refusal: 'budget' });
    expect(sent).toHaveLength(3);
  });

  it('two transport failures in a row stop everything that follows', async () => {
    let n = 0;
    const guard = new ProbeGuard(
      declared,
      { maxCalls: 8, maxRequests: 40 },
      async (): Promise<Reply> => {
        n++;
        return { kind: 'failure', why: 'network' };
      },
    );
    const list: Frame = { type: 'rpc', method: 'tools/list', credential: { kind: 'none' } };
    expect((await guard.send(list)).sent).toBe(true);
    expect((await guard.send(list)).sent).toBe(true);
    expect(await guard.send(list)).toEqual({ sent: false, refusal: 'transport-stopped' });
    expect(n).toBe(2);
  });
});

describe('CLI · mcp scan probes · budgets, end to end', () => {
  it('10 probes at --max-calls 8: 8 ran, the other two are "not run, budget", and exit 3', async () => {
    const f = await fixture();
    const { dir, file } = probeFile(
      Array.from({ length: 10 }, (_, i) => entry(`p${i}`, 'account-a', { expect: 'allow' })),
    );
    const r = await scan(dir, active(f, file, { maxCalls: '8' }), TOKENS);
    expect(r.code).toBe(3);
    const rows = rowsOf(r);
    expect(rows.filter((x) => x.outcome === 'as-expected')).toHaveLength(8);
    expect(rows.slice(8).map((x) => [x.outcome, x.reason])).toEqual([
      ['not-run', 'budget'],
      ['not-run', 'budget'],
    ]);
    expect(f.calls()).toBe(8);
    expect(r.json()['probes'].calls).toBe(8);
  });

  it('--max-requests spends the request budget in the one place too', async () => {
    const f = await fixture();
    const { dir, file } = probeFile([entry('p1', 'account-a'), entry('p2', 'account-a')]);
    const r = await scan(dir, active(f, file, { maxRequests: '4' }), TOKENS);
    expect(probeFrames(f, r).length).toBeLessThanOrEqual(4);
    expect(r.json()['probes'].requests).toBeLessThanOrEqual(4);
    expect(rowsOf(r).some((x) => x.reason === 'budget')).toBe(true);
    expect(r.code).toBe(3);
  });

  it('a server that cuts the connection stops the probes after two failures in a row', async () => {
    const f = await fixture({ cut: true });
    const { dir, file } = probeFile([
      entry('p1', 'none'),
      entry('p2', 'none'),
      entry('p3', 'none'),
    ]);
    const r = await scan(dir, active(f, file), TOKENS);
    expect(r.code).toBe(3);
    expect(rowsOf(r).map((x) => x.reason)).toContain('transport-stopped');
    expect(probeFrames(f, r).length).toBe(2);
  });
});

// ---- consent -------------------------------------------------------------------------------------------------------------

describe('CLI · mcp scan probes · consent', () => {
  it('without --active nothing is sent, and the probe flags alone are a usage error', async () => {
    const f = await fixture();
    const { dir, file } = probeFile([entry('p1', 'none')]);
    const r = await scan(dir, { url: f.url, probes: file }, TOKENS);
    expect(r.code).toBe(2);
    expect(f.seen).toHaveLength(0);
  });

  it('without --active the frames of a live scan are the static ones and not one more', async () => {
    const f = await fixture({ lax: true });
    const dir = tmp();
    const plain = await scan(dir, { url: f.url });
    const staticFrames = f.seen.length;
    const again = await scan(dir, { url: f.url, active: false });
    expect(f.seen.length - staticFrames).toBe(staticFrames);
    expect(f.seen.some((s) => s.rpc === 'tools/call')).toBe(false);
    expect(plain.code).toBe(again.code);
    // Pinned: the four requests of the static connection (handshake and lists); no probe frame, no metadata request.
    expect(f.seen.filter((s) => s.method === 'GET' && s.path.includes('.well-known'))).toHaveLength(
      0,
    );
    expect(staticFrames).toBe(4);
  });

  it('a host that is not on this machine needs --confirm-host to equal its host exactly: no consent, no probe frame', async () => {
    const f = await fixture({ host: '0.0.0.0' });
    const { dir, file } = probeFile([entry('p1', 'none', { expect: 'refuse' })]);
    const url = `http://foo.localhost:${f.port}/mcp`;
    const staticFlags: McpScanFlags = { url, headerEnv: ['Authorization=H'] };
    await scan(dir, staticFlags, TOKENS);
    const perStaticRun = f.seen.length;
    for (const confirm of [
      undefined,
      'foo.localhost',
      'other.example',
      `bar.localhost:${f.port}`,
    ]) {
      const before = f.seen.length;
      const r = await scan(
        dir,
        {
          ...noTokens(f, file),
          ...staticFlags,
          ...(confirm === undefined ? {} : { confirmHost: confirm }),
        },
        TOKENS,
      );
      expect(r.code, String(confirm)).toBe(3);
      expect(rowsOf(r)[0]!.reason).toBe('no-consent');
      expect(r.err).not.toContain('probes will go to');
      expect(f.seen.length - before, String(confirm)).toBe(perStaticRun);
    }
    // The exact host and port: probes go, and the line "probes will go to" is printed before the first probe frame.
    let atAnnounce = -1;
    const base = f.seen.length;
    const r = await scan(
      dir,
      { ...noTokens(f, file), ...staticFlags, confirmHost: `foo.localhost:${f.port}` },
      TOKENS,
      (line) => {
        if (line.includes('probes will go to')) atAnnounce = f.seen.length - base;
      },
    );
    expect(atAnnounce).toBe(perStaticRun);
    expect(r.err).toContain(`probes will go to http://foo.localhost:${f.port}/mcp`);
  });

  it('a token goes over https or to this machine only: plain http to another host with a token is a usage error', async () => {
    const dir = tmp();
    const { file } = probeFile([entry('p1', 'account-a')]);
    writeFileSync(join(dir, file), JSON.stringify({ probes: [entry('p1', 'account-a')] }));
    const r = await scan(
      dir,
      {
        active: true,
        url: 'http://203.0.113.9/mcp',
        probes: file,
        tokenEnv: 'A',
        confirmHost: '203.0.113.9',
      },
      TOKENS,
    );
    expect(r.code).toBe(2);
  });

  it('--active without a probe file, or with a probe file and no server, is "not run" and exit 3', async () => {
    const f = await fixture();
    const { dir, file } = probeFile([entry('p1', 'none')]);
    const noFile = await scan(
      dir,
      { active: true, url: f.url, headerEnv: ['Authorization=H'] },
      TOKENS,
    );
    const afterStatic = f.seen.length;
    expect(noFile.code).toBe(3);
    expect(rowsOf(noFile)[0]!.reason).toBe('no-probe-file');
    const noServer = await scan(dir, { active: true, probes: file, snapshot: [] }, TOKENS);
    expect(noServer.code).toBe(3);
    expect(rowsOf(noServer)[0]!.reason).toBe('no-target');
    expect(f.seen).toHaveLength(afterStatic);
  });
});

// ---- the rules -----------------------------------------------------------------------------------------------------------

describe('CLI · mcp scan probes · rules, on a server that keeps its requirements and one that does not', () => {
  const entries = [
    entry('p-none', 'none', { expect: 'refuse' }),
    entry('p-garbage', 'garbage', { expect: 'refuse' }),
    entry('p-b', 'account-b', { expect: 'refuse' }),
    entry('p-a', 'account-a', { expect: 'allow' }),
  ];

  it('strict: every probe is as declared, exit 0, and no rule fires', async () => {
    const f = await fixture();
    const { dir, file } = probeFile(entries);
    const r = await scan(dir, active(f, file), TOKENS);
    expect(r.code).toBe(0);
    expect(rowsOf(r).map((x) => [x.id, x.outcome, x.answer])).toEqual([
      ['p-none', 'as-expected', 'refused'],
      ['p-garbage', 'as-expected', 'refused'],
      ['p-b', 'as-expected', 'refused'],
      ['p-a', 'as-expected', 'allowed'],
    ]);
    expect(r.json()['findings']).toEqual([]);
  });

  it('lax: unauthenticated-call, garbage-token-accepted and cross-account-access are errors that gate (exit 1)', async () => {
    const f = await fixture({ lax: true });
    const { dir, file } = probeFile(entries);
    const r = await scan(dir, active(f, file), TOKENS);
    expect(r.code).toBe(1);
    const found = r.json()['findings'] as {
      rule: string;
      severity: string;
      target: string;
      message: string;
      counted: boolean;
    }[];
    expect(found.map((x) => [x.rule, x.severity, x.target, x.counted])).toEqual([
      ['scan/probe/cross-account-access', 'error', 'p-b', true],
      ['scan/probe/garbage-token-accepted', 'error', 'p-garbage', true],
      ['scan/probe/unauthenticated-call', 'error', 'p-none', true],
    ]);
    expect(found.find((x) => x.target === 'p-none')!.message).toBe(
      'probe p-none: tool "export" ran without credentials; the probe file expects a refusal',
    );
    expect(byId(r, 'p-none').outcome).toBe('violated');
  });

  it('lax without an expectation: the answer is information and does not change the exit code', async () => {
    const f = await fixture({ lax: true });
    const { dir, file } = probeFile([entry('p1', 'none')]);
    const r = await scan(dir, active(f, file), TOKENS);
    expect(r.code).toBe(0);
    const [finding] = r.json()['findings'];
    expect(finding).toMatchObject({
      rule: 'scan/probe/unauthenticated-call',
      severity: 'info',
      counted: false,
    });
    expect(finding.message).toContain('answered without credentials');
  });

  it('a probe as wrong-audience is not run here: the oauth suite checks it', async () => {
    const f = await fixture({ lax: true });
    const { dir, file } = probeFile([entry('p1', 'wrong-audience', { expect: 'refuse' })]);
    const r = await scan(dir, active(f, file), TOKENS);
    expect(r.code).toBe(3);
    expect(byId(r, 'p1').reason).toBe('wrong-audience');
    expect(f.calls()).toBe(0);
  });

  it('no token for account B, or for account A: not run, with its own reason', async () => {
    const f = await fixture();
    const { dir, file } = probeFile([
      entry('pa', 'account-a'),
      entry('pb', 'account-b', { expect: 'refuse' }),
    ]);
    const r = await scan(dir, { active: true, url: f.url, probes: file }, {});
    expect([byId(r, 'pa').reason, byId(r, 'pb').reason]).toEqual(['no-credential', 'no-account-b']);
    expect(r.code).toBe(3);
  });

  it('a server with no tools: "not run, tool not on server", never a success', async () => {
    const f = await fixture({ lax: true, tools: [] });
    const { dir, file } = probeFile([entry('p1', 'none', { expect: 'refuse' })]);
    const r = await scan(dir, active(f, file), TOKENS);
    expect(r.code).toBe(3);
    expect(byId(r, 'p1')).toMatchObject({ outcome: 'not-run', reason: 'tool-missing' });
    expect(f.calls()).toBe(0);
  });

  it('a tool the server marks destructive is not called without allowDestructive; readOnlyHint widens nothing', async () => {
    const f = await fixture({ lax: true });
    const wipe = { id: 'w', tool: 'wipe', arguments: {}, as: 'none', expect: 'refuse' };
    const wipeControl = { id: 'wc', tool: 'wipe', arguments: {}, as: 'account-a', expect: 'allow' };
    const { dir, file } = probeFile([wipe, wipeControl]);
    const r = await scan(dir, active(f, file), TOKENS);
    expect(byId(r, 'w')).toMatchObject({ outcome: 'not-run', reason: 'destructive' });
    expect(f.calls()).toBe(0);
    const ok = probeFile([
      { ...wipe, allowDestructive: true },
      { ...wipeControl, allowDestructive: true },
    ]);
    const again = await scan(ok.dir, active(f, ok.file), TOKENS);
    expect(byId(again, 'w').outcome).toBe('violated');
    expect(f.calls()).toBe(2);
  });

  it('timeout-like answers decide nothing: 429, 5xx and a redirect are "not run", never a violation', async () => {
    for (const force of [429, 503, 404]) {
      const f = await fixture({ lax: true, force });
      const { dir, file } = probeFile([entry('p1', 'none', { expect: 'refuse' })]);
      const r = await scan(dir, active(f, file), TOKENS);
      expect(byId(r, 'p1'), String(force)).toMatchObject({
        outcome: 'not-run',
        reason: 'inconclusive',
      });
      expect(r.code).toBe(3);
    }
    const target = await fixture({ lax: true });
    const f = await fixture({ force: target.url });
    const { dir, file } = probeFile([entry('p1', 'account-a')]);
    const r = await scan(dir, active(f, file), TOKENS);
    expect(byId(r, 'p1').reason).toBe('inconclusive');
    expect(target.seen).toHaveLength(0);
  });
});

// ---- tokens stay where they belong -----------------------------------------------------------------------------------

describe('CLI · mcp scan probes · a token goes to the origin of the target and nowhere else', () => {
  it('a 401 that names another host in WWW-Authenticate, and a redirect to it, never bring a request there', async () => {
    const elsewhere = await fixture({ lax: true });
    const f = await fixture({
      challengeUrl: `${elsewhere.url}/.well-known/oauth-protected-resource`,
    });
    const { dir, file } = probeFile([
      entry('p1', 'none', { expect: 'refuse' }),
      entry('p2', 'garbage', { expect: 'refuse' }),
      entry('p3', 'account-a'),
    ]);
    await scan(dir, active(f, file), TOKENS);
    expect(elsewhere.seen).toHaveLength(0);
    const redirecting = await fixture({ force: elsewhere.url });
    const r = await scan(dir, active(redirecting, file), TOKENS);
    expect(elsewhere.seen).toHaveLength(0);
    expect(r.code).toBe(3);
  });

  it('the metadata request of the origin carries no token, and no probe sends the --header values', async () => {
    const f = await fixture();
    const { dir, file } = probeFile([entry('p1', 'account-a'), entry('p2', 'none')]);
    await scan(dir, active(f, file, { header: ['X-Api-Key: static-key-123456'] }), TOKENS);
    const meta = f.seen.filter((s) => s.path.includes('.well-known'));
    expect(meta.length).toBeGreaterThan(0);
    for (const m of meta) expect(m.auth).toBeUndefined();
    expect(f.seen.some((s) => s.auth === `Bearer ${TOKEN_A}`)).toBe(true);
  });

  const forms = (t: string) => [
    t,
    encodeURIComponent(t),
    Buffer.from(t).toString('base64'),
    Buffer.from(t).toString('base64url'),
    MARK,
    encodeURIComponent(MARK),
    ARG_MARK,
  ];
  it('a token, and a value of an argument, are absent from every format and every message, in every form', async () => {
    for (const lax of [true, false]) {
      const f = await fixture({ lax });
      const { dir, file } = probeFile([
        entry('p-none', 'none', { expect: 'refuse' }),
        entry('p-b', 'account-b', { expect: 'refuse' }),
        entry('p-a', 'account-a'),
      ]);
      const outputs: string[] = [];
      for (const format of ['human', 'json', 'github', 'sarif'] as const) {
        const r = await scan(dir, active(f, file, { format }), TOKENS);
        outputs.push(r.out, r.err);
      }
      const r = await scan(
        dir,
        active(f, file, { out: ['j.json', 'sarif=s.sarif', 'junit-xml=j.xml'] }),
        TOKENS,
      );
      outputs.push(r.out, r.err);
      const { readFileSync } = await import('node:fs');
      for (const name of ['j.json', 's.sarif', 'j.xml'])
        outputs.push(readFileSync(join(dir, name), 'utf8'));
      const all = outputs.join('\n');
      for (const form of [...forms(TOKEN_A), ...forms(TOKEN_B)])
        expect(all.includes(form), `${lax}: ${form}`).toBe(false);
    }
  });

  it('a connection that fails says nothing about the token in its message', async () => {
    const f = await fixture({ cut: true });
    const { dir, file } = probeFile([entry('p1', 'account-a')]);
    const r = await scan(dir, active(f, file), TOKENS);
    for (const form of forms(TOKEN_A)) expect((r.out + r.err).includes(form)).toBe(false);
  });
});

// ---- the report ------------------------------------------------------------------------------------------------------------

describe('CLI · mcp scan probes · the summary table is in every format', () => {
  it('probe / expectation / result / not run because, in human, json, github, sarif and junit-xml', async () => {
    const f = await fixture({ lax: true });
    const { dir, file } = probeFile([
      entry('ctl', 'account-a', { expect: 'allow' }),
      entry('p1', 'none', { expect: 'refuse' }),
      entry('p2', 'wrong-audience'),
    ]);
    const human = await scan(dir, active(f, file, { format: 'human' }), TOKENS);
    expect(human.out).toMatch(/p1 \/ expect refuse \/ allowed \(VIOLATED\)/);
    expect(human.out).toMatch(/p2 \/ no expectation \/ not run \/ a token for another resource/);
    expect(human.out).toContain('kept only with --journal');
    const github = await scan(dir, active(f, file, { format: 'github' }), TOKENS);
    expect(github.out).toMatch(/3 probes \(1 not run\)/);
    const sarif = (await scan(dir, active(f, file, { format: 'sarif' }), TOKENS)).json();
    expect(sarif['runs'][0].properties.probes.rows).toHaveLength(3);
    await scan(dir, active(f, file, { out: ['junit-xml=j.xml'] }), TOKENS);
    const { readFileSync } = await import('node:fs');
    const xml = readFileSync(join(dir, 'j.xml'), 'utf8');
    expect(xml).toMatch(/<testcase classname="mcp\.scan\.active" name="probe p1">\s*<failure/);
    expect(xml).toMatch(
      /<testcase classname="mcp\.scan\.active" name="probe p2">\s*<skipped type="not-evaluated"/,
    );
  });
});

// ---- review round 2: a broken probe must not look like a protected server ----------------------------------------------------

describe('CLI · mcp scan probes · a refusal is HTTP 401 or 403, or a control proves it', () => {
  const ctl = (extra: Record<string, unknown> = {}) =>
    entry('ctl', 'account-a', { expect: 'allow', ...extra });
  const refuse = (id: string, as: string, extra: Record<string, unknown> = {}) =>
    entry(id, as, { expect: 'refuse', ...extra });

  it('a JSON-RPC error on tools/call for everyone (a broken probe) is "not run", not a refusal', async () => {
    const f = await fixture({ lax: true, rpcError: 'tools/call' });
    const { dir, file } = probeFile([ctl(), refuse('p1', 'none')]);
    const r = await scan(dir, active(f, file), TOKENS);
    expect(byId(r, 'p1')).toMatchObject({ outcome: 'not-run' });
    expect(byId(r, 'ctl').outcome).toBe('not-run');
    expect(r.code).toBe(3);
  });

  it('isError for everyone, and a JSON-RPC error answering initialize, are not refusals either', async () => {
    const isErr = await fixture({ lax: true, isErrorForAll: true });
    const a = probeFile([ctl(), refuse('p1', 'none')]);
    const r1 = await scan(a.dir, active(isErr, a.file), TOKENS);
    expect(byId(r1, 'p1').outcome).toBe('not-run');
    expect(r1.code).toBe(3);
    const broken = await fixture({ lax: true, rpcError: 'initialize' });
    const b = probeFile([ctl(), refuse('p1', 'none')]);
    const r2 = await scan(b.dir, active(broken, b.file), TOKENS);
    expect(rowsOf(r2).map((x) => [x.outcome, x.reason])).toEqual([
      ['not-run', 'inconclusive'],
      ['not-run', 'inconclusive'],
    ]);
    expect(r2.code).toBe(3);
  });

  it('isError for account B only, with a control that ran for account A: a refusal, and the row names the control', async () => {
    const f = await fixture();
    const { dir, file } = probeFile([refuse('p-b', 'account-b'), ctl()]);
    const r = await scan(dir, active(f, file), TOKENS);
    expect(r.code).toBe(0);
    expect(byId(r, 'p-b')).toMatchObject({
      outcome: 'as-expected',
      answer: 'refused',
      control: 'ctl',
    });
    const human = (await scan(dir, active(f, file, { format: 'human' }), TOKENS)).out;
    expect(human).toMatch(/p-b \/ expect refuse \/ refused \/ control ctl/);
  });

  it('controls run first: the control call reaches the server before any refuse probe', async () => {
    const f = await fixture();
    const { dir, file } = probeFile([refuse('p-b', 'account-b'), ctl()]);
    await scan(dir, active(f, file), TOKENS);
    const calls = f.seen.filter((s) => s.rpc === 'tools/call');
    expect(calls.map((c) => c.auth)).toEqual([`Bearer ${TOKEN_A}`, `Bearer ${TOKEN_B}`]);
  });

  it('no control in the file: a refuse probe answered by isError is "not run, no control", exit 3', async () => {
    const f = await fixture();
    const { dir, file } = probeFile([refuse('p-b', 'account-b')]);
    const r = await scan(dir, active(f, file), TOKENS);
    expect(byId(r, 'p-b')).toMatchObject({ outcome: 'not-run', reason: 'no-control' });
    expect(r.code).toBe(3);
  });

  it('a control for other arguments is no control; a control that was refused is no control', async () => {
    const f = await fixture();
    const other = entry('ctl', 'account-a', { expect: 'allow', arguments: { doc: 'doc-x' } });
    const a = probeFile([refuse('p-b', 'account-b'), other]);
    expect(byId(await scan(a.dir, active(f, a.file), TOKENS), 'p-b').reason).toBe('no-control');
    const refusedControl = await fixture();
    const b = probeFile([refuse('p-b', 'account-b'), ctl()]);
    const r = await scan(b.dir, active(refusedControl, b.file), {
      ...TOKENS,
      A: 'tokA-not-issued-0001',
    });
    expect(byId(r, 'p-b').reason).toBe('no-control');
    expect(byId(r, 'ctl')).toMatchObject({ outcome: 'observed', answer: 'refused' });
  });

  it('an answer of HTTP 401 or 403 stands alone: no control needed, and the row says so', async () => {
    const f = await fixture();
    const { dir, file } = probeFile([refuse('p-none', 'none')]);
    const r = await scan(dir, active(f, file), TOKENS);
    expect(r.code).toBe(0);
    expect(byId(r, 'p-none')).toMatchObject({
      outcome: 'as-expected',
      answer: 'refused',
      refusedAt: 'initialize',
      control: null,
    });
    const human = (await scan(dir, active(f, file, { format: 'human' }), TOKENS)).out;
    expect(human).toMatch(/refused at initialize \/ no control: HTTP 401 or 403 stands alone/);
  });
});

describe('CLI · mcp scan probes · smaller faults of the review', () => {
  it('N1: a file that declares nothing is a usage error', async () => {
    const f = await fixture();
    const dir = tmp();
    writeFileSync(join(dir, 'p.json'), JSON.stringify({ probes: [] }));
    const r = await scan(dir, active(f, 'p.json'), TOKENS);
    expect(r.code).toBe(2);
    expect(r.err).toContain('declares nothing');
    expect(() => parseProbeFile('{"probes":[]}', 'p.json')).toThrow();
  });

  it('N3: two probes of one tool and arguments: the one without allowDestructive is still blocked', async () => {
    const guard = new ProbeGuard(
      [
        { id: 'p1', tool: 'wipe', arguments: {}, as: 'none' },
        { id: 'p2', tool: 'wipe', arguments: {}, as: 'none', allowDestructive: true },
      ],
      { maxCalls: 8, maxRequests: 40 },
      async (): Promise<Reply> => ({ kind: 'http', status: 200 }),
    );
    guard.setListedTools([{ name: 'wipe', annotations: { destructiveHint: true } }]);
    const frame = (probe: string): Frame => ({
      type: 'rpc',
      method: 'tools/call',
      params: { name: 'wipe', arguments: {} },
      probe,
      credential: { kind: 'none' },
    });
    expect(await guard.send(frame('p1'))).toEqual({ sent: false, refusal: 'destructive' });
    expect((await guard.send(frame('p2'))).sent).toBe(true);
    expect(await guard.send(frame('nobody'))).toEqual({ sent: false, refusal: 'undeclared' });
  });

  it('N4: a guard that was never told the tool list refuses every tools/call', async () => {
    const sent: Frame[] = [];
    const guard = new ProbeGuard(
      [{ id: 'p1', tool: 'export', arguments: {}, as: 'none' }],
      { maxCalls: 8, maxRequests: 40 },
      async (f): Promise<Reply> => {
        sent.push(f);
        return { kind: 'http', status: 200 };
      },
    );
    const r = await guard.send({
      type: 'rpc',
      method: 'tools/call',
      params: { name: 'export', arguments: {} },
      probe: 'p1',
      credential: { kind: 'none' },
    });
    expect(r).toEqual({ sent: false, refusal: 'tools-unknown' });
    expect(sent).toHaveLength(0);
  });

  it('N6: a name under .localhost is not this machine: it needs --confirm-host and refuses a token over http', async () => {
    const { dir, file } = probeFile([entry('p1', 'none', { expect: 'refuse' })]);
    const url = 'http://foo.localhost:9/mcp';
    const noConfirm = await scan(dir, { active: true, probes: file, url, snapshot: [] }, TOKENS);
    expect(rowsOf(noConfirm)[0]!.reason).toBe('no-consent');
    const withToken = await scan(dir, { active: true, probes: file, url, tokenEnv: 'A' }, TOKENS);
    expect(withToken.code).toBe(2);
    expect(withToken.err).toContain('plain http');
  });

  it('N6: localhost, 127.x.x.x and [::1] are this machine', async () => {
    const { isThisMachine } = await import('../scan/probes/local.js');
    for (const u of [
      'http://localhost:1/',
      'http://127.0.0.1/',
      'http://127.9.9.9:80/',
      'http://[::1]:3000/',
      'http://127.1/',
      'http://LOCALHOST/',
    ])
      expect(isThisMachine(u), u).toBe(true);
    for (const u of [
      'http://foo.localhost/',
      'http://127.example.com/',
      'http://127.0.0.1.evil.example/',
      'http://good@evil.example/',
      'http://127.0.0.1@evil.example/',
      'http://10.0.0.1/',
      'https://example.com/',
    ])
      expect(isThisMachine(u), u).toBe(false);
  });

  it('N9: a 307 to another path of the same origin is not followed', async () => {
    const f = await fixture({ force: '/other', redirectStatus: 307 });
    const { dir, file } = probeFile([entry('p1', 'account-a', { expect: 'allow' })]);
    const r = await scan(dir, active(f, file), TOKENS);
    expect(byId(r, 'p1')).toMatchObject({ outcome: 'not-run', reason: 'inconclusive' });
    expect(probeFrames(f, r).filter((s) => s.path === '/other')).toHaveLength(0);
  });

  it('N9: budgets of 0, NaN and the like are rejected by the guard itself', () => {
    const transport = async (): Promise<Reply> => ({ kind: 'http', status: 200 });
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5])
      for (const limits of [
        { maxCalls: bad, maxRequests: 40 },
        { maxCalls: 8, maxRequests: bad },
      ])
        expect(() => new ProbeGuard([], limits, transport), String(bad)).toThrow(RangeError);
  });
});

// ---- review round 3 --------------------------------------------------------------------------------------------------------

describe('CLI · mcp scan probes · "ran" is a result object', () => {
  const ctl = entry('ctl', 'account-a', { expect: 'allow' });

  it('a 2xx answer with the right id and neither result nor error is "not run", on the call and on the earlier steps', async () => {
    for (const bare of ['tools/call', 'initialize', 'tools/list']) {
      const f = await fixture({ lax: true, bare });
      const { dir, file } = probeFile([entry('p1', 'none', { expect: 'refuse' })]);
      const r = await scan(dir, active(f, file), TOKENS);
      expect(byId(r, 'p1'), bare).toMatchObject({ outcome: 'not-run', reason: 'inconclusive' });
      expect(r.json()['findings'], bare).toEqual([]);
      expect(r.code, bare).toBe(3);
    }
  });

  it('a result that is not an object is not a run either', async () => {
    const f = await fixture({ lax: true, bare: 'tools/call', bareResult: 'text' });
    const { dir, file } = probeFile([entry('p1', 'none', { expect: 'refuse' })]);
    const r = await scan(dir, active(f, file), TOKENS);
    expect(byId(r, 'p1').outcome).toBe('not-run');
  });

  it('such an answer to the control makes it no control: the isError of account B proves nothing', async () => {
    const f = await fixture({ bare: 'tools/call', bareFor: 'a' });
    const { dir, file } = probeFile([ctl, entry('p-b', 'account-b', { expect: 'refuse' })]);
    const r = await scan(dir, active(f, file), TOKENS);
    expect(byId(r, 'ctl').outcome).toBe('not-run');
    expect(byId(r, 'p-b')).toMatchObject({ outcome: 'not-run', reason: 'no-control' });
    expect(r.code).toBe(3);
  });
});

describe('CLI · mcp scan probes · a call that ran with no valid credentials is a violation, control or not', () => {
  it('none and garbage that ran, with expect: refuse and no control: violated, error, exit 1', async () => {
    const f = await fixture({ lax: true });
    const { dir, file } = probeFile([
      entry('p-none', 'none', { expect: 'refuse' }),
      entry('p-garbage', 'garbage', { expect: 'refuse' }),
    ]);
    const r = await scan(dir, active(f, file), TOKENS);
    expect(r.code).toBe(1);
    expect(rowsOf(r).map((x) => [x.id, x.outcome])).toEqual([
      ['p-none', 'violated'],
      ['p-garbage', 'violated'],
    ]);
    expect((r.json()['findings'] as { rule: string }[]).map((x) => x.rule).sort()).toEqual([
      'scan/probe/garbage-token-accepted',
      'scan/probe/unauthenticated-call',
    ]);
  });

  it('account B that ran, with no control: still "not run, no control" (running for B may be right for the tool)', async () => {
    const f = await fixture({ lax: true });
    const { dir, file } = probeFile([entry('p-b', 'account-b', { expect: 'refuse' })]);
    const r = await scan(dir, active(f, file), TOKENS);
    expect(byId(r, 'p-b')).toMatchObject({ outcome: 'not-run', reason: 'no-control' });
    expect(r.code).toBe(3);
  });
});

describe('CLI · mcp scan probes · a refusal of everyone proves nothing', () => {
  const ctl = entry('ctl', 'account-a', { expect: 'allow' });

  it('the control was refused with HTTP 401: the refuse probe that got 401 is "not run, no control", with the note', async () => {
    const f = await fixture({ denyAll: true });
    const { dir, file } = probeFile([ctl, entry('p-none', 'none', { expect: 'refuse' })]);
    const r = await scan(dir, active(f, file), TOKENS);
    expect(byId(r, 'p-none')).toMatchObject({ outcome: 'not-run', reason: 'no-control' });
    expect(byId(r, 'p-none').note).toContain('control was refused too');
    expect(r.code).toBe(3);
    const human = (await scan(dir, active(f, file, { format: 'human' }), TOKENS)).out;
    expect(human).toContain('the control was refused too');
  });

  it('with no control in the file, a 401 still stands alone', async () => {
    const f = await fixture({ denyAll: true });
    const { dir, file } = probeFile([entry('p-none', 'none', { expect: 'refuse' })]);
    const r = await scan(dir, active(f, file), TOKENS);
    expect(byId(r, 'p-none')).toMatchObject({ outcome: 'as-expected', control: null });
  });
});

describe('CLI · mcp scan probes · the stdio command is announced without secrets', () => {
  it('a token-shaped argument is not printed', async () => {
    const lines: string[] = [];
    const secret = `ghp_${'Qw3rtY'.repeat(6)}`;
    const section = await runProbes({
      entries: [{ id: 'p1', tool: 'export', arguments: {}, as: 'none' }],
      target: { kind: 'stdio', command: 'node', args: ['server.js', '--token', secret], env: {} },
      tokens: {},
      timeoutMs: 1000,
      announce: (l) => lines.push(l),
    });
    expect(lines.join('\n')).toContain('node');
    expect(lines.join('\n')).not.toContain(secret);
    expect(lines.join('\n')).not.toContain('Qw3rtYQw3rtY');
    expect(section.rows[0]!.reason).toBe('stdio');
  });
});

// ---- step 2: the journal, the leak rule, the hint rule ----------------------------------------------------------------------

const SCHEMA = {
  type: 'object',
  properties: { doc: { type: 'string' }, note: { type: 'string' } },
  required: ['doc'],
};
const STEP2_TOOLS = [
  { name: 'export', inputSchema: SCHEMA, annotations: { readOnlyHint: true } },
  { name: 'wipe', inputSchema: SCHEMA, annotations: { destructiveHint: true } },
];
const allForms = (t: string) => [
  t,
  encodeURIComponent(t),
  Buffer.from(t).toString('base64'),
  Buffer.from(t).toString('base64url'),
  JSON.stringify(t).slice(1, -1),
];
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a parsed line is read by key in the assertions
const journalLines = (dir: string, name = 'j.jsonl'): Record<string, any>[] =>
  readFileSync(join(dir, name), 'utf8')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l));
const journalProbes = [
  entry('p-none', 'none', { expect: 'refuse' }),
  entry('p-b', 'account-b', { expect: 'refuse' }),
  entry('p-a', 'account-a', { expect: 'allow' }),
];

describe('CLI · mcp scan probes · --journal: one line for every frame and answer, with no secret and no body', () => {
  it('a token, in plain, URL-encoded, base64 and base64url form, and the marks of a body and of arguments, are absent from the journal', async () => {
    for (const lax of [true, false]) {
      const f = await fixture({ lax, tools: STEP2_TOOLS });
      const { dir, file } = probeFile(journalProbes);
      const r = await scan(dir, active(f, file, { journal: 'j.jsonl' }), TOKENS);
      expect(r.code, r.err).toBeLessThan(2);
      const text = readFileSync(join(dir, 'j.jsonl'), 'utf8');
      for (const form of [...allForms(TOKEN_A), ...allForms(TOKEN_B), MARK, ARG_MARK, 'bad token'])
        expect(text.includes(form), `${lax}: ${form}`).toBe(false);
    }
  });

  it('Authorization is a mark, and so is the session id; the line says only that a bearer was sent', async () => {
    const f = await fixture({ tools: STEP2_TOOLS });
    const { dir, file } = probeFile(journalProbes);
    await scan(dir, active(f, file, { journal: 'j.jsonl' }), TOKENS);
    const out = journalLines(dir).filter((l) => l['dir'] === 'out' && l['kind'] === 'rpc');
    const bearer = out.filter((l) => l['as'] === 'bearer');
    expect(bearer.length).toBeGreaterThan(0);
    for (const l of bearer) expect(l['headers']['Authorization']).toBe('***');
    for (const l of out.filter((x) => x['headers']['Mcp-Session-Id'] !== undefined))
      expect(l['headers']['Mcp-Session-Id']).toBe('***');
  });

  it('the answer lines hold the status, the JSON-RPC id, result/error/isError and sizes, and no body', async () => {
    const f = await fixture({ tools: STEP2_TOOLS });
    const { dir, file } = probeFile(journalProbes);
    await scan(dir, active(f, file, { journal: 'j.jsonl' }), TOKENS);
    const ins = journalLines(dir).filter((l) => l['dir'] === 'in');
    expect(ins.length).toBeGreaterThan(3);
    for (const l of ins) {
      expect(Object.keys(l).sort()).toEqual(expect.arrayContaining(['dir', 'seq', 'ts', 'status']));
      for (const k of Object.keys(l))
        expect(
          ['dir', 'seq', 'ts', 'status', 'rpcId', 'result', 'error', 'isError', 'bytes', 'failure'],
          k,
        ).toContain(k);
    }
    expect(ins.some((l) => l['result'] === true && typeof l['rpcId'] === 'number')).toBe(true);
    expect(ins.some((l) => l['status'] === 401)).toBe(true);
  });

  it('there is a line for every request the server received, and the file is there after a budget stop', async () => {
    const f = await fixture({ lax: true, tools: STEP2_TOOLS });
    const many = Array.from({ length: 10 }, (_, i) => entry(`p${i}`, 'none'));
    const { dir, file } = probeFile(many);
    const r = await scan(dir, active(f, file, { journal: 'j.jsonl', maxCalls: '3' }), TOKENS);
    const lines = journalLines(dir);
    const sent = lines.filter((l) => l['dir'] === 'out');
    expect(sent).toHaveLength(probeFrames(f, r).length);
    expect(sent.map((l) => l['seq'])).toEqual(sent.map((_, i) => i + 1));
    expect(lines.some((l) => l['dir'] === 'refused' && l['reason'] === 'budget')).toBe(true);
    expect(lines.filter((l) => l['dir'] === 'in')).toHaveLength(sent.length);
  });

  it('a frame the wrapper refuses is journaled as refused and is not sent', async () => {
    const lines: Record<string, unknown>[] = [];
    const sent: Frame[] = [];
    const guard = new ProbeGuard(
      [{ id: 'p1', tool: 'export', arguments: { doc: 'a' }, as: 'none' }],
      { maxCalls: 8, maxRequests: 40 },
      async (frame): Promise<Reply> => {
        sent.push(frame);
        return { kind: 'http', status: 200 };
      },
      { record: (line) => void lines.push(line) },
    );
    guard.setListedTools([]);
    const bad: Frame = {
      type: 'rpc',
      method: 'tools/call',
      params: { name: 'export', arguments: { doc: 'other' } },
      probe: 'p1',
      credential: { kind: 'none' },
    };
    expect(await guard.send(bad)).toEqual({ sent: false, refusal: 'undeclared' });
    expect(sent).toHaveLength(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ dir: 'refused', reason: 'undeclared', tool: 'export' });
    expect(JSON.stringify(lines)).not.toContain('other');
  });

  it('a journal that cannot be written stops the probes: nothing more is sent, and the rest are "not run, journal"', async () => {
    let writes = 0;
    const f = await fixture({ lax: true, tools: STEP2_TOOLS });
    const section = await runProbes({
      entries: [entry('p1', 'none'), entry('p2', 'none'), entry('p3', 'none')] as ProbeEntry[],
      target: { kind: 'http', url: f.url, headers: {} } as never,
      tokens: {},
      timeoutMs: 5000,
      announce: () => {},
      journal: {
        record: () => {
          if (++writes > 7) throw new Error('disk full: C:\\secret\\path');
        },
        close: () => {},
      },
    });
    const received = f.seen.length;
    expect(section.rows.some((r) => r.reason === 'journal-failed')).toBe(true);
    // Every request that reached the server had its line written first (the 7 that were written).
    expect(received).toBeLessThanOrEqual(4);
    expect(JSON.stringify(section)).not.toContain('disk full');
  });

  it('a journal that cannot be opened is a usage error before the first frame of the probes', async () => {
    const f = await fixture({ tools: STEP2_TOOLS });
    const { dir, file } = probeFile(journalProbes);
    const r = await scan(dir, active(f, file, { journal: 'no-such-dir/j.jsonl' }), TOKENS);
    expect(r.code).toBe(2);
    expect(r.err).toContain('--journal');
    expect(r.err).not.toContain('ENOENT');
    expect(r.err).not.toContain(dir);
    expect(r.err).not.toContain('probes will go to');
    expect(f.seen.filter((s) => s.rpc === 'tools/call' || s.path.includes('well-known'))).toEqual(
      [],
    );
  });

  it('--journal without --active is a usage error', async () => {
    const r = await scan(tmp(), { journal: 'j.jsonl' });
    expect(r.code).toBe(2);
    expect(r.err).toContain('--journal');
  });
});

describe('CLI · mcp scan probes · scan/probe/error-detail-leak', () => {
  const malformed = [{ id: 'm1', tool: 'export', arguments: {}, as: 'account-a', malformed: true }];
  const LEAK = 'LEAKMARK-77';
  const stack = `TypeError: bad input\n    at handler (/srv/app/${LEAK}/tools.js:42:13)\n    at run (/srv/app/node_modules/x.js:1:1)`;

  it('the probe file takes malformed only as account-a', () => {
    expect(parseProbeFile(JSON.stringify({ probes: malformed }), 'p.json')[0]!).toMatchObject({
      malformed: true,
    });
    expect(() =>
      parseProbeFile(JSON.stringify({ probes: [{ ...malformed[0], as: 'none' }] }), 'p.json'),
    ).toThrow(/malformed/);
    expect(() =>
      parseProbeFile(JSON.stringify({ probes: [{ ...malformed[0], malformed: 'yes' }] }), 'p.json'),
    ).toThrow(/malformed/);
  });

  it('the derived arguments: the first required property dropped, else one property of a wrong type, else none', async () => {
    const { malformedArguments } = await import('../scan/probes/leak.js');
    expect(
      malformedArguments({ properties: { a: {}, b: { type: 'number' } }, required: ['a', 'b'] }),
    ).toEqual({ b: 0 });
    expect(malformedArguments({ properties: { a: { type: 'string' } } })).toEqual({ a: 0 });
    expect(malformedArguments({ properties: { a: { type: 'number' } } })).toEqual({ a: 'x' });
    expect(malformedArguments({ properties: {} })).toBeUndefined();
    expect(malformedArguments(undefined)).toBeUndefined();
    expect(malformedArguments({ required: [] })).toBeUndefined();
  });

  it('red on a server that echoes a stack, in an isError result and in a JSON-RPC error; the finding holds the pattern and the tool only', async () => {
    for (const errorAs of ['isError', 'rpc'] as const) {
      const f = await fixture({ tools: STEP2_TOOLS, errorText: stack, errorAs });
      const { dir, file } = probeFile([...journalProbes, ...malformed]);
      const outputs: string[] = [];
      let r!: Run;
      for (const format of ['human', 'json', 'github', 'sarif'] as const) {
        r = await scan(dir, active(f, file, { format, journal: 'j.jsonl' }), TOKENS);
        outputs.push(r.out, r.err);
      }
      outputs.push(readFileSync(join(dir, 'j.jsonl'), 'utf8'));
      const json = (await scan(dir, active(f, file), TOKENS)).json();
      const found = json['findings'].filter(
        (x: { rule: string }) => x.rule === 'scan/probe/error-detail-leak',
      );
      expect(found, errorAs).toHaveLength(1);
      expect(found[0].message).toContain('stack-js');
      expect(found[0].message).toContain('export');
      expect(found[0]).toMatchObject({ class: 'heuristic', severity: 'advice', gating: false });
      for (const text of outputs) {
        expect(text).not.toContain(LEAK);
        expect(text).not.toContain('/srv/app');
        expect(text).not.toContain('TypeError');
      }
    }
  });

  it('green on a strict server that answers a plain message: "no pattern matched", exit code unchanged', async () => {
    const f = await fixture({ tools: STEP2_TOOLS, errorText: 'invalid arguments' });
    const { dir, file } = probeFile([...journalProbes, ...malformed]);
    const r = await scan(dir, active(f, file), TOKENS);
    expect(r.code).toBe(0);
    expect(r.json()['findings']).toEqual([]);
    const row = byId(r, 'm1') as { note?: string; outcome: string };
    expect(row.outcome).toBe('as-expected');
    expect(row.note).toBe('no pattern matched');
    expect(JSON.stringify(rowsOf(r))).not.toMatch(/\bsafe\b/i);
  });

  it('the malformed call is sent as account-a with the derived arguments, counted in the budgets', async () => {
    const f = await fixture({ tools: STEP2_TOOLS, errorText: 'invalid arguments' });
    const { dir, file } = probeFile(malformed);
    const r = await scan(dir, active(f, file, { maxCalls: '1' }), TOKENS);
    const calls = probeFrames(f, r).filter((s) => s.rpc === 'tools/call');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.auth).toBe(`Bearer ${TOKEN_A}`);
    expect(r.json()['probes'].calls).toBe(1);
  });

  it('a malformed probe on a destructive tool is not sent without allowDestructive', async () => {
    const f = await fixture({ tools: STEP2_TOOLS, errorText: 'invalid arguments' });
    const { dir, file } = probeFile([{ ...malformed[0], tool: 'wipe' }]);
    const r = await scan(dir, active(f, file), TOKENS);
    expect(probeFrames(f, r).filter((s) => s.rpc === 'tools/call')).toEqual([]);
    expect(byId(r, 'm1').reason).toBe('destructive');
  });

  it('a tool with no property to break is "not run, no schema"', async () => {
    const f = await fixture({ tools: [{ name: 'export' }] });
    const { dir, file } = probeFile(malformed);
    const r = await scan(dir, active(f, file), TOKENS);
    expect(byId(r, 'm1').reason).toBe('no-schema');
    expect(probeFrames(f, r).filter((s) => s.rpc === 'tools/call')).toEqual([]);
  });

  it('the wrapper allows exactly the derived call for that entry: not its declared arguments, not other arguments, not another tool', async () => {
    const entries: ProbeEntry[] = [
      {
        id: 'm1',
        tool: 'export',
        arguments: { doc: 'declared' },
        as: 'account-a',
        malformed: true,
      },
    ];
    const sent: Frame[] = [];
    const guard = new ProbeGuard(entries, { maxCalls: 8, maxRequests: 40 }, async (frame) => {
      sent.push(frame);
      return { kind: 'http', status: 200 } as Reply;
    });
    guard.setListedTools(STEP2_TOOLS);
    const call = (name: string, args: Record<string, unknown>, probe = 'm1'): Frame => ({
      type: 'rpc',
      method: 'tools/call',
      params: { name, arguments: args },
      probe,
      credential: { kind: 'none' },
    });
    const derived = guard.malformedArgumentsFor('export')!;
    expect(derived).toEqual({});
    for (const bad of [
      call('export', { doc: 'declared' }),
      call('export', { doc: 'x', rm: '-rf' }),
      call('export', { ...derived, extra: 1 }),
      call('wipe', derived),
      call('export', derived, 'other-probe'),
    ])
      expect(await guard.send(bad)).toEqual({ sent: false, refusal: 'undeclared' });
    expect(sent).toHaveLength(0);
    expect((await guard.send(call('export', derived))).sent).toBe(true);
    expect(sent).toHaveLength(1);
    expect(guard.malformedArgumentsFor('nope')).toBeUndefined();
  });

  it('every pattern is linear: each runs on a hostile 64 KiB text in well under a second, and only the first 64 KiB is read', async () => {
    const { LEAK_PATTERNS, findLeak, MAX_LEAK_TEXT } = await import('../scan/probes/leak.js');
    expect(MAX_LEAK_TEXT).toBe(64 * 1024);
    const n = MAX_LEAK_TEXT;
    const hostile = [
      'a'.repeat(n),
      '/'.repeat(n),
      ' at '.repeat(n / 4),
      '(a'.repeat(n / 2),
      '/a'.repeat(n / 2),
      ('A:\\' + 'a'.repeat(30) + '\\').repeat(n / 34),
      '1.'.repeat(n / 2),
      'select '.repeat(n / 7),
      'a.b'.repeat(n / 3),
      'File "'.repeat(n / 6),
      '\t'.repeat(n),
      ' '.repeat(n),
    ];
    for (const p of LEAK_PATTERNS)
      for (const text of hostile) {
        const t = performance.now();
        p.re.test(text.slice(0, n));
        expect(performance.now() - t, p.id).toBeLessThan(250);
      }
    expect(findLeak(`${'a'.repeat(n)}\n    at f (/srv/x.js:1:2)`)).toBeUndefined();
    expect(findLeak('    at f (/srv/x.js:1:2)')).toBe('stack-js');
  });

  it('each pattern finds its own kind and not an ordinary message', async () => {
    const { findLeak } = await import('../scan/probes/leak.js');
    const hit: [string, string][] = [
      ['stack-js', 'Error: x\n    at run (/app/a.js:10:5)'],
      ['stack-py', 'Traceback (most recent call last):\n  File "/app/a.py", line 3, in f'],
      ['abs-path', 'cannot open /var/lib/app/data.db'],
      ['abs-path', 'cannot open C:\\Users\\app\\data.db'],
      ['sql', 'near "FROM users WHERE id = 1": syntax error'],
      ['internal-host', 'connect ECONNREFUSED 10.0.3.7:5432'],
      ['internal-host', 'getaddrinfo ENOTFOUND db.internal'],
    ];
    for (const [id, text] of hit) expect(findLeak(text), text).toBe(id);
    for (const text of [
      'invalid arguments',
      'missing required argument: doc',
      'Expected string, received number',
      'path /tools/0/name is invalid',
      'try again at 10:30',
    ])
      expect(findLeak(text), text).toBeUndefined();
  });
});

describe('CLI · mcp scan · scan/hint/destructive-missing (static)', () => {
  const snapOf = (tools: unknown[]) => {
    const dir = tmp();
    writeFileSync(
      join(dir, 's.json'),
      serializeSnapshot(
        buildSnapshot({ transport: 'stdio', capabilities: { tools: {} }, tools } as never),
      ),
    );
    return dir;
  };
  const rules = async (tools: unknown[]) => {
    const r = await scan(snapOf(tools), { snapshot: ['s.json'] });
    return { r, rules: (r.json()['findings'] as { rule: string }[]).map((x) => x.rule) };
  };

  it('annotations without destructiveHint, and not read-only: an info finding that does not gate, with no --active', async () => {
    const { r, rules: got } = await rules([
      { name: 'update_page', description: 'Updates a page.', annotations: { title: 'Update' } },
    ]);
    expect(got).toEqual(['scan/hint/destructive-missing']);
    expect(r.json()['findings'][0]).toMatchObject({ severity: 'info', gating: false });
    expect(r.code).toBe(0);
  });

  it('no finding: no annotations at all, destructiveHint stated either way, or readOnlyHint true', async () => {
    for (const annotations of [
      undefined,
      { destructiveHint: true },
      { destructiveHint: false },
      { readOnlyHint: true },
    ])
      expect(
        (
          await rules([
            { name: 'update_page', description: 'x', ...(annotations ? { annotations } : {}) },
          ])
        ).rules,
        JSON.stringify(annotations),
      ).toEqual([]);
  });
});

// ---- step 2, after review ---------------------------------------------------------------------------------------------------

describe('CLI · mcp scan probes · the journal never overwrites a file the command reads or writes', () => {
  const same = async (flags: (f: Fixture) => McpScanFlags, name: string) => {
    const f = await fixture({ tools: STEP2_TOOLS });
    const { dir } = probeFile(journalProbes);
    writeFileSync(
      join(dir, 's.json'),
      serializeSnapshot(
        buildSnapshot({
          transport: 'stdio',
          capabilities: { tools: {} },
          tools: [{ name: 'a', description: 'd' }],
        } as never),
      ),
    );
    const before = readFileSync(join(dir, name), 'utf8');
    const r = await scan(dir, flags(f), TOKENS);
    expect(r.code, r.err).toBe(2);
    expect(r.err).not.toContain(dir);
    expect(readFileSync(join(dir, name), 'utf8')).toBe(before);
    expect(f.seen.filter((s) => s.rpc === 'tools/call')).toEqual([]);
    return r;
  };

  it('--journal equal to --probes is exit 2 and the probe file is untouched', async () => {
    const r = await same(
      (f) => active(f, 'probes.json', { journal: 'probes.json' }),
      'probes.json',
    );
    expect(r.err).toContain('--journal');
    expect(r.err).toContain('--probes');
  });
  it('the same file spelled another way (./, a folder that is left again, other case on Windows) is the same file', async () => {
    await same((f) => active(f, 'probes.json', { journal: './sub/../probes.json' }), 'probes.json');
    if (process.platform === 'win32')
      await same((f) => active(f, 'probes.json', { journal: 'PROBES.JSON' }), 'probes.json');
  });
  it('through a link to the folder it is the same file as well', async () => {
    const f = await fixture({ tools: STEP2_TOOLS });
    const { dir } = probeFile(journalProbes);
    symlinkSync(dir, join(dir, 'link'), 'junction');
    const before = readFileSync(join(dir, 'probes.json'), 'utf8');
    const r = await scan(dir, active(f, 'probes.json', { journal: 'link/probes.json' }), TOKENS);
    expect(r.code).toBe(2);
    expect(readFileSync(join(dir, 'probes.json'), 'utf8')).toBe(before);
  });
  it('--journal equal to a --snapshot, --out or --save-snapshot file is exit 2', async () => {
    await same(
      (f) => active(f, 'probes.json', { journal: 's.json', snapshot: ['s.json'] }),
      's.json',
    );
    await same(
      (f) => active(f, 'probes.json', { journal: 'probes.json', out: ['probes.json'] }),
      'probes.json',
    );
    await same(
      (f) => active(f, 'probes.json', { journal: 's.json', saveSnapshot: 's.json' }),
      's.json',
    );
  });
  it('the reverse pairs: --out equal to --probes or to a --snapshot is exit 2 too', async () => {
    await same((f) => active(f, 'probes.json', { out: ['probes.json'] }), 'probes.json');
    await same(
      (f) => active(f, 'probes.json', { snapshot: ['s.json'], out: ['sarif=s.json'] }),
      's.json',
    );
  });
  it('a directory as the journal path is exit 2 with a plain message', async () => {
    const f = await fixture({ tools: STEP2_TOOLS });
    const { dir, file } = probeFile(journalProbes);
    mkdirSync(join(dir, 'a-folder'));
    const r = await scan(dir, active(f, file, { journal: 'a-folder' }), TOKENS);
    expect(r.code).toBe(2);
    expect(r.err).toContain('--journal');
    expect(r.err).not.toMatch(/EISDIR|EPERM|EACCES/);
    expect(r.err).not.toContain(dir);
  });
});

describe('CLI · mcp scan probes · a journal write that fails on any line marks the run', () => {
  const failOn = (n: number) => {
    let writes = 0;
    return {
      record: () => {
        if (++writes === n) throw new Error('disk full');
      },
      close: () => {},
    };
  };
  const one = async (n: number) => {
    const f = await fixture({ lax: true, tools: STEP2_TOOLS });
    return runProbes({
      entries: [entry('p1', 'none')] as ProbeEntry[],
      target: { kind: 'http', url: f.url, headers: {} } as never,
      tokens: {},
      timeoutMs: 5000,
      announce: () => {},
      journal: failOn(n),
    });
  };

  it('a failure on the last "in" line (nothing left to stop) is still reported as an incomplete journal', async () => {
    // lines: meta, then out/in for discovery, initialize, initialized, tools/list, tools/call = 1 + 2 * 5 = 11
    const section = await one(11);
    expect(section.journalFailed).toBe(true);
  });
  it('a failure on a "refused" line is reported too', async () => {
    const f = await fixture({ lax: true, tools: STEP2_TOOLS });
    let refusedWritten = 0;
    const section = await runProbes({
      entries: [entry('p1', 'none'), entry('p2', 'none')] as ProbeEntry[],
      target: { kind: 'http', url: f.url, headers: {} } as never,
      tokens: {},
      maxCalls: 1,
      timeoutMs: 5000,
      announce: () => {},
      journal: {
        record: (line) => {
          if (line['dir'] === 'refused' && ++refusedWritten === 1) throw new Error('disk full');
        },
      },
    });
    expect(section.journalFailed).toBe(true);
  });
  it('a clean journal is not marked', async () => {
    expect((await one(1000)).journalFailed).toBeUndefined();
  });
  it('the report says the journal is incomplete and the exit code is 3, with no probe left to run', () => {
    const input: ScanInput = {
      snapshots: [],
      unreadable: [],
      configFiles: [],
      configRequested: false,
      active: true,
      allowHosts: [],
      allowPackages: [],
      probes: {
        rows: [
          {
            id: 'p1',
            tool: 'export',
            as: 'none',
            expect: 'none',
            answer: 'allowed',
            outcome: 'observed',
          },
        ],
        findings: [],
        calls: 1,
        requests: 5,
        metadata: null,
        journalFailed: true,
      },
    };
    const report = runScan(input, { failOn: 'error', gateHeuristics: false, allowPartial: false });
    expect(report.exitCode).toBe(3);
    expect(JSON.stringify(report.notEvaluated)).toContain('journal');
  });
});

describe('CLI · mcp scan probes · the derived malformed arguments are bounded', () => {
  it('a giant required list, or a giant properties object, is "not run, schema too large": nothing is sent', async () => {
    const names = Array.from({ length: 300 }, (_, i) => `p${i}`);
    for (const schema of [
      { type: 'object', properties: { doc: { type: 'string' } }, required: names },
      { type: 'object', properties: Object.fromEntries(names.map((n) => [n, { type: 'string' }])) },
    ]) {
      const f = await fixture({ tools: [{ name: 'export', inputSchema: schema } as never] });
      const { dir, file } = probeFile([
        { id: 'm1', tool: 'export', arguments: {}, as: 'account-a', malformed: true },
      ]);
      const r = await scan(dir, active(f, file), TOKENS);
      expect(byId(r, 'm1').reason).toBe('schema-too-large');
      expect(probeFrames(f, r).filter((s) => s.rpc === 'tools/call')).toEqual([]);
    }
  });
  it('arguments over 16 KiB once derived are "schema too large" too', async () => {
    const { malformedArguments } = await import('../scan/probes/leak.js');
    const big = { type: 'object', properties: { a: {}, b: {} }, required: ['a', 'b'] };
    expect(malformedArguments(big)).toEqual({ b: null });
    const { derivedTooLarge } = await import('../scan/probes/leak.js');
    expect(derivedTooLarge({ x: 'y'.repeat(17 * 1024) })).toBe(true);
    expect(derivedTooLarge({ x: 'y' })).toBe(false);
  });
  it('__proto__ and constructor as names are own keys: the prototype is not touched', async () => {
    const { malformedArguments } = await import('../scan/probes/leak.js');
    const schema = JSON.parse(
      '{"properties":{"a":{},"__proto__":{"type":"string"},"constructor":{"type":"constructor"}},"required":["a","__proto__","constructor"]}',
    );
    const args = malformedArguments(schema)!;
    expect(Object.getPrototypeOf(args)).toBe(Object.prototype);
    expect(Object.keys(args)).toEqual(['__proto__', 'constructor']);
    expect(Object.hasOwn(args, '__proto__')).toBe(true);
    expect(args['constructor']).toBeNull();
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(args['__proto__']).toBe('');
  });
});

describe('CLI · mcp scan probes · a malformed call that ran says so', () => {
  const malformed = [{ id: 'm1', tool: 'export', arguments: {}, as: 'account-a', malformed: true }];
  it('a result with no error is "ran; no error text to read", in every format that lists the rows; not "no pattern matched"', async () => {
    const f = await fixture({ tools: STEP2_TOOLS });
    const { dir, file } = probeFile(malformed);
    for (const format of ['human', 'json', 'sarif'] as const) {
      const r = await scan(dir, active(f, file, { format }), TOKENS);
      expect(r.out, format).toContain('ran; no error text to read');
      expect(r.out, format).not.toContain('no pattern matched');
    }
    const r = await scan(dir, active(f, file, { out: ['junit-xml=j.xml'] }), TOKENS);
    expect(readFileSync(join(dir, 'j.xml'), 'utf8')).toContain('ran; no error text to read');
    expect(r.code).toBe(0);
  });
  it('an error that was read and matched nothing is still "no pattern matched"', async () => {
    const f = await fixture({ tools: STEP2_TOOLS, errorText: 'invalid arguments' });
    const { dir, file } = probeFile(malformed);
    const r = await scan(dir, active(f, file), TOKENS);
    expect((byId(r, 'm1') as { note?: string }).note).toBe('no pattern matched');
  });
});

describe('CLI · mcp scan · smaller points of the review of step 2', () => {
  it('destructiveHint that is not a boolean is not "present" for scan/hint/destructive-missing', async () => {
    for (const destructiveHint of [null, 'false', 0]) {
      const dir = tmp();
      writeFileSync(
        join(dir, 's.json'),
        serializeSnapshot(
          buildSnapshot({
            transport: 'stdio',
            capabilities: { tools: {} },
            tools: [{ name: 'update_page', description: 'x', annotations: { destructiveHint } }],
          } as never),
        ),
      );
      const r = await scan(dir, { snapshot: ['s.json'] });
      expect(
        (r.json()['findings'] as { rule: string }[]).map((x) => x.rule),
        String(destructiveHint),
      ).toEqual(['scan/hint/destructive-missing']);
    }
  });

  it('the wrapper refuses a malformed frame whose entry is not account-a, called directly', async () => {
    const entries: ProbeEntry[] = [
      { id: 'm1', tool: 'export', arguments: {}, as: 'none', malformed: true },
    ];
    const sent: Frame[] = [];
    const guard = new ProbeGuard(entries, { maxCalls: 8, maxRequests: 40 }, async (frame) => {
      sent.push(frame);
      return { kind: 'http', status: 200 } as Reply;
    });
    guard.setListedTools(STEP2_TOOLS);
    const frame: Frame = {
      type: 'rpc',
      method: 'tools/call',
      params: { name: 'export', arguments: guard.malformedArgumentsFor('export') },
      probe: 'm1',
      credential: { kind: 'none' },
    };
    expect(await guard.send(frame)).toEqual({ sent: false, refusal: 'undeclared' });
    expect(sent).toHaveLength(0);
  });
});

// ---- step 2, second review ---------------------------------------------------------------------------------------------------

describe('CLI · mcp scan probes · the journal path guard compares files, not spellings', () => {
  it('a hard link to the probe file as the journal is exit 2, nothing is sent, the probe file is untouched', async () => {
    const f = await fixture({ tools: STEP2_TOOLS });
    const { dir } = probeFile(journalProbes);
    linkSync(join(dir, 'probes.json'), join(dir, 'hard.json'));
    const before = readFileSync(join(dir, 'probes.json'), 'utf8');
    const r = await scan(dir, active(f, 'probes.json', { journal: 'hard.json' }), TOKENS);
    expect(r.code, r.err).toBe(2);
    expect(f.seen.filter((s) => s.rpc === 'tools/call')).toEqual([]);
    expect(readFileSync(join(dir, 'probes.json'), 'utf8')).toBe(before);
  });

  it('an 8.3 short name of the probe file as the journal is exit 2 (skipped where the volume has no short names)', async (ctx) => {
    const dir = tmp();
    const long = join(dir, 'probes-long-name.json');
    writeFileSync(long, JSON.stringify({ probes: journalProbes }));
    let short = '';
    if (process.platform === 'win32') {
      try {
        const listing = execSync(`dir /x "${dir}"`, { encoding: 'utf8' });
        const line = listing.split(/\r?\n/).find((l) => l.includes('probes-long-name.json')) ?? '';
        short = join(dir, line.trim().split(/\s+/).at(-2) ?? '');
      } catch {
        short = '';
      }
    }
    if (!basename(short).includes('~') || !existsSync(short)) return ctx.skip();
    const f = await fixture({ tools: STEP2_TOOLS });
    const before = readFileSync(long, 'utf8');
    const r = await scan(
      dir,
      active(f, 'probes-long-name.json', { journal: basename(short) }),
      TOKENS,
    );
    expect(r.code, r.err).toBe(2);
    expect(readFileSync(long, 'utf8')).toBe(before);
    expect(f.seen.filter((s) => s.rpc === 'tools/call')).toEqual([]);
  });
});

describe('CLI · mcp scan probes · an incomplete journal is in JUnit too', () => {
  const junitOf = async (
    extra: Partial<Parameters<typeof runProbes>[0]>,
    writeFails: (l: Record<string, unknown>, n: number) => boolean,
  ) => {
    const f = await fixture({ lax: true, tools: STEP2_TOOLS });
    let n = 0;
    const section = await runProbes({
      entries: [entry('p1', 'none')] as ProbeEntry[],
      target: { kind: 'http', url: f.url, headers: {} } as never,
      tokens: {},
      timeoutMs: 5000,
      announce: () => {},
      journal: {
        record: (l) => {
          if (writeFails(l, ++n)) throw new Error('disk full');
        },
      },
      ...extra,
    });
    const input: ScanInput = {
      snapshots: [],
      unreadable: [],
      configFiles: [],
      configRequested: false,
      active: true,
      allowHosts: [],
      allowPackages: [],
      probes: section,
    };
    const report = runScan(input, { failOn: 'error', gateHeuristics: false, allowPartial: false });
    return renderScan(report, 'junit-xml', ALL_RULES, '0');
  };
  it('a failure on the last "in" line, and on a "refused" line, say so in the XML', async () => {
    expect(await junitOf({}, (_l, n) => n === 11)).toContain(
      'the journal (--journal) could not be written',
    );
    expect(
      await junitOf(
        { entries: [entry('p1', 'none'), entry('p2', 'none')] as ProbeEntry[], maxCalls: 1 },
        (l) => l['dir'] === 'refused',
      ),
    ).toContain('the journal (--journal) could not be written');
  });
});

describe('CLI · mcp scan probes · a malformed destructiveHint blocks, and a control that ran is a JUnit pass', () => {
  it('the wrapper blocks on true and on any non-boolean that is present; false, null and absent do not block', async () => {
    const cases: [unknown, boolean][] = [
      [true, true],
      [false, false],
      [undefined, false],
      [null, false],
      ['true', true],
      ['false', true],
      [1, true],
      [0, true],
      [{}, true],
    ];
    for (const [hint, blocked] of cases) {
      const sent: Frame[] = [];
      const guard = new ProbeGuard(
        [{ id: 'p1', tool: 'wipe', arguments: {}, as: 'none' }],
        { maxCalls: 8, maxRequests: 40 },
        async (frame) => {
          sent.push(frame);
          return { kind: 'http', status: 200 } as Reply;
        },
      );
      guard.setListedTools([
        { name: 'wipe', annotations: hint === undefined ? {} : { destructiveHint: hint } },
      ]);
      const got = await guard.send({
        type: 'rpc',
        method: 'tools/call',
        params: { name: 'wipe', arguments: {} },
        probe: 'p1',
        credential: { kind: 'none' },
      });
      expect(got.sent, String(hint)).toBe(!blocked);
    }
  });

  it('a control that ran and was allowed is a passed test case, not a skipped one', async () => {
    const f = await fixture({ tools: STEP2_TOOLS });
    const { dir, file } = probeFile(journalProbes);
    await scan(dir, active(f, file, { out: ['junit-xml=j.xml'] }), TOKENS);
    const xml = readFileSync(join(dir, 'j.xml'), 'utf8');
    const m = /<testcase [^>]*name="probe p-a"[^>]*?(\/>|>[\s\S]*?<\/testcase>)/.exec(xml);
    expect(m).not.toBeNull();
    expect(m![1]).not.toContain('<skipped');
  });
});
