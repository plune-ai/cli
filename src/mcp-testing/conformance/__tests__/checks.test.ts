// The protocol checks of `plune mcp conformance`, each against a server that keeps its requirement and one that breaks
// it. The servers are processes on this machine: ../../__tests__/fixtures/conformance-server.mjs (plain JSON-RPC, so
// no SDK corrects what it sends), the SDK's own stdio fixture, and a Streamable HTTP server on 127.0.0.1.

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { handleMcpConformance, type McpConformanceFlags } from '../../../cli/commands/mcp-conformance.js';
import { streamableServer, type Fixture } from '../../__tests__/fixtures/http-servers.js';
import type { McpConformanceReport } from '../../result.js';
import { CATALOG } from '../catalog.js';

import type { ConformanceContext } from '../checks/index.js';
import { LIFECYCLE } from '../checks/lifecycle.js';
import { UNKNOWN_TOOL } from '../checks/tools.js';

/** The checks a run without --suite covers: the oauth suite has its own tests (auth.test.ts). */
const PROTOCOL = CATALOG.filter((e) => e.suite === 'protocol');

const fixture = (name: string) => fileURLToPath(new URL(`../../__tests__/fixtures/${name}`, import.meta.url));
const SERVER = fixture('conformance-server.mjs');
const SDK_STDIO = [process.execPath, fixture('stdio-server.mjs')];
const mode = (m: string) => [process.execPath, SERVER, m];
const parsed = (text: string): { method?: string; params?: { name?: unknown } } | undefined => {
  try {
    return JSON.parse(text) as { method?: string; params?: { name?: unknown } };
  } catch {
    return undefined; // the invalid JSON of base-jsonrpc-parse-error
  }
};
const dir = () => mkdtempSync(join(tmpdir(), 'plune-conformance-checks-'));

const servers: Fixture[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

async function run(flags: McpConformanceFlags, server: string[]) {
  let out = '';
  let err = '';
  const code = await handleMcpConformance({ timeout: '10s', format: 'json', ...flags }, server, {
    out: (s) => (out += s),
    err: (s) => (err += s),
    env: {},
    clientVersion: '9.9.9',
  });
  const json = flags.format === undefined || flags.format === 'json';
  return { code, out, err, report: json && out !== '' ? (JSON.parse(out) as McpConformanceReport) : undefined };
}

/** Why an entry does not apply to a legacy stdio run (AC-4 of MCP-C4: every mod- check is era); undefined when it does. */
const legacyStdio = (e: (typeof CATALOG)[number]) =>
  !e.transports.includes('stdio') ? 'not-applicable (transport)' : !e.eras.includes('legacy') ? 'not-applicable (era)' : undefined;

const states = (r: McpConformanceReport) =>
  Object.fromEntries(r.checks.map((c) => [c.id, c.reason === undefined ? c.state : `${c.state} (${c.reason})`]));

function fixtureFile(calls: unknown): string {
  const path = join(dir(), 'fixture.json');
  writeFileSync(path, JSON.stringify(calls));
  return path;
}

describe('CLI · mcp conformance · checks against a server that keeps and one that breaks each requirement', () => {
  it('a conformant server passes every check that applies to a legacy stdio server', async () => {
    const { code, report } = await run({ fixture: fixtureFile([{ tool: 'echo', arguments: { text: 'hi' } }]) }, mode('good'));
    const expected = Object.fromEntries(PROTOCOL.map((e) => [e.id, legacyStdio(e) ?? 'passed']));
    expect(states(report!)).toEqual(expected);
    expect(report!.era).toBe('legacy');
    expect(report!.summary).toMatchObject({ score: 100, verdict: 'passed' });
    expect(code).toBe(0);
  }, 15_000);

  it('a server that breaks each requirement fails each check, with what it got and how to fix it', async () => {
    const { code, report } = await run({ fixture: fixtureFile([{ tool: 'dup' }]) }, mode('bad'));
    const expected = Object.fromEntries(PROTOCOL.map((e) => [e.id, legacyStdio(e) ?? 'failed']));
    // The handshake is sound (the connection takes nothing less); the list order and the mod- checks are modern-era.
    expected['life-initialize-result'] = 'passed';
    expected['life-version-negotiation'] = 'passed';
    expected['life-capabilities-served-declared'] = 'passed';
    expect(states(report!)).toEqual(expected);
    for (const c of report!.checks.filter((c) => c.state === 'failed')) {
      expect(c.actual, c.id).not.toBe('');
      expect(c.fix, c.id).not.toBe('');
      expect(c.specRef, c.id).toMatch(/^https:\/\/modelcontextprotocol\.io\/specification\//);
    }
    const actual = (id: string) => report!.checks.find((c) => c.id === id)?.actual;
    expect(actual('stdio-parse-error-advice')).toContain('no answer');
    expect(actual('base-response-id-matches')).toContain('both result and error');
    expect(actual('stdio-stdout-clean')).toContain('"server starting"');
    expect(actual('tools-name-unique')).toContain('dup');
    expect(actual('pagination-walk-complete')).toContain('nextCursor it had given before');
    expect(code).toBe(1);
  }, 30_000);

  it('AC-4: without the resources capability every resource check is not-applicable (capability-not-declared)', async () => {
    const { report } = await run({}, mode('undeclared'));
    const s = states(report!);
    for (const id of ['resources-list-shape', 'resources-read-listed', 'resources-read-not-found', 'resources-templates-shape'])
      expect(s[id], id).toBe('not-applicable (capability-not-declared)');
    // It still answers resources/list and prompts/list: a list served without its capability.
    expect(s['life-capabilities-served-declared']).toBe('failed');
  });

  it('AC-5: a failed handshake is could-not-run (prerequisite-failed) for every check that rests on it, not failed', async () => {
    const { code, report } = await run({}, mode('no-server-info'));
    const s = states(report!);
    expect(s['life-initialize-result']).toBe('failed');
    for (const e of PROTOCOL.filter((e) => e.id !== 'life-initialize-result')) {
      const why = !e.transports.includes('stdio') ? 'transport' : !e.eras.includes('legacy') ? 'era' : undefined;
      expect(s[e.id], e.id).toBe(why !== undefined ? `not-applicable (${why})` : 'could-not-run (prerequisite-failed)');
    }
    expect(code).toBe(1);
  }, 15_000);

  it('AC-6: without --fixture the call checks are could-not-run (needs-input), and no tool of the server is called', async () => {
    const journal = join(dir(), 'frames.jsonl');
    const { report } = await run({ debugOut: journal }, SDK_STDIO);
    const s = states(report!);
    expect(s['tools-structured-conformant']).toBe('could-not-run (needs-input)');
    expect(s['tools-structured-has-text']).toBe('could-not-run (needs-input)');
    const called = readFileSync(journal, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { dir: string; raw?: string; frame?: { method?: string; params?: { name?: unknown } } })
      .filter((l) => l.dir === 'out')
      .map((l) => (l.raw !== undefined ? parsed(l.raw) : l.frame))
      .filter((m) => m?.method === 'tools/call')
      .map((m) => m?.params?.name);
    // The two calls that cannot run a tool: one without a name, one for a name no server has.
    expect(called.sort()).toEqual([UNKNOWN_TOOL, undefined]);
  }, 15_000);

  it('AC-3: over stdio no check outside stdio passes, over HTTP the stdio checks are not-applicable and the rest run', async () => {
    const stdio = await run({}, SDK_STDIO);
    for (const e of PROTOCOL.filter((e) => !e.transports.includes('stdio')))
      expect(states(stdio.report!)[e.id], e.id).toBe('not-applicable (transport)');
    const http = await streamableServer();
    servers.push(http);
    const { report } = await run({ url: `${http.origin}/mcp` }, []);
    const s = states(report!);
    expect(s['stdio-stdout-clean']).toBe('not-applicable (transport)');
    expect(s['stdio-exit-on-eof']).toBe('not-applicable (transport)');
    for (const e of PROTOCOL.filter((e) => e.transports.includes('http'))) expect(s[e.id], e.id).not.toBe('pending');
    expect(s['tools-list-shape']).toBe('passed');
  }, 15_000);

  it('AC-9: a token from --header reaches neither the report, the journal nor an error message', async () => {
    const token = 'conformance-secret-marker-7f3a';
    const http = await streamableServer({ token });
    servers.push(http);
    const journal = join(dir(), 'frames.jsonl');
    // whoami fails repeating the credentials it was sent, as a careless server would.
    const flags: McpConformanceFlags = {
      url: `${http.origin}/mcp`,
      header: [`Authorization: Bearer ${token}`, `X-Api-Key: ${token}-key`],
      debugOut: journal,
      fixture: fixtureFile([{ tool: 'whoami' }]),
    };
    const json = await run(flags, []);
    const human = await run({ ...flags, format: 'human' }, []);
    expect(json.report!.checks.find((c) => c.id === 'tools-list-shape')?.state).toBe('passed');
    for (const text of [json.out, json.err, human.out, human.err, readFileSync(journal, 'utf8')]) expect(text).not.toContain(token);
    // The server did get the token: the masking is of what is written down, not of what is sent.
    expect(http.requests.some((r) => r.headers['authorization'] === `Bearer ${token}`)).toBe(true);
  }, 15_000);

  it('AC-9: a server that repeats the token in every JSON-RPC error and in its 400 page gets it masked in every detail', async () => {
    const token = 'conformance-echo-marker-91c2';
    // Plain HTTP JSON-RPC: initialize answers, every other request is an error that names the credentials.
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += String(c)));
      req.on('end', () => {
        const auth = String(req.headers['authorization']);
        let msg: { id?: unknown; method?: string };
        try {
          msg = JSON.parse(body) as { id?: unknown; method?: string };
        } catch {
          res.writeHead(400, { 'content-type': 'text/plain' });
          return res.end(`cannot parse a message sent with ${auth}`);
        }
        if (msg.id === undefined) return res.writeHead(202).end();
        const answer =
          msg.method === 'initialize'
            ? { result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'echo', version: '1' } } }
            : { error: { code: -32601, message: `no ${String(msg.method)} for ${auth}` } };
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...answer }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    servers.push({ origin: '', requests: [], close: () => new Promise((resolve) => server.close(() => resolve())) });
    const journal = join(dir(), 'frames.jsonl');
    const { out, err, report } = await run(
      { url: `http://127.0.0.1:${port}/mcp`, header: [`Authorization: Bearer ${token}`], debugOut: journal },
      [],
    );
    // The details do carry the server's words, the token masked in them.
    const invalidParams = report!.checks.find((c) => c.id === 'base-invalid-params-error');
    expect(invalidParams?.actual).toContain('for ***');
    expect(report!.checks.find((c) => c.id === 'base-jsonrpc-parse-error')?.actual).toContain('cannot parse a message sent with ***');
    for (const text of [out, err, readFileSync(journal, 'utf8')]) expect(text).not.toContain(token);
  });

  it('two timeouts in a row: the checks left are could-not-run (timeout), not each waited out', async () => {
    const started = Date.now();
    const { code, report } = await run({ timeout: '1s' }, mode('silent'));
    const s = states(report!);
    expect(s['life-initialize-result']).toBe('passed');
    expect(s['life-capabilities-declared-served']).toBe('could-not-run (timeout)');
    // Every list is declared, so this one asks nothing; a check that sends nothing breaks the row of timeouts.
    expect(s['life-capabilities-served-declared']).toBe('passed');
    expect(s['life-ping-empty-result']).toBe('could-not-run (timeout)');
    expect(s['stdio-parse-error-advice']).toBe('could-not-run (timeout)');
    const skipped = report!.checks.filter((c) => c.actual.startsWith('Not run: 2 checks in a row timed out'));
    expect(skipped.map((c) => c.id)).toEqual(
      report!.checks.slice(report!.checks.findIndex((c) => c.id === 'base-unknown-method-error')).filter((c) => c.state === 'could-not-run').map((c) => c.id),
    );
    expect(skipped.length).toBeGreaterThan(15);
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(code).toBe(3);
  }, 30_000);

  it('--fixture that is not a list of { tool, arguments } is exit 2 before any server starts', async () => {
    for (const [content, says] of [
      ['{"tool":"echo"}', 'must hold a JSON list'],
      ['[{"arguments":{}}]', 'entry 1 needs "tool"'],
      ['[{"tool":"echo","arguments":[1]}]', 'entry 1 needs "tool"'],
      ['not json', 'could not read'],
    ] as const) {
      const path = join(dir(), 'f.json');
      writeFileSync(path, content);
      const r = await run({ fixture: path }, ['this-command-does-not-exist']);
      expect(r.code, content).toBe(2);
      expect(r.err, content).toContain(says);
    }
  });
});

describe('CLI · mcp conformance · the handshake checks on recorded answers', () => {
  const ctx = (offered: unknown, result: unknown) =>
    ({ session: { handshake: { offered, result } } }) as unknown as ConformanceContext;
  const answer = { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 's', version: '1' } };

  it('life-initialize-result: passed with the three fields, failed naming each one missing', async () => {
    expect((await LIFECYCLE['life-initialize-result']!(ctx('2025-11-25', answer))).state).toBe('passed');
    const red = await LIFECYCLE['life-initialize-result']!(ctx('2025-11-25', { protocolVersion: 1, serverInfo: { name: 's' } }));
    expect(red).toMatchObject({ state: 'failed' });
    expect(red.actual).toContain('protocolVersion is missing or not a string');
    expect(red.actual).toContain('capabilities is missing');
    expect(red.actual).toContain('serverInfo.version');
  });

  it('life-version-negotiation: the same revision or another one passes, an answer that is not a revision fails', async () => {
    const check = LIFECYCLE['life-version-negotiation']!;
    expect((await check(ctx('2025-11-25', answer))).actual).toContain('answered the same');
    expect((await check(ctx('2025-11-25', { ...answer, protocolVersion: '2025-06-18' }))).state).toBe('passed');
    expect((await check(ctx('2025-11-25', { ...answer, protocolVersion: 'latest' }))).state).toBe('failed');
  });
});
