// `plune mcp serve` as a client sees it: the real MCP server behind the dual-era stdio entry over an in-memory
// transport, the platform replaced by a fake fetch. What is listed, what discover_tools changes, and what a refusal
// looks like — in both protocol eras. The client is plain JSON-RPC written here: a 2025-era one opens with
// `initialize`, a 2026-07-28 one puts `_meta` on every request and hears list changes on `subscriptions/listen`.

import { InMemoryTransport } from '@modelcontextprotocol/server';
import { serveStdio, type StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_VISIBLE_TOOLS, PLUNE_TOOLS, defaultVisibleTools } from '../../mcp-tools/index.js';
import { createPluneMcpServer, unsupportedClaim } from '../server.js';
import { CREATED, REFUSAL, fakeFetch, platformAnswer, type AnswerFn } from './fixtures/platform.js';
import { FIXTURE_MISSION_ID } from '../../mcp-testing/__tests__/plune-budget.fixtures.js';

type Era = 'legacy' | 'modern';
type Msg = { id?: number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: { code: number; message: string } };
type ToolResult = { isError?: boolean; content?: { type: string; text: string }[]; structuredContent?: unknown };

const open: StdioServerHandle[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.close();
});

const MODERN_META = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': {},
};

async function connect(era: Era, opts: { scope?: 'read' | 'write'; disabledTools?: readonly string[]; answer?: AnswerFn } = {}) {
  const platform = fakeFetch(opts.answer ?? (() => undefined));
  const [client, serverSide] = InMemoryTransport.createLinkedPair();
  open.push(
    serveStdio(
      (ctx) =>
        createPluneMcpServer(
          {
            token: 'plt_test',
            apiUrl: 'https://api.test',
            fetchImpl: platform.fetchImpl,
            version: '0.0.0-test',
            ...(opts.scope === undefined ? {} : { scope: opts.scope }),
            ...(opts.disabledTools === undefined ? {} : { disabledTools: opts.disabledTools }),
          },
          ctx.era,
        ),
      { transport: serverSide },
    ),
  );

  const got: Msg[] = [];
  const waiters: (() => void)[] = [];
  client.onmessage = (m) => {
    got.push(m as Msg);
    for (const w of waiters.splice(0)) w();
  };
  await client.start();
  const until = (pick: () => Msg | undefined) =>
    new Promise<Msg>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no answer')), 2000);
      const check = () => {
        const m = pick();
        if (m) {
          clearTimeout(timer);
          resolve(m);
        } else waiters.push(check);
      };
      check();
    });

  let next = 1;
  const send = async (method: string, params: Record<string, unknown> = {}) => {
    const id = next++;
    await client.send({ jsonrpc: '2.0', id, method, params: era === 'modern' ? { ...params, _meta: MODERN_META } : params });
    return id;
  };
  const request = async (method: string, params: Record<string, unknown> = {}) => {
    const id = await send(method, params);
    const m = await until(() => got.find((g) => g.id === id && g.method === undefined));
    if (m.error) throw new Error(`${method}: ${m.error.code} ${m.error.message}`);
    return m.result ?? {};
  };

  if (era === 'legacy') {
    await request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    await client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  } else {
    await send('subscriptions/listen', { notifications: { toolsListChanged: true } });
    await until(() => got.find((g) => g.method === 'notifications/subscriptions/acknowledged'));
  }

  return {
    platform,
    listTools: async () => (await request('tools/list'))['tools'] as { name: string; description?: string; inputSchema: { type?: string }; outputSchema?: { type?: string } }[],
    listResult: () => request('tools/list'),
    callTool: async (name: string, args: Record<string, unknown>) => (await request('tools/call', { name, arguments: args })) as ToolResult,
    listChanged: () => got.filter((g) => g.method === 'notifications/tools/list_changed').length,
  };
}

const text = (r: ToolResult) => (r.content ?? []).map((c) => c.text).join('\n');
const SWITCHED_OFF = (name: string) => `\`${name}\` is switched off for this connection. Ask the person who connected Plune to switch it on.`;

describe.each(['legacy', 'modern'] as const)('plune mcp serve, %s era', (era) => {
  const names = async (c: Awaited<ReturnType<typeof connect>>) => (await c.listTools()).map((t) => t.name);

  it('AC-01: lists at most 20 tools, discover_tools among them, each with input and output schemas', async () => {
    const c = await connect(era);
    const tools = await c.listTools();
    expect(tools.length).toBeLessThanOrEqual(MAX_VISIBLE_TOOLS);
    expect(tools.map((t) => t.name)).toContain('plune_discover_tools');
    expect(tools.map((t) => t.name)).toContain('plune_mission_create');
    for (const t of tools) {
      expect(t.inputSchema.type, t.name).toBe('object');
      expect(t.outputSchema?.type, t.name).toBe('object');
      expect(t.description?.length, t.name).toBeGreaterThan(40);
    }
  });

  // The 2026-07-28 era keeps the list fixed instead: see the modern-era block below.
  it.runIf(era === 'legacy')('AC-02: discover_tools reveals a hidden tool for the rest of the session and says the list changed', async () => {
    const c = await connect(era);
    expect(await names(c)).not.toContain('plune_results_write');
    const r = await c.callTool('plune_discover_tools', { names: ['plune_results_write'] });
    expect(r.isError).toBeFalsy();
    expect(await names(c)).toContain('plune_results_write');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(c.listChanged()).toBeGreaterThan(0);
  });

  it.runIf(era === 'legacy')('a hidden tool called before discover_tools is a -32602 protocol error, and nothing reaches the platform', async () => {
    // The usual way to meet this answer: the model calls a tool it read about before switching it on. A client only MAY
    // pass a protocol error to the model, so the hint to call discover_tools can be lost (the SDK 1.x server gave isError).
    const c = await connect(era);
    expect(await names(c)).not.toContain('plune_run_create');
    await expect(c.callTool('plune_run_create', { run: { name: 'x' }, dry_run: true })).rejects.toThrow(/-32602 .*plune_run_create/);
    expect(c.platform.calls).toHaveLength(0);
  });

  it('a result is its structuredContent, and once more as unindented JSON text for clients that read only text', async () => {
    const c = await connect(era, { answer: platformAnswer });
    const r = await c.callTool('plune_mission_get', { missionId: FIXTURE_MISSION_ID });
    expect(r.isError).toBeFalsy();
    expect(r.content).toHaveLength(1);
    expect(text(r)).toBe(JSON.stringify(r.structuredContent));
  });

  it('sends X-Plune-Session on every call, the same one for the whole process', async () => {
    const c = await connect(era, { answer: platformAnswer });
    await c.callTool('plune_mission_get', { missionId: FIXTURE_MISSION_ID });
    await c.callTool('plune_mission_get', { missionId: FIXTURE_MISSION_ID });
    const sessions = c.platform.calls.map((call) => call.headers.get('x-plune-session'));
    expect(sessions[0]).toBeTruthy();
    expect(new Set(sessions).size).toBe(1);
  });

  it('a read token: write tools are not listed, and calling one is refused without a request', async () => {
    const c = await connect(era, { scope: 'read' });
    const listed = await names(c);
    expect(listed).not.toContain('plune_mission_create');
    expect(listed).toContain('plune_mission_get');
    // Every hidden tool writes, so discovery has nothing to offer a read token and could only answer with a refusal.
    expect(listed).not.toContain('plune_discover_tools');
    // A writer called by its name anyway is a tool error that names the reason, not -32602 «Tool … not found»,
    // which reads as a tool that does not exist.
    const r = await c.callTool('plune_mission_create', { name: 'x' });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe(
      'This connection has read-only access: plune_mission_create writes. Ask the person to reconnect with read and write access.',
    );
    expect(r.structuredContent).toMatchObject({ error: { code: 'read_only_token' } });
    expect(c.platform.calls).toHaveLength(0);
    // The refusal is not a listing: the list is the same after it.
    expect(await names(c)).toEqual(listed);
  });

  it('CLI · mcp serve · a read token: an unknown tool is still -32602, a writer with input that does not fit is still refused as read-only', async () => {
    const c = await connect(era, { scope: 'read' });
    await expect(c.callTool('plune_no_such_tool', {})).rejects.toThrow(/-32602 .*plune_no_such_tool/);
    const r = await c.callTool('plune_api_request', { method: 'DELETE' });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/read-only access: plune_api_request writes/);
    expect(c.platform.calls).toHaveLength(0);
  });

  it('CLI · mcp serve · a tool that is switched off is not listed, and a call by its name is a tool error that says why', async () => {
    // One listed tool, one hidden one, and a name that is no tool, which changes nothing.
    const c = await connect(era, { disabledTools: ['plune_mission_create', 'plune_run_create', 'plune_from_another_version'], answer: platformAnswer });
    const listed = await names(c);
    expect(listed).toEqual(defaultVisibleTools('write').filter((n) => n !== 'plune_mission_create'));
    for (const [name, args] of [
      ['plune_mission_create', { name: 'x', dry_run: true }],
      ['plune_run_create', { run: { name: 'x' } }],
      ['plune_run_create', {}],
    ] as const) {
      const r = await c.callTool(name, args);
      expect(r.isError).toBe(true);
      expect(text(r)).toBe(SWITCHED_OFF(name));
      expect(r.structuredContent).toMatchObject({ error: { code: 'tool_disabled' } });
    }
    expect(c.platform.calls).toHaveLength(0);
    await expect(c.callTool('plune_from_another_version', {})).rejects.toThrow(/-32602 .*plune_from_another_version/);
    expect(await names(c)).toEqual(listed);
    // The tools left on still work.
    const r = await c.callTool('plune_mission_get', { missionId: FIXTURE_MISSION_ID });
    expect(r.isError).toBeFalsy();
  });

  it('CLI · mcp serve · discover_tools neither lists nor reveals a tool that is switched off', async () => {
    const c = await connect(era, { disabledTools: ['plune_run_create'] });
    const listing = await c.callTool('plune_discover_tools', {});
    expect(listing.isError).toBeFalsy();
    const available = (listing.structuredContent as { available: { name: string }[] }).available.map((t) => t.name);
    expect(available).not.toContain('plune_run_create');
    expect(available).toContain('plune_results_write');
    const r = await c.callTool('plune_discover_tools', { names: ['plune_run_create'] });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe(SWITCHED_OFF('plune_run_create'));
    expect(r.structuredContent).toMatchObject({ error: { code: 'tool_disabled' } });
    expect(await names(c)).not.toContain('plune_run_create');
  });

  it('CLI · mcp serve · discover_tools is not listed once every hidden tool is switched off', async () => {
    const hidden = PLUNE_TOOLS.filter((t) => t.visibility === 'discoverable').map((t) => t.name);
    const c = await connect(era, { disabledTools: hidden });
    const listed = await names(c);
    expect(listed).not.toContain('plune_discover_tools');
    expect(listed).toEqual(defaultVisibleTools('write').filter((n) => n !== 'plune_discover_tools'));
  });

  it('CLI · mcp serve · a read token and tools switched off: each refusal names its own reason', async () => {
    const c = await connect(era, { scope: 'read', disabledTools: ['plune_mission_get', 'plune_mission_create'] });
    expect(await names(c)).toEqual(defaultVisibleTools('read').filter((n) => n !== 'plune_mission_get'));
    for (const name of ['plune_mission_get', 'plune_mission_create']) {
      const r = await c.callTool(name, { missionId: FIXTURE_MISSION_ID });
      expect(r.isError).toBe(true);
      expect(text(r)).toBe(SWITCHED_OFF(name));
    }
    const writer = await c.callTool('plune_mission_update', { missionId: FIXTURE_MISSION_ID });
    expect(writer.isError).toBe(true);
    expect(writer.structuredContent).toMatchObject({ error: { code: 'read_only_token' } });
    expect(c.platform.calls).toHaveLength(0);
  });

  it('a read token the server refuses: the tool says so clearly', async () => {
    const c = await connect(era, { answer: (m) => (m === 'POST' ? REFUSAL.readOnly : undefined) });
    const r = await c.callTool('plune_mission_create', { name: 'Checkout' });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/403/);
    expect(text(r)).toMatch(/read scope/);
    expect(r.structuredContent).toMatchObject({ error: { status: 403, code: 'read_only_token' } });
  });

  it('an MCP bulk delete returns the same refusal as HTTP', async () => {
    // The platform refuses it only to an agent: the answer depends on X-Plune-Session being sent.
    const refusal = REFUSAL.bulkDelete.body;
    const c = await connect(era, { answer: platformAnswer });
    await c.callTool('plune_discover_tools', { names: ['plune_api_request'] });
    const call = { method: 'POST', path: '/v1/test-cases/bulk', body: { ids: ['a'], action: { kind: 'delete' } } };
    const preview = await c.callTool('plune_api_request', call);
    expect(preview.isError).toBeFalsy();
    const confirm = (preview.structuredContent as { preview: { confirm: string } }).preview.confirm;
    const r = await c.callTool('plune_api_request', { ...call, confirm });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toMatchObject({ error: { status: 403, code: 'bulk_delete_needs_person' } });
    expect(text(r)).toContain(refusal.error);
  });

  it('returns structured content that matches the output schema', async () => {
    const c = await connect(era);
    const r = await c.callTool('plune_mission_create', { name: 'Checkout', dry_run: true });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ dryRun: true, request: { method: 'POST', path: '/v1/missions' } });
  });
});

// 2026-07-28: «the set of tools returned by tools/list MUST NOT vary per-connection or as a side effect of other requests on
// the connection» (https://modelcontextprotocol.io/specification/2026-07-28/server/tools). The core tools are listed for
// the whole connection; a hidden tool is called by its name, and discover_tools only describes it.
describe('plune mcp serve, modern era: a fixed tool list', () => {
  const hidden = PLUNE_TOOLS.filter((t) => t.visibility === 'discoverable').map((t) => t.name);
  type Discovered = { revealed: string[]; available: { name: string; inputSchema?: { type?: string; properties?: Record<string, unknown> } }[] };

  it('CLI · mcp serve · 2026-07-28 · tools/list is the same before and after discover_tools, and no list_changed comes', async () => {
    const c = await connect('modern');
    const before = await c.listResult();
    expect((before['tools'] as { name: string }[]).map((t) => t.name)).toEqual(defaultVisibleTools('write'));
    const r = await c.callTool('plune_discover_tools', { names: hidden });
    expect(r.isError).toBeFalsy();
    expect(await c.listResult()).toEqual(before);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(c.listChanged()).toBe(0);
  });

  it('CLI · mcp serve · 2026-07-28 · discover_tools describes the hidden tools with their input schemas and switches nothing on', async () => {
    const c = await connect('modern');
    const r = await c.callTool('plune_discover_tools', { names: ['plune_run_create'] });
    expect(r.isError).toBeFalsy();
    const data = r.structuredContent as Discovered;
    expect(data.revealed).toEqual([]);
    expect(data.available.map((t) => t.name)).toEqual(hidden);
    for (const t of data.available) expect(t.inputSchema?.type, t.name).toBe('object');
    expect(Object.keys(data.available.find((t) => t.name === 'plune_run_create')?.inputSchema?.properties ?? {})).toEqual(['run', 'dry_run']);
  });

  it('CLI · mcp serve · 2026-07-28 · a hidden tool is called by its name, without discover_tools, and does its work', async () => {
    const c = await connect('modern', { answer: platformAnswer });
    const r = await c.callTool('plune_run_create', { run: { name: 'Checkout' } });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ dryRun: false, result: { id: CREATED.run } });
    expect(c.platform.calls.map((call) => `${call.method} ${call.url.pathname}`)).toEqual(['POST /v1/runs']);
  });

  it('CLI · mcp serve · results: the stub refuses a result without testCaseId, as the platform does, and takes one with it', async () => {
    const c = await connect('modern', { answer: platformAnswer });
    const bare = await c.callTool('plune_results_write', { runId: CREATED.run, results: [{ title: 'Pay by card', status: 'passed' }] });
    expect(bare.isError).toBe(true);
    expect(bare.structuredContent).toMatchObject({ error: { status: 400 } });
    const named = await c.callTool('plune_results_write', {
      runId: CREATED.run,
      results: [{ testCaseId: 'e43e1a95-e2a2-42a1-93b6-62b04756fba6', resultKey: 'pay-by-card#0', status: 'passed' }],
    });
    expect(named.isError).toBeFalsy();
    expect(named.structuredContent).toMatchObject({ applied: 1 });
  });

  it('CLI · mcp serve · 2026-07-28 · a read token: a hidden writer called by name is refused as a listed one is, nothing reaches the platform', async () => {
    const c = await connect('modern', { scope: 'read' });
    for (const name of ['plune_run_create', 'plune_mission_create']) {
      const r = await c.callTool(name, { name: 'x' });
      expect(r.isError).toBe(true);
      expect(text(r)).toBe(`This connection has read-only access: ${name} writes. Ask the person to reconnect with read and write access.`);
    }
    expect(c.platform.calls).toHaveLength(0);
  });

  it('CLI · mcp serve · 2026-07-28 · a token the platform refuses as read-only: a hidden writer is then refused before a request, the list stays', async () => {
    const c = await connect('modern', { answer: (m) => (m === 'POST' ? REFUSAL.readOnly : undefined) });
    const before = await c.listResult();
    const first = await c.callTool('plune_mission_create', { name: 'Checkout' });
    expect(first.structuredContent).toMatchObject({ error: { status: 403, code: 'read_only_token' } });
    const r = await c.callTool('plune_run_create', { run: { name: 'Checkout' } });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toMatchObject({ error: { code: 'read_only_token' } });
    expect(c.platform.calls).toHaveLength(1);
    expect(await c.listResult()).toEqual(before);
  });

  it('CLI · mcp serve · 2026-07-28 · each listed tool is what the 2025 era lists for it', async () => {
    // The 2026-07-28 list is answered by our own handler; this holds it to what the SDK builds from the same definitions.
    const modern = (await (await connect('modern')).listResult())['tools'];
    const legacy = (await (await connect('legacy')).listResult())['tools'];
    expect(modern).toEqual(legacy);
  });

  it('CLI · mcp serve · 2026-07-28 · with a tool switched off the list is still what the 2025 era lists', async () => {
    const off = { disabledTools: ['plune_mission_create', 'plune_get'] };
    const modern = (await (await connect('modern', off)).listResult())['tools'] as { name: string }[];
    const legacy = (await (await connect('legacy', off)).listResult())['tools'];
    expect(modern).toEqual(legacy);
    expect(modern.map((t) => t.name)).toEqual(defaultVisibleTools('write', off.disabledTools));
  });
});

// Every request is checked for the revision it claims, not the opening one only.
describe('plune mcp serve: the revision a request claims', () => {
  const claim = (v: unknown) => ({ _meta: { 'io.modelcontextprotocol/protocolVersion': v } });
  it('refuses a request for a revision the server does not speak with -32022 and the supported list', () => {
    expect(unsupportedClaim({ jsonrpc: '2.0', id: 7, method: 'server/discover', params: claim('1900-01-01') })).toEqual({
      jsonrpc: '2.0',
      id: 7,
      error: { code: -32022, message: 'Unsupported protocol version: 1900-01-01', data: { supported: ['2026-07-28'], requested: '1900-01-01' } },
    });
  });
  it('passes a supported claim, a request without a claim, and a notification', () => {
    expect(unsupportedClaim({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: claim('2026-07-28') })).toBeUndefined();
    expect(unsupportedClaim({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).toBeUndefined();
    expect(unsupportedClaim({ jsonrpc: '2.0', id: 3, method: 'initialize', params: { protocolVersion: '1900-01-01' } })).toBeUndefined();
    expect(unsupportedClaim({ jsonrpc: '2.0', method: 'notifications/cancelled', params: claim('1900-01-01') })).toBeUndefined();
  });
});
