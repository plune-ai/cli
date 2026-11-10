// The lint rules over what a client of `plune mcp serve` really receives: the `tools/list` answer of the real server
// behind its stdio entry over an in-memory transport, in both protocol eras (annotations are set by the server, the
// JSON schemas by the SDK, so the contract definitions alone are not what a model sees). The client is plain JSON-RPC
// written here. Deterministic findings fail the test; heuristics are printed only.

import { InMemoryTransport } from '@modelcontextprotocol/server';
import { serveStdio, type StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import { afterEach, describe, expect, it } from 'vitest';
import { PLUNE_TOOLS } from '../../mcp-tools/index.js';
import { createPluneMcpServer } from '../../mcp/server.js';
import { applyExceptions, gates, lintTools, toolListSize, type LintFinding, type ListedTool } from '../lint/index.js';
import { PLUNE_LINT_EXCEPTIONS } from './plune-tools.lint-exceptions.js';

type Era = 'legacy' | 'modern';
type Msg = { id?: number; method?: string; result?: Record<string, unknown>; error?: { code: number; message: string } };

const open: StdioServerHandle[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.close();
});

const MODERN_META = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientCapabilities': {},
};

/** The list after the hidden tools were asked for, and, when they were, the list the same connection gave before. */
async function listTools(era: Era, scope: 'read' | 'write', revealHidden: boolean): Promise<{ tools: ListedTool[]; before?: ListedTool[] }> {
  const [client, serverSide] = InMemoryTransport.createLinkedPair();
  open.push(
    serveStdio(
      (ctx) =>
        createPluneMcpServer(
          {
            token: 'plt_test',
            apiUrl: 'https://api.test',
            // Listing tools never reaches the platform; a call that did would fail the test here.
            fetchImpl: (async () => {
              throw new Error('the tool list must not call the platform');
            }) as typeof fetch,
            version: '0.0.0-test',
            scope,
          },
          ctx.era,
        ),
      { transport: serverSide },
    ),
  );
  const answers = new Map<number, Msg>();
  const waiters: (() => void)[] = [];
  client.onmessage = (m) => {
    const msg = m as Msg;
    if (msg.id !== undefined && msg.method === undefined) answers.set(msg.id, msg);
    for (const w of waiters.splice(0)) w();
  };
  await client.start();
  let next = 1;
  const request = async (method: string, params: Record<string, unknown> = {}) => {
    const id = next++;
    await client.send({ jsonrpc: '2.0', id, method, params: era === 'modern' ? { ...params, _meta: MODERN_META } : params });
    const m = await new Promise<Msg>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method}: no answer`)), 2000);
      const check = () => {
        const a = answers.get(id);
        if (a === undefined) waiters.push(check);
        else {
          clearTimeout(timer);
          resolve(a);
        }
      };
      check();
    });
    if (m.error) throw new Error(`${method}: ${m.error.code} ${m.error.message}`);
    return m.result ?? {};
  };

  if (era === 'legacy') {
    await request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'lint', version: '1' } });
    await client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }
  const list = async () => (await request('tools/list'))['tools'] as ListedTool[];
  if (!revealHidden) return { tools: await list() };
  const before = await list();
  const names = PLUNE_TOOLS.filter((t) => t.visibility === 'discoverable').map((t) => t.name);
  const r = await request('tools/call', { name: 'plune_discover_tools', arguments: { names } });
  expect(r['isError']).toBeFalsy();
  return { tools: await list(), before };
}

/** Our own contract is held to the specification's SHOULDs too: a deterministic warning fails it, not only an error. */
const failsOurContract = (f: LintFinding) => f.class === 'deterministic' && gates(f, 'warn');

const where = (f: LintFinding) => (f.target.param === undefined ? f.target.tool : `${f.target.tool}.${f.target.param}`);

function table(findings: readonly LintFinding[]): string {
  const rows = findings.map((f) => [f.level, f.class, f.id, where(f), f.message]);
  const widths = [0, 1, 2, 3].map((i) => Math.max(...rows.map((r) => (r[i] ?? '').length), 0));
  return rows.map((r) => r.map((cell, i) => (i < widths.length ? cell.padEnd(widths[i] ?? 0) : cell)).join('  ')).join('\n');
}

// Counts as the server lists them today: write scope 17 core tools, and 8 for a read token (every hidden tool writes, so a
// read token never sees them). After discover_tools the 2025 era lists all 22; in 2026-07-28 the list must not change as
// a side effect of a request, so it is the very list the same connection gave before.
const VIEWS = (['legacy', 'modern'] as const).flatMap((era) => [
  { name: `${era} era, write scope, as listed first`, era, scope: 'write', revealHidden: false, count: 17, unchanged: false } as const,
  { name: `${era} era, write scope, after plune_discover_tools`, era, scope: 'write', revealHidden: true, count: era === 'legacy' ? 22 : 17, unchanged: era === 'modern' } as const,
  { name: `${era} era, read scope`, era, scope: 'read', revealHidden: false, count: 8, unchanged: false } as const,
]);

describe('CLI · mcp lint · Plune tools contract', () => {
  it.each(VIEWS)('$name: no deterministic finding outside the exceptions; heuristics printed', async (view) => {
    const { tools, before } = await listTools(view.era, view.scope, view.revealHidden);
    // Nothing listed is nothing checked, which is not a pass.
    expect(tools.length).toBe(view.count);
    if (view.unchanged) expect(tools).toEqual(before);
    else if (before !== undefined) expect(tools).not.toEqual(before);

    const applied = applyExceptions(lintTools(tools), PLUNE_LINT_EXCEPTIONS);
    const failing = applied.findings.filter(failsOurContract);
    const advice = applied.findings.filter((f) => !failsOurContract(f));

    const size = toolListSize(tools);
    console.info(
      [
        `mcp lint · ${view.name}: ${tools.length} tools, ~${size.totalTokens} tokens (biggest ${size.largest?.name} ~${size.largest?.tokens})`,
        `${failing.length} failing, ${advice.length} advisory, ${applied.excepted.length} excepted`,
        table([...failing, ...advice]),
      ].join('\n'),
    );

    expect(failing.map((f) => `${f.id} on ${where(f)}: ${f.message} Fix: ${f.fix}`)).toEqual([]);
  });

  // Lists and lints every view itself, so it holds when run alone (-t) as well as after the views above.
  it('the run was not empty: the heuristics had something to say, and every exception is still needed', async () => {
    let heuristics = 0;
    const used = new Set<object>();
    for (const view of VIEWS) {
      const { tools } = await listTools(view.era, view.scope, view.revealHidden);
      expect(tools.length, view.name).toBe(view.count);
      const applied = applyExceptions(lintTools(tools), PLUNE_LINT_EXCEPTIONS);
      for (const e of applied.excepted) used.add(e.exception);
      heuristics += applied.findings.filter((f) => f.class === 'heuristic').length;
    }
    expect(heuristics).toBeGreaterThan(0);
    expect(PLUNE_LINT_EXCEPTIONS.filter((e) => !used.has(e))).toEqual([]);
  });
});
