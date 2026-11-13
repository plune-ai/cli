// The checks of the 2026-07-28 revision, each against a server that breaks its requirement and one that keeps it. The
// servers speak plain JSON-RPC (../../__tests__/fixtures/modern-server.mjs): over stdio as a process, over HTTP
// through node:http here, with the header rules of the transport switched on or off one at a time.

import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { handleMcpConformance, type McpConformanceFlags } from '../../../cli/commands/mcp-conformance.js';
import { render } from '../../report/index.js';
import { conformanceSetRun } from '../../report/runs.js';
import type { McpConformanceReport, McpConformanceReportSet } from '../../result.js';
import { CATALOG, REVISIONS } from '../catalog.js';
import { discoverProblems } from '../checks/modern/core.js';
import { headerDeclarationProblems } from '../checks/modern/headers.js';
import { paramHeaders } from '../checks/modern/meta.js';
import { SCHEMA_SHA256, wireProblem } from '../checks/modern/observed.js';
import { PROFILE } from '../profile.js';
// @ts-expect-error a plain .mjs fixture, without types
import { answer, REGION } from '../../__tests__/fixtures/modern-server.mjs';

const fixture = (name: string) => fileURLToPath(new URL(`../../__tests__/fixtures/${name}`, import.meta.url));
const modern = (m: string) => [process.execPath, fixture('modern-server.mjs'), m];
const legacy = [process.execPath, fixture('conformance-server.mjs'), 'good'];
const MOD = CATALOG.filter((e) => e.id.startsWith('mod-'));
const MOD_IDS = MOD.map((e) => e.id);
const CALLS = [
  { tool: 'echo', arguments: { text: 'hi' } },
  { tool: 'ask', arguments: {} },
  { tool: 'region', arguments: { region: 'eu-west' } },
];

const servers: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

function fixtureFile(calls: unknown): string {
  const path = join(mkdtempSync(join(tmpdir(), 'plune-conformance-modern-')), 'fixture.json');
  writeFileSync(path, JSON.stringify(calls));
  return path;
}

async function run(flags: McpConformanceFlags, server: string[] = []) {
  let out = '';
  let err = '';
  const code = await handleMcpConformance({ timeout: '10s', format: 'json', ...flags }, server, {
    out: (s) => (out += s),
    err: (s) => (err += s),
    env: {},
    clientVersion: '9.9.9',
  });
  return { code, out, err, doc: out === '' ? undefined : (JSON.parse(out) as McpConformanceReport | McpConformanceReportSet) };
}
const report = async (flags: McpConformanceFlags, server: string[] = []) => (await run(flags, server)).doc as McpConformanceReport;

const states = (r: McpConformanceReport, ids?: string[]) =>
  Object.fromEntries(
    r.checks.filter((c) => ids === undefined || ids.includes(c.id)).map((c) => [c.id, c.reason === undefined ? c.state : `${c.state} (${c.reason})`]),
  );
const byId = (r: McpConformanceReport, id: string) => r.checks.find((c) => c.id === id)!;

/** The header rules the HTTP wrapper keeps; each one off is a server that breaks it. */
interface Rules {
  mode?: string;
  validate?: boolean;
  decode?: boolean;
  /** Mcp-Name compared without regard to case. */
  nameAnyCase?: boolean;
  /** Header names read only as written in lower case. */
  namesExact?: boolean;
  echoSession?: boolean;
  statuses?: boolean;
}

const decoded = (v: string | undefined) => {
  const m = v === undefined ? null : /^=\?base64\?(.*)\?=$/.exec(v);
  return m === null ? v : Buffer.from(m[1] ?? '', 'base64').toString('utf8');
};

async function serveHttp(rules: Rules = {}) {
  const r = { mode: 'good', validate: true, decode: true, statuses: true, ...rules };
  const state = { http: true, discovered: true, connection: 'http' };
  const bodies: { headers: IncomingMessage['headers']; body: string }[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += String(c)));
    req.on('end', () => {
      bodies.push({ headers: req.headers, body });
      const exact = (name: string) => {
        if (r.namesExact !== true) return req.headers[name] as string | undefined;
        const i = req.rawHeaders.indexOf(name);
        return i < 0 ? undefined : req.rawHeaders[i + 1];
      };
      if (req.method !== 'POST') return res.writeHead(405).end();
      let msg: { id?: string | number; method: string; params?: Record<string, unknown> };
      try {
        msg = JSON.parse(body) as typeof msg;
      } catch {
        return res.writeHead(400).end();
      }
      if (msg.id === undefined) return res.writeHead(202).end();
      const session = req.headers['mcp-session-id'];
      const extra: Record<string, string> = r.echoSession === true && typeof session === 'string' ? { 'mcp-session-id': session } : {};
      const reply = (frame: { error?: { code: number } }) => {
        const code = frame.error?.code;
        const status = r.statuses && code !== undefined ? (code === -32601 ? 404 : [-32602, -32020, -32021, -32022].includes(code) ? 400 : 200) : 200;
        res.writeHead(status, { 'content-type': 'application/json', ...extra }).end(JSON.stringify(frame));
      };
      const mismatch = (why: string) => reply({ jsonrpc: '2.0', id: msg.id, error: { code: -32020, message: `Header mismatch: ${why}` } } as never);
      if (r.validate) {
        const params = msg.params ?? {};
        const meta = (params['_meta'] ?? {}) as Record<string, unknown>;
        const version = exact('mcp-protocol-version');
        const method = exact('mcp-method');
        if (version === undefined || method === undefined) return mismatch('a required header is missing');
        const v = meta['io.modelcontextprotocol/protocolVersion'];
        if (typeof v === 'string' && v !== version) return mismatch('MCP-Protocol-Version');
        if (method !== msg.method) return mismatch('Mcp-Method');
        if (['tools/call', 'resources/read', 'prompts/get'].includes(msg.method)) {
          const raw = exact('mcp-name');
          const name = r.decode ? decoded(raw) : raw;
          const body = String(msg.method === 'resources/read' ? params['uri'] : params['name']);
          const same = r.nameAnyCase === true ? name?.toLowerCase() === body.toLowerCase() : name === body;
          if (raw === undefined || !same) return mismatch('Mcp-Name');
        }
        if (msg.method === 'tools/call' && params['name'] === 'region') {
          const region = (params['arguments'] as Record<string, unknown> | undefined)?.['region'];
          const h = decoded(exact('mcp-param-region'));
          if (region !== undefined && h !== String(region)) return mismatch('Mcp-Param-Region');
        }
      }
      if (msg.method === 'subscriptions/listen') {
        res.writeHead(200, { 'content-type': 'text/event-stream', ...extra });
        return answer(r.mode, state, msg, (f: unknown) => res.write(`data: ${JSON.stringify(f)}\n\n`), () => res.end());
      }
      let sent = false;
      answer(r.mode, state, msg, (f: { id?: unknown; error?: { code: number } }) => {
        if (sent || f.id === undefined) return;
        sent = true;
        reply(f);
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  servers.push({
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  });
  return { url: `http://127.0.0.1:${port}/mcp`, bodies };
}

describe('CLI · mcp conformance · the 2026-07-28 revision over stdio', () => {
  it('a server that breaks each modern requirement fails each modern check, with what it got and how to fix it', async () => {
    const r = await report({ fixture: fixtureFile(CALLS) }, modern('bad'));
    expect(r).toMatchObject({ era: 'modern', protocolVersion: '2026-07-28', eraDetection: 'server/discover answered a DiscoverResult' });
    const got = states(r, MOD_IDS);
    for (const id of [
      'mod-discover-server-info',
      'mod-meta-required-fields',
      'mod-unsupported-version',
      'mod-removed-methods',
      'mod-stateless-no-prior-context',
      'mod-list-stable-across-connections',
      'mod-resource-not-found',
      'mod-cache-hints-coverage',
      'mod-cache-ttl-valid',
      'mod-cache-scope-valid',
      'mod-cache-scope-stable-pages',
      'mod-undeclared-capability',
      'mod-sub-ack-first',
      'mod-sub-filter-and-tag',
      'mod-sub-graceful-close',
      'mod-result-type-present',
      'mod-error-code-range',
      'mod-logs-need-log-level',
      'mod-wire-schema-valid',
    ])
      expect(got[id], id).toBe('failed');
    for (const c of r.checks.filter((c) => c.id.startsWith('mod-') && c.state === 'failed')) {
      expect(c.actual, c.id).not.toBe('');
      expect(c.fix, c.id).not.toBe('');
      expect(c.specRef, c.id).toMatch(/^https:\/\/modelcontextprotocol\.io\/specification\/2026-07-28\//);
    }
    const actual = (id: string) => byId(r, id).actual;
    expect(actual('mod-cache-hints-coverage')).toContain('resources/templates/list');
    expect(actual('mod-cache-hints-coverage')).not.toContain('tools/list');
    expect(actual('mod-resource-not-found')).toContain('the code earlier revisions used');
    expect(actual('mod-error-code-range')).toContain('-32050');
    expect(actual('mod-error-code-range')).toContain('-32002');
    expect(actual('mod-list-stable-across-connections')).toContain('conn-');
    expect(actual('mod-undeclared-capability')).toContain('ask asked for elicitation');
    expect(actual('mod-sub-filter-and-tag')).toContain('notifications/prompts/list_changed was not asked for');
    expect(actual('mod-result-type-present')).toContain('tools/list: no resultType');
    // AC-7: a failed SHOULD is advice: not in the failed bucket, never the exit code's.
    expect(byId(r, 'mod-sub-graceful-close')).toMatchObject({ level: 'SHOULD', state: 'failed' });
    expect(r.summary.failed).not.toContain('mod-sub-graceful-close');
  }, 60_000);

  it('a server that keeps them passes every check that applies to a modern stdio run', async () => {
    const r = await report({ fixture: fixtureFile(CALLS) }, modern('good'));
    const expected = Object.fromEntries(
      CATALOG.map((e) => [
        e.id,
        !e.transports.includes('stdio') ? 'not-applicable (transport)' : !e.eras.includes('modern') ? 'not-applicable (era)' : 'passed',
      ]),
    );
    expect(states(r)).toEqual(expected);
    expect(r.server).toEqual({ name: 'modern-good', version: '1.0.0' });
    // AC-1: every new id is in the catalog, none in the profile: a MUST is pending for the score, a SHOULD advice.
    for (const e of MOD) {
      expect(PROFILE.checks, e.id).not.toContain(e.id);
      expect(e.level === 'MUST' ? r.pendingCheckIds : r.summary.advisories, e.id).toContain(e.id);
    }
    expect(byId(r, 'mod-wire-schema-valid').actual).toContain(`sha256 ${SCHEMA_SHA256.slice(0, 12)}`);
  }, 60_000);

  it('mod-resource-no-empty-contents: empty contents for an unknown resource fails, an error passes', async () => {
    const red = await report({ check: ['mod-resource-no-empty-contents', 'mod-resource-not-found'] }, modern('empty'));
    expect(states(red)).toEqual({ 'mod-resource-no-empty-contents': 'failed', 'mod-resource-not-found': 'failed' });
    const green = await report({ check: ['mod-resource-no-empty-contents'] }, modern('good'));
    expect(states(green)).toEqual({ 'mod-resource-no-empty-contents': 'passed' });
  }, 30_000);

  it('mod-discover-result: no capabilities fails it, and every other check is could-not-run (prerequisite-failed)', async () => {
    const r = await report({ check: ['mod-discover-result', 'mod-discover-server-info', 'tools-list-shape'] }, modern('no-discover'));
    expect(states(r)).toEqual({
      'mod-discover-result': 'failed',
      'mod-discover-server-info': 'could-not-run (prerequisite-failed)',
      'tools-list-shape': 'could-not-run (prerequisite-failed)',
    });
    expect(byId(r, 'mod-discover-result').actual).toContain('capabilities is missing');
  }, 30_000);

  it('without --fixture the fixture checks are could-not-run (needs-input), and no subscribable capability is not-applicable', async () => {
    const r = await report({ check: ['mod-undeclared-capability'] }, modern('good'));
    expect(states(r)).toEqual({ 'mod-undeclared-capability': 'could-not-run (needs-input)' });
    // The legacy fixture over a forced modern run: it has no server/discover, so nothing stands.
    const old = await report({ protocolVersion: '2026-07-28', check: ['mod-discover-result', 'mod-sub-ack-first'] }, legacy);
    expect(states(old)).toEqual({ 'mod-discover-result': 'failed', 'mod-sub-ack-first': 'could-not-run (prerequisite-failed)' });
  }, 30_000);
});

describe('CLI · mcp conformance · the era of a run', () => {
  it('AC-3: auto finds a legacy, a modern and a dual-era server, and says how', async () => {
    const old = await report({ check: ['life-initialize-result', 'mod-discover-result'] }, legacy);
    expect(old).toMatchObject({ era: 'legacy', protocolVersion: '2025-11-25' });
    expect(old.eraDetection).toBe('server/discover answered error -32601, not a modern one: legacy, the initialize handshake');
    // AC-4: on a legacy server every modern check is not-applicable (era).
    expect(states(old)).toEqual({ 'life-initialize-result': 'passed', 'mod-discover-result': 'not-applicable (era)' });
    const now = await report({ check: ['life-initialize-result', 'life-ping-empty-result', 'mod-discover-result'] }, modern('good'));
    expect(now).toMatchObject({ era: 'modern', eraDetection: 'server/discover answered a DiscoverResult' });
    expect(states(now)).toEqual({
      'life-initialize-result': 'not-applicable (era)',
      'life-ping-empty-result': 'not-applicable (era)',
      'mod-discover-result': 'passed',
    });
    const dual = await report({ check: ['mod-discover-result'] }, modern('dual'));
    expect(dual).toMatchObject({ era: 'modern', eraDetection: 'server/discover answered a DiscoverResult' });
  }, 30_000);

  it('--protocol-version both: a dual-era server gets two blocks, each with its own score, never mixed', async () => {
    const ids = ['life-initialize-result', 'life-ping-empty-result', 'mod-discover-result', 'mod-removed-methods'];
    const { doc, code } = await run({ protocolVersion: 'both', check: ids }, modern('dual'));
    const set = doc as McpConformanceReportSet;
    expect(set.kind).toBe('mcp-conformance-report-set');
    const [old, now] = set.reports;
    expect(old!.era).toBe('legacy');
    expect(states(old!)).toEqual({
      'life-initialize-result': 'passed',
      'life-ping-empty-result': 'passed',
      'mod-discover-result': 'not-applicable (era)',
      'mod-removed-methods': 'not-applicable (era)',
    });
    expect(now!.era).toBe('modern');
    expect(states(now!)).toEqual({
      'life-initialize-result': 'not-applicable (era)',
      'life-ping-empty-result': 'not-applicable (era)',
      'mod-discover-result': 'passed',
      'mod-removed-methods': 'passed',
    });
    // The dual-era server answers initialize: that probe is not counted, and the run says so.
    expect(byId(now!, 'mod-removed-methods').actual).toContain('a dual-era server, not counted');
    const codes = [old!.exitCode, now!.exitCode];
    expect(set.exitCode).toBe(codes.includes(1) ? 1 : codes.includes(3) ? 3 : 0);
    expect(code).toBe(set.exitCode);
    // One JUnit file holds both, each case under its era.
    const xml = render(conformanceSetRun(set), 'junit-xml');
    expect(xml).toContain('legacy/life-ping-empty-result');
    expect(xml).toContain('modern/mod-discover-result');
    const human = render(conformanceSetRun(set), 'human');
    expect(human).toContain('legacy era');
    expect(human).toContain('modern era');
    expect(human).toContain('Both eras, each scored on its own');
  }, 30_000);
});

describe('CLI · mcp conformance · the 2026-07-28 request headers over HTTP', () => {
  const HTTP_MOD = MOD.filter((e) => e.transports.includes('http')).map((e) => e.id);

  it('a server that breaks each header rule fails each header check', async () => {
    const s = await serveHttp({ mode: 'bad', validate: false, echoSession: true, statuses: false });
    const r = await report({ url: s.url, check: HTTP_MOD, fixture: fixtureFile(CALLS) });
    expect(r.era).toBe('modern');
    const got = states(r);
    for (const id of [
      'mod-unimplemented-method',
      'mod-header-protocol-version-mismatch',
      'mod-header-method-mismatch',
      'mod-header-name-mismatch',
      'mod-header-missing-rejected',
      'mod-param-header-mismatch',
      'mod-x-mcp-header-declarations',
      'mod-no-session-id',
      'mod-meta-required-fields',
      'mod-unsupported-version',
      'mod-removed-methods',
      'mod-sub-ack-first',
      'mod-sub-graceful-close',
    ])
      expect(got[id], id).toBe('failed');
    expect(byId(r, 'mod-unimplemented-method').actual).toContain('HTTP 200');
    expect(byId(r, 'mod-sub-graceful-close').actual).toContain('closed the subscription stream without answering');
    expect(byId(r, 'mod-x-mcp-header-declarations').actual).toContain('not string, integer or boolean');
    expect(byId(r, 'mod-header-name-mismatch').details?.[0]?.request.headers).toContainEqual(['Mcp-Name', 'MEM://A']);
  }, 60_000);

  it('a server that keeps them passes every modern check over HTTP', async () => {
    const s = await serveHttp();
    const r = await report({ url: s.url, check: HTTP_MOD, fixture: fixtureFile(CALLS) });
    expect(states(r)).toEqual(Object.fromEntries(HTTP_MOD.map((id) => [id, 'passed'])));
    // A modern request carries its version, method and name as headers too.
    const read = s.bodies.find((b) => b.body.includes('"resources/read"') && b.body.includes('"mem://a"'))!;
    expect(read.headers).toMatchObject({ 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'resources/read', 'mcp-name': 'mem://a' });
  }, 60_000);

  it('Mcp-Name compared without regard to case fails mod-header-name-mismatch: header values are case-sensitive', async () => {
    const s = await serveHttp({ nameAnyCase: true });
    expect(states(await report({ url: s.url, check: ['mod-header-name-mismatch'] }))).toEqual({ 'mod-header-name-mismatch': 'failed' });
  }, 30_000);

  it('header names read only in lower case fail mod-header-names-case-insensitive', async () => {
    const s = await serveHttp({ namesExact: true });
    const r = await report({ url: s.url, check: ['mod-header-names-case-insensitive'] });
    expect(states(r)).toEqual({ 'mod-header-names-case-insensitive': 'failed' });
    expect(byId(r, 'mod-header-names-case-insensitive').actual).toContain('upper case got HTTP 400');
    expect(byId(r, 'mod-header-names-case-insensitive').details?.[1]?.request.headers).toContainEqual(['MCP-METHOD', 'server/discover']);
  }, 30_000);

  it('an Mcp-Name in Base64 that is not decoded fails mod-header-name-base64-decoded', async () => {
    const s = await serveHttp({ decode: false });
    const r = await report({ url: s.url, check: ['mod-header-name-base64-decoded'] });
    expect(states(r)).toEqual({ 'mod-header-name-base64-decoded': 'failed' });
    expect(byId(r, 'mod-header-name-base64-decoded').actual).toContain('=?base64?bWVtOi8vYQ==?=');
  }, 30_000);

  it('AC-5: over stdio every header check is not-applicable (transport)', async () => {
    const r = await report({ check: HTTP_MOD.filter((id) => id.startsWith('mod-header-')) }, modern('good'));
    for (const c of r.checks) expect(`${c.state} (${c.reason})`, c.id).toBe('not-applicable (transport)');
  }, 30_000);
});

describe('CLI · mcp conformance · the 2026-07-28 checks on recorded messages', () => {
  it('discoverProblems names each missing part of a DiscoverResult', () => {
    expect(discoverProblems({ resultType: 'complete', supportedVersions: ['2026-07-28'], capabilities: {} }, '2026-07-28')).toEqual([]);
    expect(discoverProblems({ supportedVersions: [], capabilities: null }, '2026-07-28')).toEqual([
      'resultType is missing, not "complete"',
      'supportedVersions is not a non-empty list of strings',
      'capabilities is missing or not an object',
    ]);
    expect(discoverProblems({ resultType: 'complete', supportedVersions: ['2027-01-01'], capabilities: {} }, '2026-07-28')).toEqual([
      'supportedVersions does not name 2026-07-28, the revision it answered for',
    ]);
  });

  it('x-mcp-header: a valid declaration passes; each broken constraint is named', () => {
    expect(headerDeclarationProblems(REGION.inputSchema)).toEqual([]);
    const problems = headerDeclarationProblems({
      type: 'object',
      properties: {
        a: { type: 'string', 'x-mcp-header': '' },
        b: { type: 'string', 'x-mcp-header': 'Bad Name' },
        c: { type: 'string', 'x-mcp-header': 'Tenant' },
        d: { type: 'integer', 'x-mcp-header': 'tenant' },
        e: { type: 'number', 'x-mcp-header': 'Size' },
        f: { type: 'object', properties: { g: { type: 'boolean', 'x-mcp-header': 'Deep' } } },
        h: { anyOf: [{ type: 'string', 'x-mcp-header': 'Choice' }] },
        // A property named x-mcp-header is a name, not an annotation.
        'x-mcp-header': { type: 'string' },
      },
    });
    expect(problems).toEqual([
      'properties.a: x-mcp-header is "", not a non-empty string',
      'properties.b: x-mcp-header "Bad Name" is not an HTTP token',
      'properties.d: x-mcp-header tenant repeats Tenant without regard to case',
      'properties.e: on a property of type "number", not string, integer or boolean',
      'properties.h.anyOf.0: not reached through properties alone',
    ]);
    // The client side: the value of each valid annotation goes out as Mcp-Param-{Name}, encoded when not plain ASCII.
    expect(paramHeaders(REGION, { region: 'Zürich' })).toEqual([['Mcp-Param-Region', '=?base64?WsO8cmljaA==?=']]);
    expect(paramHeaders(REGION, {})).toEqual([]);
  });

  it('wireProblem judges a response by the method it answers, an error and a notification by their definitions', () => {
    const list = { jsonrpc: '2.0', id: 1, result: { resultType: 'complete', tools: [], ttlMs: 0, cacheScope: 'public' } };
    expect(wireProblem(list, 'tools/list')).toBeUndefined();
    expect(wireProblem({ ...list, result: { resultType: 'complete', tools: [] } }, 'tools/list')).toContain('is not a ListToolsResult');
    expect(wireProblem({ jsonrpc: '2.0', id: 1, result: { tools: [] } }, 'other/method')).toContain('is not a JSONRPCResultResponse');
    expect(wireProblem({ jsonrpc: '2.0', id: 1, error: { code: -32601 } }, 'x')).toContain('is not a JSONRPCErrorResponse');
    expect(wireProblem({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 1 } }, undefined)).toBeUndefined();
    expect(wireProblem({ jsonrpc: '2.0', method: 'notifications/message', params: {} }, undefined)).toContain('LoggingMessageNotification');
    expect(wireProblem({ jsonrpc: '2.0', method: 'vendor/thing' }, undefined)).toBeUndefined();
  });

  it('the shipped schema file is the one whose SHA-256 the checker reports', () => {
    const bytes = readFileSync(fileURLToPath(new URL('../schemas/2026-07-28.json', import.meta.url)));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(SCHEMA_SHA256);
  });

  it('AC-8: the catalog cites only the revisions whose status it records, each read on a date', () => {
    const cited = [...new Set(CATALOG.flatMap((e) => e.specRefs.map((r) => r.revision)))].sort();
    expect(REVISIONS.map((r) => r.revision)).toEqual(cited);
    expect(REVISIONS.find((r) => r.revision === '2026-07-28')).toMatchObject({ status: 'Current', checkedOn: '2026-11-13' });
  });
});
