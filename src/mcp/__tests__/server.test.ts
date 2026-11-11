// `plune mcp serve` as a client sees it: the real MCP server behind the dual-era stdio entry over an in-memory
// transport, the platform replaced by a fake fetch. What is listed, what discover_tools changes, and what a refusal
// looks like — in both protocol eras. The client is plain JSON-RPC written here: a 2025-era one opens with
// `initialize`, a 2026-07-28 one puts `_meta` on every request and hears list changes on `subscriptions/listen`.

import { InMemoryTransport } from '@modelcontextprotocol/server';
import { serveStdio, type StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_VISIBLE_TOOLS, PLUNE_TOOLS, defaultVisibleTools } from '../../mcp-tools/index.js';
import { createPluneMcpServer } from '../server.js';
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

async function connect(era: Era, opts: { scope?: 'read' | 'write'; answer?: AnswerFn } = {}) {
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
    // An unlisted tool is unknown to the server: a protocol error -32602, as both eras' tools page specifies (the
    // SDK 1.x server answered it with an isError result instead).
    await expect(c.callTool('plune_mission_create', { name: 'x' })).rejects.toThrow(/-32602/);
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

  it('CLI · mcp serve · 2026-07-28 · a read token: a hidden writer called by name is refused as a listed one is, nothing reaches the platform', async () => {
    const c = await connect('modern', { scope: 'read' });
    await expect(c.callTool('plune_run_create', { run: { name: 'x' } })).rejects.toThrow(/-32602 .*plune_run_create/);
    await expect(c.callTool('plune_mission_create', { name: 'x' })).rejects.toThrow(/-32602 .*plune_mission_create/);
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
});
