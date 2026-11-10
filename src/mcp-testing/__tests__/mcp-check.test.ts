// `plune mcp check` end to end against real servers: the stdio fixture (./fixtures/check-server.mjs) as a process, and
// the same server over Streamable HTTP on 127.0.0.1. Nothing here reaches past this machine.

import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProgram } from '../../cli.js';
import { handleMcpCheck, type McpCheckFlags } from '../../cli/commands/mcp-check.js';
import type { McpCheckReport } from '../result.js';
import { checkServer } from './fixtures/check-server.mjs';
import { streamableServer } from './fixtures/http-servers.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/check-server.mjs', import.meta.url));
const HOSTILE = fileURLToPath(new URL('./fixtures/check-hostile.mjs', import.meta.url));

const servers: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

const tmp = () => mkdtempSync(join(tmpdir(), 'plune-check-'));

interface Run {
  code: number;
  out: string;
  err: string;
  ms: number;
}

async function check(
  opts: {
    mode?: string;
    flags?: McpCheckFlags;
    server?: string[];
    env?: NodeJS.ProcessEnv;
    onErr?: (text: string) => void;
  } = {},
): Promise<Run> {
  let out = '';
  let err = '';
  const server =
    opts.server ?? (opts.mode === undefined ? [] : [process.execPath, FIXTURE, opts.mode]);
  const started = Date.now();
  const code = await handleMcpCheck({ timeout: '20s', ...opts.flags }, server, {
    out: (s) => (out += s),
    err: (s) => {
      opts.onErr?.(s);
      err += s;
    },
    env: opts.env ?? {},
    clientVersion: '9.9.9',
  });
  return { code, out, err, ms: Date.now() - started };
}

async function json(
  opts: Parameters<typeof check>[0] = {},
): Promise<{ code: number; report: McpCheckReport; ms: number }> {
  const run = await check({ ...opts, flags: { ...opts.flags, format: 'json' } });
  return { code: run.code, report: JSON.parse(run.out) as McpCheckReport, ms: run.ms };
}

const states = (report: McpCheckReport) =>
  report.checks.map((c) => `${c.id} ${c.state}${c.timedOut === true ? ' timedOut' : ''}`);
const calls = (report: McpCheckReport) =>
  (report.smoke?.calls ?? []).map((c) => `${c.tool} ${c.state}`);
const callLog = (log: string) =>
  existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').sort() : [];

/** The fixture over Streamable HTTP, stateless: a fresh SDK server per request. */
async function httpServer(mode: string, port = 0): Promise<string> {
  const server: HttpServer = createServer((req, res) => {
    if (!req.url?.startsWith('/mcp')) {
      res.writeHead(404).end();
      return;
    }
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    void checkServer(mode)
      .connect(transport)
      .then(() => transport.handleRequest(req, res));
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  servers.push({
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
}

/** A port nothing listens on, for now. */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

const HEALTHY = [
  'start passed',
  'initialize passed',
  'protocol-version passed',
  'capabilities passed',
  'tools-list passed',
  'resources-list passed',
  'resource-templates-list passed',
  'prompts-list passed',
  'ping passed',
];

describe('CLI · mcp check · health checks and exit codes', () => {
  it('CLI · mcp check · a healthy stdio server: every check passed, lists read to the end, exit 0 (AC-1)', async () => {
    const { code, report } = await json({ mode: 'healthy' });
    expect(states(report)).toEqual(HEALTHY);
    expect(report.checks.find((c) => c.id === 'tools-list')).toMatchObject({ count: 2 });
    expect(report.checks.find((c) => c.id === 'tools-list')?.detail).toContain('2 pages');
    expect(report).toMatchObject({
      schemaVersion: 1,
      command: 'check',
      plune: '9.9.9',
      server: { name: 'check-healthy', version: '2.0.0' },
      transport: 'stdio',
      protocolVersion: '2025-11-25',
      smoke: null,
      writeCallsAllowed: false,
      exitCode: 0,
    });
    expect(code).toBe(0);
  });

  it('CLI · mcp check · a healthy Streamable HTTP server: every check passed, exit 0 (AC-1)', async () => {
    const { code, report } = await json({ flags: { url: await httpServer('healthy') } });
    expect(states(report)).toEqual(HEALTHY);
    expect(report.transport).toBe('http');
    expect(code).toBe(0);
  });

  it('CLI · mcp check · a capability the server did not declare is not-applicable, and does not fail the run (AC-2)', async () => {
    const { code, report } = await json({ mode: 'tools-only' });
    expect(states(report)).toEqual([
      'start passed',
      'initialize passed',
      'protocol-version passed',
      'capabilities passed',
      'tools-list passed',
      'resources-list not-applicable',
      'resource-templates-list not-applicable',
      'prompts-list not-applicable',
      'ping passed',
    ]);
    expect(report.checks.find((c) => c.id === 'capabilities')?.detail).toBe('declared: tools');
    expect(code).toBe(0);
  });

  it('CLI · mcp check · a declared capability whose list answers with an error is failed, exit 1 (AC-2)', async () => {
    const { code, report } = await json({ mode: 'resources-error' });
    const resources = report.checks.find((c) => c.id === 'resources-list');
    expect(resources?.state).toBe('failed');
    expect(resources?.detail).toContain('the list is broken');
    expect(report.checks.find((c) => c.id === 'resource-templates-list')?.state).toBe('passed');
    expect(code).toBe(1);
  });

  it('CLI · mcp check · a server that never answers tools/list: could-not-run with timedOut, exit 3, not 1 and not 0 (AC-3)', async () => {
    const { code, report } = await json({ mode: 'hang-tools', flags: { checkTimeout: '500ms' } });
    expect(report.checks.find((c) => c.id === 'tools-list')).toEqual({
      id: 'tools-list',
      state: 'could-not-run',
      detail: 'no answer within --check-timeout (500ms)',
      timedOut: true,
    });
    expect(report.checks.find((c) => c.id === 'ping')?.state).toBe('passed');
    expect(code).toBe(3);
  });

  it('CLI · mcp check · a server silent after the handshake: two timeouts, then the rest could-not-run without timedOut, within 2 × --check-timeout (AC-4)', async () => {
    const { code, report, ms } = await json({ mode: 'hang-all', flags: { checkTimeout: '2s' } });
    expect(states(report)).toEqual([
      'start passed',
      'initialize passed',
      'protocol-version passed',
      'capabilities passed',
      'tools-list could-not-run timedOut',
      'resources-list could-not-run timedOut',
      'resource-templates-list could-not-run',
      'prompts-list could-not-run',
      'ping could-not-run',
    ]);
    expect(report.checks.find((c) => c.id === 'ping')?.detail).toBe(
      'skipped after two timeouts in a row',
    );
    const checking = report.timing.checks.reduce((sum, c) => sum + c.ms, 0);
    expect(checking).toBeLessThan(2 * 2_000 + 300);
    expect(ms).toBeLessThan(2 * 2_000 + 3_000);
    expect(code).toBe(3);
  }, 15_000);

  it('CLI · mcp check · an older protocol version than this client offers is information, not a failure', async () => {
    const { code, report } = await json({ mode: 'old-protocol' });
    expect(report.protocolVersion).toBe('2025-06-18');
    const check = report.checks.find((c) => c.id === 'protocol-version');
    expect(check?.state).toBe('passed');
    expect(check?.detail).toBe('2025-06-18, older than the 2025-11-25 this client offered');
    expect(code).toBe(0);
  });
});

describe('CLI · mcp check · a server that does not start or refuses', () => {
  it('CLI · mcp check · a process that exits before initialize: initialize failed with its stderr tail, masked, exit 1 (AC-6)', async () => {
    const { code, report } = await json({
      mode: 'crash',
      flags: { env: ['API_TOKEN=check-secret-token-1234'] },
    });
    expect(states(report).slice(0, 2)).toEqual(['start passed', 'initialize failed']);
    expect(report.checks.slice(2).every((c) => c.state === 'could-not-run')).toBe(true);
    expect(report.stderrTail).toContain('fatal: cannot open the database');
    expect(report.stderrTail).toContain('starting with API_TOKEN=***');
    expect(JSON.stringify(report)).not.toContain('check-secret-token-1234');
    expect(code).toBe(1);
    const human = await check({ mode: 'crash' });
    expect(human.out).toContain('The last lines the server wrote to stderr:');
    expect(human.out).toContain('  fatal: cannot open the database');
  });

  it('CLI · mcp check · a command that does not exist exits 2 (AC-6)', async () => {
    const run = await check({ server: ['plune-no-such-server-command'] });
    expect(run.code).toBe(2);
    expect(run.err).toMatch(/server command/i);
    expect(run.out).toBe('');
  });

  it('CLI · mcp check · a 401 exits 2 and says to add --header-env (AC-6)', async () => {
    const platform = await streamableServer({ token: 'right-token-123456' });
    servers.push(platform);
    const run = await check({ flags: { url: `${platform.origin}/mcp` } });
    expect(run.code).toBe(2);
    expect(run.err).toContain('--header-env');
    expect(run.out).toBe('');
  });

  it('CLI · mcp check · --wait gives a server that starts 2 s later the time to come up (AC-13)', async () => {
    const port = await freePort();
    const late = setTimeout(() => void httpServer('healthy', port), 2_000);
    try {
      const { code, report } = await json({
        flags: { url: `http://127.0.0.1:${port}/mcp`, wait: '5s' },
      });
      expect(states(report)).toEqual(HEALTHY);
      expect(code).toBe(0);
    } finally {
      clearTimeout(late);
    }
  }, 15_000);

  it('CLI · mcp check · --wait on a server that never starts exits 2 once the wait is over (AC-13)', async () => {
    const port = await freePort();
    const run = await check({ flags: { url: `http://127.0.0.1:${port}/mcp`, wait: '5s' } });
    expect(run.code).toBe(2);
    expect(run.err).toContain('--wait 5s');
    expect(run.ms).toBeGreaterThanOrEqual(5_000);
    expect(run.ms).toBeLessThan(5_000 + 3_000);
  }, 15_000);
});

describe('CLI · mcp check · --smoke', () => {
  it('CLI · mcp check · without --smoke no tool is called (AC-7)', async () => {
    const log = join(tmp(), 'calls.log');
    const { code, report } = await json({
      mode: 'smoke',
      flags: { env: [`FIXTURE_CALL_LOG=${log}`] },
    });
    expect(existsSync(log)).toBe(false);
    expect(report.smoke).toBeNull();
    expect(code).toBe(0);
  });

  it('CLI · mcp check · --smoke calls only read-only, non-destructive tools without required parameters; the rest is not-applicable with a reason (AC-8)', async () => {
    const log = join(tmp(), 'calls.log');
    const { code, report } = await json({
      mode: 'smoke',
      flags: { smoke: true, env: [`FIXTURE_CALL_LOG=${log}`] },
    });
    expect(callLog(log)).toEqual(['read_error', 'read_ok', 'read_rpc_error']);
    expect(report.smoke?.calls).toEqual([
      { tool: 'read_ok', state: 'passed', detail: 'answered without isError' },
      { tool: 'read_error', state: 'failed', detail: 'isError: the cache is cold' },
      {
        tool: 'read_rpc_error',
        state: 'failed',
        detail: 'a JSON-RPC error: MCP error -32603: internal failure in read_rpc_error',
      },
      { tool: 'no_hints', state: 'not-applicable', detail: 'not-read-only' },
      { tool: 'read_needs_arg', state: 'not-applicable', detail: 'required-arguments' },
      { tool: 'write_safe', state: 'not-applicable', detail: 'not-read-only' },
      { tool: 'read_wipe', state: 'not-applicable', detail: 'destructive' },
      { tool: 'write_wipe', state: 'not-applicable', detail: 'not-read-only' },
    ]);
    expect(report.smoke).toMatchObject({ limit: 5, timeout: '15s', budget: '60s' });
    expect(report.writeCallsAllowed).toBe(false);
    expect(code).toBe(1);
  });

  it('CLI · mcp check · --smoke-limit bounds the calls; the tools past it are not-applicable (AC-9)', async () => {
    const log = join(tmp(), 'calls.log');
    const { report } = await json({
      mode: 'smoke',
      flags: { smoke: true, smokeLimit: '1', env: [`FIXTURE_CALL_LOG=${log}`] },
    });
    expect(callLog(log)).toEqual(['read_ok']);
    expect(calls(report).slice(0, 3)).toEqual([
      'read_ok passed',
      'read_error not-applicable',
      'read_rpc_error not-applicable',
    ]);
    expect(report.smoke?.calls[1]?.detail).toBe('smoke-limit');
  });

  it('CLI · mcp check · two smoke timeouts in a row end the mode; the tool not reached could-not-run, exit 3 (AC-9)', async () => {
    const log = join(tmp(), 'calls.log');
    const { code, report } = await json({
      mode: 'smoke-hang',
      flags: { smoke: true, smokeTimeout: '300ms', env: [`FIXTURE_CALL_LOG=${log}`] },
    });
    expect(callLog(log)).toEqual(['slow_a', 'slow_b']);
    expect(report.smoke?.calls).toEqual([
      {
        tool: 'slow_a',
        state: 'could-not-run',
        detail: 'no answer within --smoke-timeout (300ms)',
        timedOut: true,
      },
      {
        tool: 'slow_b',
        state: 'could-not-run',
        detail: 'no answer within --smoke-timeout (300ms)',
        timedOut: true,
      },
      { tool: 'read_ok', state: 'could-not-run', detail: 'skipped after two timeouts in a row' },
    ]);
    expect(code).toBe(3);
  });

  it('CLI · mcp check · --budget bounds the whole mode (AC-9)', async () => {
    const { code, report } = await json({
      mode: 'smoke-slow',
      flags: { smoke: true, budget: '1s' },
    });
    // Each call takes 700 ms: the first fits, the second gets the 300 ms left, the rest get nothing.
    expect(calls(report)).toEqual([
      'slow_1 passed',
      'slow_2 could-not-run',
      'slow_3 could-not-run',
      'slow_4 could-not-run',
    ]);
    expect(report.smoke?.calls[1]).toMatchObject({
      timedOut: true,
      detail: 'the --budget (1s) was spent',
    });
    expect(report.smoke?.calls[3]).toEqual({
      tool: 'slow_4',
      state: 'could-not-run',
      detail: 'the --budget (1s) was spent',
    });
    const smoking = report.timing.calls.reduce((sum, c) => sum + c.ms, 0);
    expect(smoking).toBeLessThan(1_000 + 300);
    expect(code).toBe(3);
  });

  it('CLI · mcp check · --allow-write-calls calls tools without readOnlyHint too, warns on stderr first, never calls a destructive one (AC-10)', async () => {
    const log = join(tmp(), 'calls.log');
    let warnedBeforeCalls: boolean | undefined;
    const run = await check({
      mode: 'smoke',
      flags: {
        smoke: true,
        allowWriteCalls: true,
        format: 'json',
        env: [`FIXTURE_CALL_LOG=${log}`],
      },
      onErr: (text) => {
        if (text.includes('readOnlyHint')) warnedBeforeCalls ??= !existsSync(log);
      },
    });
    expect(warnedBeforeCalls).toBe(true);
    expect(run.err).toContain('may change data');
    const report = JSON.parse(run.out) as McpCheckReport;
    expect(callLog(log)).toEqual(['read_error', 'read_ok', 'read_rpc_error', 'write_safe']);
    expect(report.writeCallsAllowed).toBe(true);
    expect(report.smoke?.calls.filter((c) => c.state === 'not-applicable')).toEqual([
      { tool: 'no_hints', state: 'not-applicable', detail: 'no-destructive-hint' },
      { tool: 'read_needs_arg', state: 'not-applicable', detail: 'required-arguments' },
      { tool: 'read_wipe', state: 'not-applicable', detail: 'destructive' },
      { tool: 'write_wipe', state: 'not-applicable', detail: 'destructive' },
    ]);
  });
});

describe('CLI · mcp check · the artifact', () => {
  it('CLI · mcp check · --out holds no URL, command, env, header or secret value; the stderr tail is masked (AC-11)', async () => {
    const dir = tmp();
    const out = join(dir, 'check.json');
    const token = 'check-secret-token-5678';
    await check({
      mode: 'stderr-token',
      flags: { out, smoke: true, allowWriteCalls: true, env: [`API_TOKEN=${token}`] },
    });
    const bytes = readFileSync(out, 'utf8');
    const report = JSON.parse(bytes) as McpCheckReport;
    expect(report.stderrTail).toEqual(['starting with API_TOKEN=***']);
    expect(report.writeCallsAllowed).toBe(true);
    for (const leak of [token, 'check-server.mjs', process.execPath, 'API_TOKEN=check', 'FIXTURE'])
      expect(bytes).not.toContain(leak);

    const platform = await streamableServer({ token: 'header-secret-value-9012' });
    servers.push(platform);
    const httpOut = join(dir, 'http.json');
    await check({
      flags: {
        url: `${platform.origin}/mcp?token=query-secret-3456`,
        headerEnv: ['Authorization=MCP_AUTH'],
        out: httpOut,
      },
      env: { MCP_AUTH: 'Bearer header-secret-value-9012' },
    });
    const httpBytes = readFileSync(httpOut, 'utf8');
    for (const leak of [
      'header-secret-value-9012',
      'query-secret-3456',
      platform.origin,
      '127.0.0.1',
      'Authorization',
    ])
      expect(httpBytes).not.toContain(leak);
    expect((JSON.parse(httpBytes) as McpCheckReport).transport).toBe('http');
  });

  it('CLI · mcp check · two runs on the same server give the same JSON but for timing (AC-12)', async () => {
    const withoutTiming = (text: string) => {
      const { timing, ...rest } = JSON.parse(text) as McpCheckReport;
      expect(timing.totalMs).toBeGreaterThan(0);
      return JSON.stringify(rest, null, 2);
    };
    const first = await check({ mode: 'smoke', flags: { smoke: true, format: 'json' } });
    const second = await check({ mode: 'smoke', flags: { smoke: true, format: 'json' } });
    expect(withoutTiming(first.out)).toBe(withoutTiming(second.out));
    expect(first.out.endsWith('}\n')).toBe(true);
    expect(Object.keys(JSON.parse(first.out) as object).at(-1)).toBe('timing');
  });

  it('CLI · mcp check · the human report: one row per check, the smoke calls, and what the exit code means', async () => {
    const run = await check({ mode: 'smoke', flags: { smoke: true } });
    expect(run.out.startsWith('Server: check-smoke 2.0.0 · stdio · protocol 2025-11-25\n')).toBe(
      true,
    );
    expect(run.out).toMatch(/^passed +tools-list +8 tools in 1 page$/m);
    expect(run.out).toMatch(/^not-applicable +prompts-list +the server does not declare prompts$/m);
    expect(run.out).toMatch(/^ {2}failed +read_error +isError: the cache is cold$/m);
    expect(run.out).toContain('  1 tool not called: destructive (read_wipe)');
    expect(run.out).toContain(
      '  3 tools not called: not-read-only (no_hints, write_safe, write_wipe)',
    );
    expect(run.out).toContain('Failed: at least one check or smoke call failed.');
  });
});

describe('CLI · mcp check · flags', () => {
  it.each([
    [{ checkTimeout: 'soon' }, '--check-timeout'],
    [{ format: 'xml' }, '--format'],
    [{ smoke: true, smokeLimit: '0' }, '--smoke-limit'],
    [{ smoke: true, smokeTimeout: '0s' }, '--smoke-timeout'],
    [{ smoke: true, budget: 'x' }, '--budget'],
    [{ allowWriteCalls: true }, '--allow-write-calls'],
    [{ wait: '5s' }, '--wait'],
    [{ wait: 'later' }, '--wait'],
  ] as [McpCheckFlags, string][])(
    'CLI · mcp check · a wrong %o is a usage error, exit 2',
    async (flags, name) => {
      const run = await check({ mode: 'healthy', flags });
      expect(run.code).toBe(2);
      expect(run.err).toContain(name);
      expect(run.out).toBe('');
    },
  );

  it('CLI · mcp check · no server named is a usage error, exit 2', async () => {
    const run = await check();
    expect(run.code).toBe(2);
    expect(run.err).toContain('Name a server');
  });

  it('CLI · mcp check · plune mcp check is wired: flags reach the command and its code becomes the exit code', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const before = process.exitCode;
    try {
      await createProgram().parseAsync(
        ['mcp', 'check', '--format', 'json', '--', process.execPath, FIXTURE, 'tools-only'],
        { from: 'user' },
      );
      expect(process.exitCode).toBe(0);
      const printed = write.mock.calls.map((c) => String(c[0])).join('');
      expect((JSON.parse(printed) as McpCheckReport).command).toBe('check');
    } finally {
      write.mockRestore();
      process.exitCode = before;
    }
  });

  it('CLI · mcp check · the command imports only node, the MCP client and this repository; the README names it (AC-14)', () => {
    const root = new URL('../../../', import.meta.url);
    const files = [
      'src/cli/commands/mcp-check.ts',
      'src/mcp-testing/check/run.ts',
      'src/mcp-testing/check/steps.ts',
      'src/mcp-testing/connect/tools.ts',
    ];
    const specifiers = files.flatMap((f) =>
      [...readFileSync(new URL(f, root), 'utf8').matchAll(/^import [^']*'([^']+)';$/gm)].map(
        (m) => m[1]!,
      ),
    );
    expect(specifiers.length).toBeGreaterThan(10);
    expect(
      specifiers.filter(
        (s) => !s.startsWith('.') && !s.startsWith('node:') && s !== '@modelcontextprotocol/client',
      ),
    ).toEqual([]);
    expect(readFileSync(new URL('README.md', root), 'utf8')).toContain('plune mcp check');
  });
});

describe('CLI · mcp check · hostile servers', () => {
  const hostile = (mode: string) => [process.execPath, HOSTILE, mode];

  it('CLI · mcp check · one tools/list page of 150 000 entries is read whole, exit 0', async () => {
    const { code, report } = await json({ server: hostile('biglist') });
    expect(report.checks.find((c) => c.id === 'tools-list')).toMatchObject({
      state: 'passed',
      count: 150_000,
    });
    expect(code).toBe(0);
  }, 30_000);

  it('CLI · mcp check · 200 000 tools under --smoke: the human report prints, its exit code is the one --out records', async () => {
    const out = join(tmp(), 'big.json');
    const run = await check({ server: hostile('bigpaged'), flags: { smoke: true, out } });
    const report = JSON.parse(readFileSync(out, 'utf8')) as McpCheckReport;
    expect(run.code).toBe(report.exitCode);
    expect(report.smoke?.calls).toHaveLength(200_000);
    expect(run.out).toContain('  199995 tools not called: smoke-limit');
    expect(run.out).toContain('Smoke: 5 passed, 0 failed, 0 could not run, 199995 not called');
    expect(run.out.split('\n').length).toBeLessThan(100);
  }, 60_000);

  it('CLI · mcp check · arguments of the server command are masked in the stderr tail and in --out', async () => {
    const out = join(tmp(), 'argv.json');
    const run = await check({
      server: [...hostile('argv'), '--api-key', 'sk-live-abcdef123456'],
      flags: { out },
    });
    expect(run.code).toBe(1);
    const bytes = readFileSync(out, 'utf8');
    expect(bytes).toContain('args: argv *** ***');
    expect(bytes).not.toContain('sk-live-abcdef123456');
    expect(run.out).not.toContain('sk-live-abcdef123456');
  });

  it('CLI · mcp check · megabytes of error text from the server are cut: --out stays under 50 KB', async () => {
    const out = join(tmp(), 'bigerror.json');
    const { report } = await json({ server: hostile('bigerror'), flags: { smoke: true, out } });
    expect(statSync(out).size).toBeLessThan(50_000);
    const ping = report.checks.find((c) => c.id === 'ping');
    expect(ping?.state).toBe('failed');
    expect(ping?.detail).toMatch(/… \(cut: \d+ characters\)$/);
    expect(report.smoke?.calls[0]?.state).toBe('failed');
  }, 30_000);

  it('CLI · mcp check · a duration past what a timer can hold is a usage error, exit 2', async () => {
    for (const flags of [
      { checkTimeout: '30d' },
      { smoke: true, smokeTimeout: '25d' },
      { smoke: true, budget: '30d' },
      { timeout: '30d' },
    ] as McpCheckFlags[]) {
      const run = await check({ mode: 'healthy', flags });
      expect(run.code).toBe(2);
      expect(run.err).toContain('2147483647 ms');
    }
  });

  it('CLI · mcp check · the human report counts the smoke calls beside the checks', async () => {
    const run = await check({ mode: 'smoke-slow', flags: { smoke: true, budget: '1s' } });
    expect(run.code).toBe(3);
    expect(run.out).toContain('Smoke: 1 passed, 0 failed, 3 could not run, 0 not called');
  });

  it('CLI · mcp check · after a list times out no further page is asked for', async () => {
    const debugOut = join(tmp(), 'journal.jsonl');
    const { code, report } = await json({
      server: hostile('slowpages'),
      flags: { checkTimeout: '2s', debugOut },
    });
    expect(report.checks.find((c) => c.id === 'tools-list')?.timedOut).toBe(true);
    expect(code).toBe(3);
    const pages = readFileSync(debugOut, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { dir: string; dtMs: number; frame?: { method?: string } })
      .filter((l) => l.dir === 'out' && l.frame?.method === 'tools/list')
      .map((l) => l.dtMs);
    expect(pages.length).toBeGreaterThan(0);
    expect(pages.at(-1)! - pages[0]!).toBeLessThan(2_000);
  }, 15_000);

  it('CLI · mcp check · --smoke calls no tool whose schema or hints make a call unsafe', async () => {
    const log = join(tmp(), 'calls.log');
    const { code, report } = await json({
      server: hostile('trick'),
      flags: { smoke: true, allowWriteCalls: true, env: [`FIXTURE_CALL_LOG=${log}`] },
    });
    expect(existsSync(log)).toBe(false);
    expect(report.smoke?.calls.map((c) => `${c.tool} ${c.detail}`)).toEqual([
      'allof_required required-arguments',
      'anyof_required required-arguments',
      'oneof_required required-arguments',
      'ref_required required-arguments',
      'dependent_required required-arguments',
      'min_properties required-arguments',
      'read_only_string no-destructive-hint',
      'destructive_string destructive',
      'destructive_number destructive',
    ]);
    expect(code).toBe(3);
  });

  it('CLI · mcp check · a 401 after the handshake exits 2 with the --header-env hint, not as a lost connection', async () => {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += String(c)));
      req.on('end', () => {
        const msg = (body === '' ? {} : JSON.parse(body)) as {
          id?: number;
          method?: string;
          params?: { protocolVersion?: string };
        };
        if (msg.id === undefined) return void res.writeHead(202).end();
        if (msg.method !== 'initialize')
          return void res.writeHead(401, { 'www-authenticate': 'Bearer' }).end('need auth');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              protocolVersion: msg.params?.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: 'auth-later', version: '1' },
            },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push({
      close: () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    });
    const port = (server.address() as AddressInfo).port;
    const run = await check({ flags: { url: `http://127.0.0.1:${port}/mcp` } });
    expect(run.code).toBe(2);
    expect(run.err).toContain('--header-env');
    expect(run.err).not.toContain('connection was lost');
    expect(run.out).toBe('');
  });

  it('CLI · mcp check · resources without resource templates (Method not found) is not-applicable, exit 0', async () => {
    const { code, report } = await json({ server: hostile('no-templates') });
    expect(report.checks.find((c) => c.id === 'resource-templates-list')).toEqual({
      id: 'resource-templates-list',
      state: 'not-applicable',
      detail:
        'the server declares resources but does not offer resource templates (Method not found)',
    });
    expect(report.checks.find((c) => c.id === 'resources-list')?.state).toBe('passed');
    expect(code).toBe(0);
  });
});
