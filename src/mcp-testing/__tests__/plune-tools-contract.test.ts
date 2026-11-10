// The lint rules over what a client of `plune mcp serve` really receives: the `tools/list` answer of the real server
// over an in-memory transport (annotations are set by the server, the JSON schemas by the SDK, so the contract
// definitions alone are not what a model sees). Deterministic findings fail the test; heuristics are printed only.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { PLUNE_TOOLS } from '../../mcp-tools/index.js';
import { createPluneMcpServer } from '../../mcp/server.js';
import { applyExceptions, gates, lintTools, toolListSize, type LintFinding, type ListedTool } from '../lint/index.js';
import { PLUNE_LINT_EXCEPTIONS } from './plune-tools.lint-exceptions.js';

const open: Client[] = [];
afterEach(async () => {
  for (const c of open.splice(0)) await c.close();
});

async function listTools(scope: 'read' | 'write', revealHidden: boolean): Promise<ListedTool[]> {
  const server = createPluneMcpServer({
    token: 'plt_test',
    apiUrl: 'https://api.test',
    // Listing tools never reaches the platform; a call that did would fail the test here.
    fetchImpl: (async () => {
      throw new Error('the tool list must not call the platform');
    }) as typeof fetch,
    version: '0.0.0-test',
    scope,
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'lint', version: '1' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  open.push(client);
  if (revealHidden) {
    const names = PLUNE_TOOLS.filter((t) => t.visibility === 'discoverable').map((t) => t.name);
    const r = await client.callTool({ name: 'plune_discover_tools', arguments: { names } });
    expect(r.isError).toBeFalsy();
  }
  return (await client.listTools()).tools as ListedTool[];
}

/** Our own contract is held to the specification's SHOULDs too: a deterministic warning fails it, not only an error. */
const failsOurContract = (f: LintFinding) => f.class === 'deterministic' && gates(f, 'warn');

const where = (f: LintFinding) => (f.target.param === undefined ? f.target.tool : `${f.target.tool}.${f.target.param}`);

function table(findings: readonly LintFinding[]): string {
  const rows = findings.map((f) => [f.level, f.class, f.id, where(f), f.message]);
  const widths = [0, 1, 2, 3].map((i) => Math.max(...rows.map((r) => (r[i] ?? '').length), 0));
  return rows.map((r) => r.map((cell, i) => (i < widths.length ? cell.padEnd(widths[i] ?? 0) : cell)).join('  ')).join('\n');
}

// Counts as the server lists them today: write scope 17 core tools, all 22 once discover_tools reveals the hidden
// ones, and 8 for a read token (every hidden tool writes, so a read token never sees them).
const VIEWS = [
  { name: 'write scope, as listed first', scope: 'write', revealHidden: false, count: 17 },
  { name: 'write scope, after plune_discover_tools', scope: 'write', revealHidden: true, count: 22 },
  { name: 'read scope', scope: 'read', revealHidden: false, count: 8 },
] as const;

describe('CLI · mcp lint · Plune tools contract', () => {
  const seenHeuristics: LintFinding[] = [];
  const usedExceptions = new Set<object>();

  it.each(VIEWS)('$name: no deterministic finding outside the exceptions; heuristics printed', async (view) => {
    const tools = await listTools(view.scope, view.revealHidden);
    // Nothing listed is nothing checked, which is not a pass.
    expect(tools.length).toBe(view.count);

    const applied = applyExceptions(lintTools(tools), PLUNE_LINT_EXCEPTIONS);
    for (const e of applied.excepted) usedExceptions.add(e.exception);
    const failing = applied.findings.filter(failsOurContract);
    const advice = applied.findings.filter((f) => !failsOurContract(f));
    seenHeuristics.push(...advice.filter((f) => f.class === 'heuristic'));

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

  it('the run was not empty: the heuristics had something to say, and every exception is still needed', () => {
    expect(seenHeuristics.length).toBeGreaterThan(0);
    expect(PLUNE_LINT_EXCEPTIONS.filter((e) => !usedExceptions.has(e))).toEqual([]);
  });
});
