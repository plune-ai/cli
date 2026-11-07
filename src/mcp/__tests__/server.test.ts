// `plune mcp serve` as a client sees it: the real MCP server over an in-memory transport, the platform
// replaced by a fake fetch. What is listed, what discover_tools changes, and what a refusal looks like.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_VISIBLE_TOOLS } from '../../mcp-tools/index.js';
import { createPluneMcpServer } from '../server.js';

type Answer = { status: number; body?: unknown };

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

const open: Client[] = [];
afterEach(async () => {
  for (const c of open.splice(0)) await c.close();
});

async function connect(opts: { scope?: 'read' | 'write'; answer?: Parameters<typeof fakeFetch>[0] } = {}) {
  const platform = fakeFetch(opts.answer ?? (() => undefined));
  const server = createPluneMcpServer({
    token: 'plt_test',
    apiUrl: 'https://api.test',
    fetchImpl: platform.fetchImpl,
    version: '0.0.0-test',
    ...(opts.scope === undefined ? {} : { scope: opts.scope }),
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1' });
  let listChanged = 0;
  client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
    listChanged++;
  });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  open.push(client);
  return { client, platform, listChanged: () => listChanged };
}

const names = async (client: Client) => (await client.listTools()).tools.map((t) => t.name);
const text = (r: { content?: unknown }) => ((r.content as { type: string; text: string }[] | undefined) ?? []).map((c) => c.text).join('\n');

describe('plune mcp serve', () => {
  it('AC-01: lists at most 20 tools, discover_tools among them, each with input and output schemas', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
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
    const { client, listChanged } = await connect();
    expect(await names(client)).not.toContain('plune_results_write');
    const r = await client.callTool({ name: 'plune_discover_tools', arguments: { names: ['plune_results_write'] } });
    expect(r.isError).toBeFalsy();
    expect(await names(client)).toContain('plune_results_write');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(listChanged()).toBeGreaterThan(0);
  });

  it('sends X-Plune-Session on every call, the same one for the whole process', async () => {
    const { client, platform } = await connect({ answer: () => ({ status: 200, body: { id: 'm1', name: 'x', state: 'draft', sources: [] } }) });
    await client.callTool({ name: 'plune_mission_get', arguments: { missionId: 'm1' } });
    await client.callTool({ name: 'plune_mission_get', arguments: { missionId: 'm1' } });
    const sessions = platform.calls.map((c) => c.headers.get('x-plune-session'));
    expect(sessions[0]).toBeTruthy();
    expect(new Set(sessions).size).toBe(1);
  });

  it('a read token: write tools are not listed, and calling one is refused without a request', async () => {
    const { client, platform } = await connect({ scope: 'read' });
    const listed = await names(client);
    expect(listed).not.toContain('plune_mission_create');
    expect(listed).toContain('plune_mission_get');
    const r = await client.callTool({ name: 'plune_mission_create', arguments: { name: 'x' } });
    expect(r.isError).toBe(true);
    expect(platform.calls).toHaveLength(0);
  });

  it('a read token the server refuses: the tool says so clearly', async () => {
    const { client } = await connect({ answer: (m) => (m === 'POST' ? { status: 403, body: { error: 'read-only token' } } : undefined) });
    const r = await client.callTool({ name: 'plune_mission_create', arguments: { name: 'Checkout' } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/403/);
    expect(text(r)).toMatch(/read scope/);
    expect(r.structuredContent).toMatchObject({ error: { status: 403, code: 'read_only_token' } });
  });

  it('an MCP bulk delete returns the same refusal as HTTP', async () => {
    const refusal = { error: 'an agent cannot delete in bulk — a person does it from the dashboard', code: 'bulk_delete_needs_person' };
    const { client } = await connect({ answer: (_m, url, h) => (url.pathname === '/v1/test-cases/bulk' && h.get('x-plune-session') ? { status: 403, body: refusal } : undefined) });
    await client.callTool({ name: 'plune_discover_tools', arguments: { names: ['plune_api_request'] } });
    const call = { method: 'POST', path: '/v1/test-cases/bulk', body: { ids: ['a'], action: { kind: 'delete' } } };
    const preview = await client.callTool({ name: 'plune_api_request', arguments: call });
    expect(preview.isError).toBeFalsy();
    const confirm = (preview.structuredContent as { preview: { confirm: string } }).preview.confirm;
    const r = await client.callTool({ name: 'plune_api_request', arguments: { ...call, confirm } });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toMatchObject({ error: { status: 403, code: 'bulk_delete_needs_person' } });
    expect(text(r)).toContain(refusal.error);
  });

  it('returns structured content that matches the output schema', async () => {
    const { client } = await connect();
    const r = await client.callTool({ name: 'plune_mission_create', arguments: { name: 'Checkout', dry_run: true } });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ dryRun: true, request: { method: 'POST', path: '/v1/missions' } });
  });
});
