// The Plune tools over streamable HTTP as a client sees them: the fetch-shaped handler of `../http.ts`, called directly
// with web `Request`s, the platform replaced by a fake fetch. Each request stands alone: there is no session, so a
// 2025-era client is served without a handshake and a 2026-07-28 one sends its `_meta` envelope.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FIXTURE_MISSION_ID } from '../../mcp-testing/__tests__/plune-budget.fixtures.js';
import { snapshotPluneTools } from '../../mcp-testing/plune-snapshot.js';
import { createPluneMcpHttpHandler } from '../http.js';
import { fakeFetch, platformAnswer, type AnswerFn } from './fixtures/platform.js';

type Era = 'legacy' | 'modern';
type Scope = 'read' | 'write';
type Rpc = { id?: number; result?: Record<string, unknown>; error?: { code: number; message: string } };
type ToolResult = { isError?: boolean; content?: { type: string; text: string }[]; structuredContent?: unknown };
type SnapshotTool = { name: string; 'x-plune'?: { visibility: string; write: boolean } };

const ENDPOINT = 'https://mcp.test/mcp';
const MODERN_VERSION = '2026-07-28';
const MODERN_META = {
  'io.modelcontextprotocol/protocolVersion': MODERN_VERSION,
  'io.modelcontextprotocol/clientCapabilities': {},
};

const snapshot = JSON.parse(readFileSync(new URL('../../../contracts/plune-mcp-tools.snapshot.json', import.meta.url), 'utf8')) as {
  tools: SnapshotTool[];
};
const core = (t: SnapshotTool) => t['x-plune']?.visibility === 'core';
/** A `tools/list` answer as the snapshot file holds it: the same normalizing, the same order. */
const asSnapshot = (tools: unknown[]) => snapshotPluneTools(tools, undefined).tools;

function client(era: Era, opts: { scope?: Scope; answer?: AnswerFn; apiUrl?: string } = {}) {
  const platform = fakeFetch(opts.answer ?? (() => undefined));
  const handler = createPluneMcpHttpHandler({ version: '0.0.0-test' });
  const caller = {
    token: 'plt_test',
    apiUrl: opts.apiUrl ?? 'https://api.test',
    fetchImpl: platform.fetchImpl,
    ...(opts.scope === undefined ? {} : { scope: opts.scope }),
  };
  let next = 1;
  const post = (method: string, params: Record<string, unknown> = {}, headers: Record<string, string> = {}) => {
    const modern = era === 'modern';
    const name = typeof params['name'] === 'string' ? params['name'] : undefined;
    return handler(
      new Request(ENDPOINT, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(modern ? { 'mcp-protocol-version': MODERN_VERSION, 'mcp-method': method, ...(name === undefined ? {} : { 'mcp-name': name }) } : {}),
          ...headers,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: next++, method, params: modern ? { ...params, _meta: MODERN_META } : params }),
      }),
      caller,
    );
  };
  const request = async (method: string, params: Record<string, unknown> = {}) => {
    const response = await post(method, params);
    expect(response.headers.get('content-type'), method).toMatch(/^application\/json/);
    const message = (await response.json()) as Rpc;
    if (message.error) throw new Error(`${method}: ${message.error.code} ${message.error.message}`);
    return message.result ?? {};
  };
  return {
    platform,
    handler,
    caller,
    post,
    request,
    listTools: async () => (await request('tools/list'))['tools'] as { name: string }[],
    callTool: async (name: string, args: Record<string, unknown>) => (await request('tools/call', { name, arguments: args })) as ToolResult,
  };
}

describe.each(['legacy', 'modern'] as const)('plune mcp over http, %s era', (era) => {
  it('CLI · mcp http · tools/list is the core tools of the contract snapshot', async () => {
    const tools = await client(era).listTools();
    expect(asSnapshot(tools)).toEqual(snapshot.tools.filter(core));
  });

  it('CLI · mcp http · tools/list for the read scope is the read-only part of the core tools', async () => {
    const tools = await client(era, { scope: 'read' }).listTools();
    // Without plune_discover_tools: every hidden tool writes, so discovery has nothing to offer a read token.
    expect(asSnapshot(tools)).toEqual(snapshot.tools.filter((t) => core(t) && t['x-plune']?.write === false && t.name !== 'plune_discover_tools'));
  });

  it('CLI · mcp http · a GET and a DELETE get 405', async () => {
    const c = client(era);
    for (const method of ['GET', 'DELETE']) {
      const response = await c.handler(new Request(ENDPOINT, { method, headers: { accept: 'application/json, text/event-stream' } }), c.caller);
      expect(response.status, method).toBe(405);
      expect(response.headers.get('allow'), method).toBe('POST');
    }
    expect(c.platform.calls).toHaveLength(0);
  });

  it('CLI · mcp http · a request with a session id header gets an answer without one', async () => {
    const response = await client(era).post('tools/list', {}, { 'mcp-session-id': 'a-session-of-another-server' });
    expect(response.status).toBe(200);
    expect(response.headers.get('mcp-session-id')).toBeNull();
    const message = (await response.json()) as Rpc;
    expect((message.result?.['tools'] as unknown[]).length).toBeGreaterThan(0);
  });

  it('CLI · mcp http · a read-only tool call reaches the fake API and returns its result', async () => {
    const c = client(era, { answer: platformAnswer });
    const r = await c.callTool('plune_mission_get', { missionId: FIXTURE_MISSION_ID });
    expect(r.isError).toBeFalsy();
    expect(c.platform.calls.length).toBeGreaterThan(0);
    for (const call of c.platform.calls) {
      expect(call.method).toBe('GET');
      expect(call.url.origin).toBe('https://api.test');
      expect(call.headers.get('authorization')).toBe('Bearer plt_test');
    }
    expect(JSON.stringify(r.structuredContent)).toContain(FIXTURE_MISSION_ID);
    expect(r.content?.[0]?.text).toBe(JSON.stringify(r.structuredContent));
  });

  it('CLI · mcp http · the executor options are taken per request: one handler serves two callers', async () => {
    const first = client(era, { answer: platformAnswer });
    const second = fakeFetch(platformAnswer);
    const call = { name: 'plune_mission_get', arguments: { missionId: FIXTURE_MISSION_ID } };
    await first.post('tools/call', call);
    // The same handler, mounted once; the host names another caller for the next request.
    const modern = era === 'modern';
    await first.handler(
      new Request(ENDPOINT, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(modern ? { 'mcp-protocol-version': MODERN_VERSION, 'mcp-method': 'tools/call', 'mcp-name': call.name } : {}),
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: modern ? { ...call, _meta: MODERN_META } : call }),
      }),
      { token: 'plt_other', apiUrl: 'https://other.test', fetchImpl: second.fetchImpl },
    );
    expect(first.platform.calls.length).toBeGreaterThan(0);
    expect(second.calls.length).toBe(first.platform.calls.length);
    for (const c of second.calls) {
      expect(c.url.origin).toBe('https://other.test');
      expect(c.headers.get('authorization')).toBe('Bearer plt_other');
    }
  });

  it('CLI · mcp http · the list is fixed: a hidden tool is called by its name, and discover_tools switches nothing on', async () => {
    const c = client(era, { answer: platformAnswer });
    const before = await c.listTools();
    const discovered = await c.callTool('plune_discover_tools', { names: ['plune_run_create'] });
    expect(discovered.structuredContent).toMatchObject({ revealed: [] });
    expect(await c.listTools()).toEqual(before);
    const r = await c.callTool('plune_run_create', { run: { name: 'Checkout' }, dry_run: true });
    expect(r.isError).toBeFalsy();
  });

  it('CLI · mcp http · listChanged is not announced', async () => {
    const c = client(era);
    const result =
      era === 'legacy'
        ? await c.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
        : await c.request('server/discover');
    const capabilities = result['capabilities'] as { tools?: { listChanged?: boolean } };
    expect(capabilities.tools).toBeDefined();
    expect(capabilities.tools?.listChanged).not.toBe(true);
  });
});

describe('@plune-ai/cli/mcp-http', () => {
  it('CLI · mcp http · the entry is in package.json exports and is a library entry of the build', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as { exports: Record<string, unknown> };
    expect(pkg.exports['./mcp-http']).toEqual({ types: './dist/mcp-http.d.ts', import: './dist/mcp-http.js', require: './dist/mcp-http.cjs' });
    expect(readFileSync(new URL('../../../tsup.config.ts', import.meta.url), 'utf8')).toContain("'mcp-http': 'src/mcp/http.ts'");
  });
});
