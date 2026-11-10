// `plune mcp serve` as a client sees it: the real MCP server behind the dual-era stdio entry over an in-memory
// transport, the platform replaced by a fake fetch. What is listed, what discover_tools changes, and what a refusal
// looks like — in both protocol eras. The client is plain JSON-RPC written here: a 2025-era one opens with
// `initialize`, a 2026-07-28 one puts `_meta` on every request and hears list changes on `subscriptions/listen`.

import { InMemoryTransport } from '@modelcontextprotocol/server';
import { serveStdio, type StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_VISIBLE_TOOLS } from '../../mcp-tools/index.js';
import { createPluneMcpServer } from '../server.js';

type Answer = { status: number; body?: unknown };
type Era = 'legacy' | 'modern';
type Msg = { id?: number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: { code: number; message: string } };
type ToolResult = { isError?: boolean; content?: { type: string; text: string }[]; structuredContent?: unknown };

function fakeFetch(answer: (method: string, url: URL, headers: Headers) => Answer | undefined) {
  const calls: { method: string; url: URL; headers: Headers }[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const call = { method: init?.method ?? 'GET', url: new URL(String(input)), headers: new Headers(init?.headers) };
    calls.push(call);
    const a = answer(call.method, call.url, call.headers) ?? { status: 200, body: {} };
    return new Response(a.body === undefined ? null : JSON.stringify(a.body), { status: a.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const open: StdioServerHandle[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.close();
});

const MODERN_META = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': {},
};

async function connect(era: Era, opts: { scope?: 'read' | 'write'; answer?: Parameters<typeof fakeFetch>[0] } = {}) {
  const platform = fakeFetch(opts.answer ?? (() => undefined));
  const [client, serverSide] = InMemoryTransport.createLinkedPair();
  open.push(
    serveStdio(
      () =>
        createPluneMcpServer({
          token: 'plt_test',
          apiUrl: 'https://api.test',
          fetchImpl: platform.fetchImpl,
          version: '0.0.0-test',
          ...(opts.scope === undefined ? {} : { scope: opts.scope }),
        }),
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

  it('AC-02: discover_tools reveals a hidden tool for the rest of the session and says the list changed', async () => {
    const c = await connect(era);
    expect(await names(c)).not.toContain('plune_results_write');
    const r = await c.callTool('plune_discover_tools', { names: ['plune_results_write'] });
    expect(r.isError).toBeFalsy();
    expect(await names(c)).toContain('plune_results_write');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(c.listChanged()).toBeGreaterThan(0);
  });

  it('sends X-Plune-Session on every call, the same one for the whole process', async () => {
    const c = await connect(era, { answer: () => ({ status: 200, body: { id: 'm1', name: 'x', state: 'draft', sources: [] } }) });
    await c.callTool('plune_mission_get', { missionId: 'm1' });
    await c.callTool('plune_mission_get', { missionId: 'm1' });
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
    const c = await connect(era, { answer: (m) => (m === 'POST' ? { status: 403, body: { error: 'read-only token' } } : undefined) });
    const r = await c.callTool('plune_mission_create', { name: 'Checkout' });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/403/);
    expect(text(r)).toMatch(/read scope/);
    expect(r.structuredContent).toMatchObject({ error: { status: 403, code: 'read_only_token' } });
  });

  it('an MCP bulk delete returns the same refusal as HTTP', async () => {
    const refusal = { error: 'an agent cannot delete in bulk — a person does it from the dashboard', code: 'bulk_delete_needs_person' };
    const c = await connect(era, { answer: (_m, url, h) => (url.pathname === '/v1/test-cases/bulk' && h.get('x-plune-session') ? { status: 403, body: refusal } : undefined) });
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
