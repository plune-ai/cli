// The tool loop against real servers: the stdio fixture in ./fixtures and an HTTP server on 127.0.0.1, through the
// composition root of `plune run` with the scripted mock model. Nothing here reaches past this machine, and the
// test says so: every fetch and every socket of the run is recorded against the hosts it may use.

import * as net from 'node:net';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleRun, makeMcpConnect } from '../../cli/commands/run.js';
import { runOrchestration, RunConfigError } from '../index.js';
import { loadDataset } from '../dataset.js';
import { makeMockProvider } from '../../providers/mock.js';
import { renderReport } from '../../reporters/index.js';
import {
  streamableServer,
  type Fixture,
} from '../../mcp-testing/__tests__/fixtures/http-servers.js';
import type { Config } from '../../types/config.js';
import type { RowResult } from '../../types/results.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/agent-server.mjs', import.meta.url));
const NOOP_CACHE = {
  get: () => undefined,
  set: () => {},
  delete: () => {},
  clear: () => {},
  close: () => {},
};

const servers: Fixture[] = [];
const env = { ...process.env };
afterEach(async () => {
  for (const f of servers.splice(0)) await f.close();
  process.env = { ...env };
  vi.restoreAllMocks();
});

function stdioConfig(allowed: string[]): Config {
  return {
    version: 1,
    provider: { type: 'anthropic', model: 'm' },
    mcp: { servers: { fx: { command: process.execPath, args: [FIXTURE] } } },
    evals: [
      {
        id: 'agentic',
        prompt: 'Use the tools',
        dataset: { examples: [{ vars: {} }] },
        assertions: [{ type: 'contains', value: 'done' }],
        mcp: { server: 'fx', allowed_tools: allowed },
      },
    ],
  };
}

async function stdioRow(
  cfg: Config,
  script: Parameters<typeof makeMockProvider>[0],
): Promise<RowResult> {
  const result = await runOrchestration(
    cfg,
    { noCache: true },
    {
      resolveProvider: () => makeMockProvider(script),
      embedder: { embed: async () => [] },
      cache: NOOP_CACHE,
      now: Date.now,
      loadDataset,
      baseDir: tmpdir(),
      connectMcp: makeMcpConnect(cfg, tmpdir(), {}),
    },
  );
  return result.evals[0]!.rows[0]!;
}

describe('CLI · run · agent loop · real servers', () => {
  it('CLI · run · agent loop · a fixture server with two tools and a scripted model: every call in the transcript (AC-1, AC-6)', async () => {
    const r = await stdioRow(stdioConfig(['echo', 'files/read']), [
      {
        tool_calls: [
          { name: 'echo', args: { text: 'hi' } },
          { name: 'files_read', args: { path: 'a.txt' } },
        ],
      },
      { text: 'done reading' },
    ]);
    expect(r.error).toBeUndefined();
    expect(r.output).toBe('done reading');
    expect(r.assertions).toEqual([{ type: 'contains', passed: true }]);
    const agent = r.agent!;
    expect(agent.stop).toEqual({ reason: 'complete' });
    expect(agent.collection).toBe('complete');
    expect(agent.tools.filter((t) => t.offered).map((t) => t.name)).toEqual(['echo', 'files/read']);
    expect(agent.tools.find((t) => t.name === 'echo')!.annotations).toEqual({ readOnlyHint: true });
    expect(agent.steps.map((s) => s.index)).toEqual([1, 2]);
    expect(agent.steps[0]!.calls).toMatchObject([
      {
        name: 'echo',
        args: { text: 'hi' },
        executed: true,
        is_error: false,
        result: { text: 'hi', bytes: 2, truncated: false },
      },
      {
        name: 'files/read',
        args: { path: 'a.txt' },
        executed: true,
        is_error: false,
        result: { text: 'contents of a.txt' },
      },
    ]);
    for (const c of agent.steps[0]!.calls) expect(c.duration_ms).toBeGreaterThanOrEqual(0);
  }, 30_000);

  it('CLI · run · agent loop · isError from the server is recorded and the loop goes on; 1 MiB is measured whole (AC-4, AC-7)', async () => {
    const r = await stdioRow(stdioConfig(['fail', 'big']), [
      { tool_calls: [{ name: 'fail' }, { name: 'big' }] },
      { text: 'done' },
    ]);
    const [fail, big] = r.agent!.steps[0]!.calls;
    expect(fail).toMatchObject({
      is_error: true,
      error_kind: 'content',
      result: { text: 'the tool failed' },
    });
    expect(big!.result!.bytes).toBeGreaterThanOrEqual(1048576);
    expect(big!.result!.text.length).toBeLessThan(10_000);
    expect(r.agent!.stop.reason).toBe('complete');
  }, 30_000);

  it('CLI · run · agent loop · a server that exits mid-run errors the row and keeps the transcript (AC-4)', async () => {
    const r = await stdioRow(stdioConfig(['echo', 'crash']), [
      { tool_calls: [{ name: 'echo', args: { text: 'first' } }] },
      { tool_calls: [{ name: 'crash' }] },
    ]);
    expect(r.error?.code).toBe('MCP_SERVER_LOST');
    expect(r.agent!.steps).toHaveLength(2);
    expect(r.agent!.steps[0]!.calls[0]!.result!.text).toBe('first');
    expect(r.agent!.steps[1]!.calls[0]).toMatchObject({ name: 'crash', executed: true });
  }, 30_000);

  it('CLI · run · agent loop · a tool that never answers stops the loop at tool_timeout_ms (AC-3)', async () => {
    const cfg = stdioConfig(['slow']);
    cfg.evals[0]!.mcp!.limits = { tool_timeout_ms: 300 };
    const r = await stdioRow(cfg, [{ tool_calls: [{ name: 'slow' }] }]);
    expect(r.agent!.stop).toEqual({ reason: 'limit', limit: 'tool_timeout_ms' });
  }, 30_000);
});

/** A plune.yaml in a fresh folder for the HTTP fixture: `${FX_URL}` and `${FX_TOKEN}` come from the environment. */
function httpProject(script: unknown): { configPath: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'plune-agent-'));
  writeFileSync(join(dir, 'script.json'), JSON.stringify(script));
  writeFileSync(
    join(dir, 'plune.yaml'),
    [
      'version: 1',
      'provider: { type: anthropic, model: m }',
      'mcp:',
      '  servers:',
      '    remote:',
      '      url: "${FX_URL}/mcp"',
      '      headers:',
      '        Authorization: "Bearer ${FX_TOKEN}"',
      'evals:',
      '  - id: agentic',
      '    prompt: "Who am I?"',
      '    dataset: { examples: [{ vars: {} }] }',
      '    assertions: []',
      '    mcp: { server: remote }',
      '',
    ].join('\n'),
  );
  return { configPath: join(dir, 'plune.yaml'), dir };
}

const SECRET = 'sk-test-agent-loop-0123456789';

/** Every host:port a fetch or a socket of the run went to. */
function watchNetwork(): string[] {
  const seen: string[] = [];
  const fetch = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    seen.push(url.host);
    return fetch(input, init);
  });
  const connect = net.Socket.prototype.connect;
  vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(function (
    this: net.Socket,
    ...args: unknown[]
  ) {
    const [first, second] = args as [unknown, unknown];
    if (typeof first === 'object' && first !== null && 'port' in first) {
      const o = first as { host?: string; port: number };
      seen.push(`${o.host ?? 'localhost'}:${o.port}`);
    } else if (typeof first === 'number')
      seen.push(`${typeof second === 'string' ? second : 'localhost'}:${first}`);
    else if (typeof first === 'object' && first !== null && 'path' in first)
      seen.push(`pipe:${String((first as { path: string }).path)}`);
    return (connect as (...a: unknown[]) => net.Socket).apply(this, args);
  });
  return seen;
}

describe('CLI · run · agent loop · plune run', () => {
  it('CLI · run · agent loop · the header secret reaches the server and nothing else: not the reports, not errors, no other host (AC-11, AC-12)', async () => {
    const f = await streamableServer({ token: SECRET });
    servers.push(f);
    const { configPath, dir } = httpProject([
      { tool_calls: [{ name: 'whoami' }] },
      { text: 'done' },
    ]);
    Object.assign(process.env, {
      PLUNE_MOCK_PROVIDER: '1',
      PLUNE_MOCK_SCRIPT: join(dir, 'script.json'),
      FX_URL: f.origin,
      FX_TOKEN: SECRET,
    });
    const seen = watchNetwork();
    const result = await handleRun({ dryRun: false, configPath, noCache: true });

    // First: the secret did go out, to the server it is for. Without this, "not in the report" would prove nothing.
    expect(f.requests.some((q) => q.headers['authorization'] === `Bearer ${SECRET}`)).toBe(true);
    // The server's tool error repeats it; the transcript keeps the error masked.
    const row = result.evals[0]!.rows[0]!;
    expect(row.agent!.steps[0]!.calls[0]).toMatchObject({
      name: 'whoami',
      is_error: true,
      error_kind: 'content',
    });
    expect(row.agent!.steps[0]!.calls[0]!.result!.text).toContain('***');
    expect(readFileSync(join(dir, '.plune', 'last-run.json'), 'utf8')).not.toContain(SECRET);
    expect(renderReport(result, 'json', { color: false })).not.toContain(SECRET);

    const host = new URL(f.origin).host;
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.filter((h) => h !== host)).toEqual([]);
  }, 30_000);

  it('CLI · run · agent loop · a refused credential errors the row without repeating it (AC-12)', async () => {
    const f = await streamableServer({ token: 'the-right-token' });
    servers.push(f);
    const { configPath, dir } = httpProject([{ text: 'done' }]);
    Object.assign(process.env, {
      PLUNE_MOCK_PROVIDER: '1',
      PLUNE_MOCK_SCRIPT: join(dir, 'script.json'),
      FX_URL: f.origin,
      FX_TOKEN: SECRET,
    });
    const result = await handleRun({ dryRun: false, configPath, noCache: true });
    expect(f.requests.some((q) => q.headers['authorization'] === `Bearer ${SECRET}`)).toBe(true);
    const row = result.evals[0]!.rows[0]!;
    expect(row.error?.code).toBe('MCP_CONNECT');
    expect(JSON.stringify(result)).not.toContain(SECRET);
  }, 30_000);

  it('CLI · run · agent loop · PLUNE_MOCK_PROVIDER=1 without PLUNE_MOCK_SCRIPT is a config error, not a pass (AC-10)', async () => {
    const { configPath } = httpProject([{ text: 'x' }]);
    Object.assign(process.env, {
      PLUNE_MOCK_PROVIDER: '1',
      FX_URL: 'http://127.0.0.1:9',
      FX_TOKEN: SECRET,
    });
    delete process.env['PLUNE_MOCK_SCRIPT'];
    await expect(handleRun({ dryRun: false, configPath, noCache: true })).rejects.toThrow(
      /nothing would be measured/,
    );
  });

  it('CLI · run · agent loop · an unreadable or malformed PLUNE_MOCK_SCRIPT is a config error', async () => {
    const { configPath, dir } = httpProject([]);
    Object.assign(process.env, {
      PLUNE_MOCK_PROVIDER: '1',
      FX_URL: 'http://127.0.0.1:9',
      FX_TOKEN: SECRET,
    });
    process.env['PLUNE_MOCK_SCRIPT'] = join(dir, 'missing.json');
    await expect(handleRun({ dryRun: false, configPath })).rejects.toThrow(RunConfigError);
    process.env['PLUNE_MOCK_SCRIPT'] = join(dir, 'script.json');
    await expect(handleRun({ dryRun: false, configPath })).rejects.toThrow(/non-empty list/);
  });

  it('CLI · run · agent loop · --cache-strict with an agentic eval stops before any call (AC-9)', async () => {
    const { configPath, dir } = httpProject([{ text: 'x' }]);
    Object.assign(process.env, {
      PLUNE_MOCK_PROVIDER: '1',
      PLUNE_MOCK_SCRIPT: join(dir, 'script.json'),
      FX_URL: 'http://127.0.0.1:9',
      FX_TOKEN: SECRET,
    });
    const seen = watchNetwork();
    await expect(handleRun({ dryRun: false, configPath, cacheStrict: true })).rejects.toThrow(
      /--cache-strict/,
    );
    expect(seen).toEqual([]);
  });

  it('CLI · run · agent loop · a dry run connects nowhere and says what its estimate leaves out', async () => {
    const { configPath } = httpProject([{ text: 'x' }]);
    Object.assign(process.env, { FX_URL: 'http://127.0.0.1:9', FX_TOKEN: SECRET });
    delete process.env['PLUNE_MOCK_PROVIDER'];
    const seen = watchNetwork();
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const result = await handleRun({ dryRun: true, configPath });
    expect(seen).toEqual([]);
    expect(result.evals[0]!.rows[0]!.usage!.output_tokens).toBe(1024 * 10);
    expect(stderr.mock.calls.map((c) => String(c[0])).join('')).toMatch(
      /tool schemas and tool results are not counted/,
    );
  });

  it('CLI · run · agent loop · a server name mcp.servers does not have is refused by the connect', async () => {
    const connect = makeMcpConnect(stdioConfig([]), tmpdir(), {});
    await expect(connect('nope', 1000)).rejects.toThrow(/no "nope"/);
  });
});
