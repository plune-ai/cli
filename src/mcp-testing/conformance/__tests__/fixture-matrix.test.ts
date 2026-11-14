// A check that is never red proves nothing. This runs every kind of broken server the conformance tests use, and one
// good server per transport and era, through the whole command, and asks of the catalog: does each requirement have a
// server that makes its check `failed`, and does the good one keep every check green? An id that no server can make red
// is named below with the reason, so a check cannot lose its fixture, or gain an excuse, without this test turning red.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  handleMcpConformance,
  type McpConformanceFlags,
} from '../../../cli/commands/mcp-conformance.js';
import {
  closeServed,
  serve,
  serveHttp,
  type Opts,
} from '../../__tests__/fixtures/conformance-http-servers.js';
import type { McpConformanceReport } from '../../result.js';
import { CATALOG } from '../catalog.js';

const fixture = (name: string) =>
  fileURLToPath(new URL(`../../__tests__/fixtures/${name}`, import.meta.url));
const legacyServer = (m: string) => [process.execPath, fixture('conformance-server.mjs'), m];
const modernServer = (m: string) => [process.execPath, fixture('modern-server.mjs'), m];
const CALLS = [
  { tool: 'echo', arguments: { text: 'hi' } },
  { tool: 'ask', arguments: {} },
  { tool: 'region', arguments: { region: 'eu-west' } },
];
const FIXTURE = join(mkdtempSync(join(tmpdir(), 'plune-conformance-matrix-')), 'fixture.json');
writeFileSync(FIXTURE, JSON.stringify(CALLS));
const BAD_CALLS = join(mkdtempSync(join(tmpdir(), 'plune-conformance-matrix-')), 'fixture.json');
writeFileSync(BAD_CALLS, JSON.stringify([{ tool: 'dup' }]));
const ids = (prefix: string) =>
  CATALOG.filter(
    (e) => e.suite === 'protocol' && e.transports.includes('http') && e.id.startsWith(prefix),
  ).map((e) => e.id);
// The raw legacy server speaks HTTP only: it is judged by the http- checks. The modern one answers every mod- check.
const HTTP_CHECKS = ids('http-');
const MODERN_HTTP_CHECKS = ids('mod-');

async function run(
  flags: McpConformanceFlags,
  server: string[] = [],
): Promise<McpConformanceReport> {
  let out = '';
  await handleMcpConformance({ timeout: '10s', format: 'json', ...flags }, server, {
    out: (s) => (out += s),
    err: () => {},
    env: {},
    clientVersion: '9.9.9',
  });
  return JSON.parse(out) as McpConformanceReport;
}
const http = async (o: Opts, flags: McpConformanceFlags = {}) =>
  run({ url: (await serve(o)).url, check: HTTP_CHECKS, ...flags });
const modernHttp = async (rules: Parameters<typeof serveHttp>[0]) =>
  run({ url: (await serveHttp(rules)).url, check: MODERN_HTTP_CHECKS, fixture: FIXTURE });

/** Every broken server: how to start it, and the run that shows what it breaks. */
const BROKEN: Record<string, () => Promise<McpConformanceReport>> = {
  'legacy stdio, every requirement broken': () => run({ fixture: BAD_CALLS }, legacyServer('bad')),
  'legacy stdio, a list served without its capability': () => run({}, legacyServer('undeclared')),
  'legacy stdio, an initialize result without serverInfo': () =>
    run({}, legacyServer('no-server-info')),
  'modern stdio, tools/list changes between calls': () => run({}, modernServer('unstable')),
  'modern stdio, server/discover without capabilities': () => run({}, modernServer('no-discover')),
  'modern stdio, an unknown resource read as empty contents': () => run({}, modernServer('empty')),
  'modern http, Mcp-Name not decoded from Base64': () => modernHttp({ decode: false }),
  'modern http, header names read only in lower case': () => modernHttp({ namesExact: true }),
  'modern stdio, every requirement broken': () => run({ fixture: FIXTURE }, modernServer('bad')),
  'modern http, every header rule off': () =>
    modernHttp({ mode: 'bad', validate: false, echoSession: true, statuses: false }),
  'legacy http, every requirement broken': () =>
    http({
      sessions: (n) => `bad id ${n}`,
      notification: 'body',
      answer: 'text',
      badUtf8: true,
      lax: true,
      get: 'json',
      origin: 'ignore',
      host: 'ignore',
      bind: '0.0.0.0',
    }),
  'legacy http, an SSE answer that never ends, repeating event ids': () =>
    http({ answer: 'sse', keepOpen: true, eventIds: 'repeat' }),
  'legacy http, answers under another id': () => http({ wrongId: true }),
  'legacy http, invalid JSON answered as a request': () =>
    http({ parseResult: true }, { check: ['base-jsonrpc-parse-error'] }),
  'legacy http, one message sent to every GET stream': () =>
    http({ get: 'sse', broadcast: true }, { fixture: FIXTURE }),
  'legacy http, a notification answered 202 with a body': () => http({ notification: 'body202' }),
  'legacy http, every Origin refused': () => http({ origin: 'any403' }),
  'legacy http, nothing served at the endpoint': () => http({ noEndpoint: true }),
  'modern http, a request of the server on the stream, no X-Accel-Buffering': () =>
    http(
      { sessions: false, answer: 'sse', serverRequest: true, discover: true },
      { protocolVersion: '2026-07-28' },
    ),
  // Silence on a line that is not JSON: the client may not write one on stdio, so only the advice is red there.
  'modern stdio, no answer to invalid JSON': () => run({ fixture: FIXTURE }, modernServer('quiet-parse')),
  'modern-only http, GET answered with a stream': () =>
    http(
      { sessions: false, get: 'sse', discover: 'modern-only' },
      { protocolVersion: '2026-07-28' },
    ),
};

/** Servers that keep every requirement: nothing may be `failed` on them. */
const GOOD: Record<string, () => Promise<McpConformanceReport>> = {
  'legacy stdio': () => run({ fixture: FIXTURE }, legacyServer('good')),
  'modern stdio': () => run({ fixture: FIXTURE }, modernServer('good')),
  'legacy http': () => http({ origin: 'check', host: 'check' }),
  'modern http': () => modernHttp({}),
  // A dual-era server that says so only by answering initialize: GET and DELETE without a session get 400 by the rules
  // of 2025-11-25, and the 405 asked of a modern-only server is not for it.
  'dual-era http, server/discover names 2026-07-28 only': () =>
    http(
      { sessions: false, get: 400, del: 400, discover: 'names-modern', host: 'check' },
      { protocolVersion: '2026-07-28' },
    ),
  // A process that a request without a protocol version moves to the legacy era: a check may not inherit that from
  // the checks before it, so the full run gives each check the verdict it gets alone.
  'dual-era stdio, the era of the process set by an earlier request': () =>
    run({ fixture: FIXTURE }, modernServer('sticky')),
};

/** Ids no server here can make red, each with its own reason; the test below holds this list exact. */
const NEVER_RED: Record<string, string> = {
  'life-version-negotiation':
    'the client library ends the connection on a protocolVersion that is not a supported revision, so the failure lands on life-initialize-result and this check is could-not-run (prerequisite-failed); no answer it accepts breaks the rule',
  'http-close-cancels':
    'whether a call stops when its stream is closed shows only in what the tool did; the command cannot watch that, so the check is always could-not-run (needs-input)',
};

const runs = new Map<string, McpConformanceReport>();
const goodRuns = new Map<string, McpConformanceReport>();
beforeAll(async () => {
  for (const [name, start] of Object.entries(BROKEN)) runs.set(name, await start());
  for (const [name, start] of Object.entries(GOOD)) goodRuns.set(name, await start());
}, 240_000);
afterAll(closeServed);

const failedIds = () =>
  new Set(
    [...runs.values()].flatMap((r) =>
      r.checks.filter((c) => c.state === 'failed').map((c) => c.id),
    ),
  );

describe('CLI · mcp conformance · every check has a server that makes it red', () => {
  it('every requirement of the catalog is failed by at least one broken server, or named here with the reason it cannot be', () => {
    const red = failedIds();
    const wanted = CATALOG.filter((e) => e.suite === 'protocol' && e.kind === 'check').map(
      (e) => e.id,
    );
    const uncovered = wanted.filter((id) => !red.has(id) && !(id in NEVER_RED));
    expect(uncovered, 'no fixture makes these red').toEqual([]);
    // An excuse that no longer holds is a stale excuse.
    expect(Object.keys(NEVER_RED).filter((id) => red.has(id))).toEqual([]);
    expect(Object.keys(NEVER_RED).filter((id) => !wanted.includes(id))).toEqual([]);
  });

  it('every control and advice of the catalog shows red on some server too, though it never moves the score', () => {
    const red = failedIds();
    const unscored = CATALOG.filter((e) => e.kind !== 'check').map((e) => e.id);
    expect(unscored.filter((id) => !red.has(id))).toEqual([]);
  });

  it('every failure says what was seen, how to fix it and where the specification says so', () => {
    for (const [name, r] of runs)
      for (const c of r.checks.filter((c) => c.state === 'failed')) {
        expect(c.actual, `${name}: ${c.id}`).not.toBe('');
        expect(c.fix, `${name}: ${c.id}`).not.toBe('');
        expect(c.specRef, `${name}: ${c.id}`).toMatch(
          /^https:\/\/modelcontextprotocol\.io\/specification\//,
        );
      }
  });

  it('a server that keeps every requirement has no failed check, on each transport and era', () => {
    const failing = Object.fromEntries(
      [...goodRuns].map(([name, r]) => [name, r.checks.filter((c) => c.state === 'failed').map((c) => c.id)]),
    );
    expect(failing).toEqual(Object.fromEntries([...goodRuns.keys()].map((name) => [name, []])));
  });

  it('a stdio server silent on invalid JSON fails the advice only, never a requirement, and keeps its verdict', () => {
    const r = runs.get('modern stdio, no answer to invalid JSON');
    expect(r?.checks.filter((c) => c.state === 'failed').map((c) => c.id)).toEqual([
      'stdio-parse-error-advice',
    ]);
    expect(r?.summary.verdict).toBe('passed');
  });

  it('a dual-era server with sessions that names 2026-07-28 only: both dual-era checks are not-applicable, and the session of the probe is ended', async () => {
    const served = await serve({ discover: 'names-modern', get: 400, host: 'check' });
    const r = await run({
      url: served.url,
      check: ['mod-no-session-id', 'http-modern-get-delete-405'],
      protocolVersion: '2026-07-28',
    });
    for (const id of ['mod-no-session-id', 'http-modern-get-delete-405']) {
      const c = r.checks.find((x) => x.id === id);
      expect(`${c?.state} (${c?.reason})`, id).toBe('not-applicable (era)');
      expect(c?.actual, id).toContain('initialize sent as a 2025-11-25 client');
      expect(c?.details?.length, id).toBeGreaterThan(0);
    }
    const alive = served.alive();
    expect(Object.keys(alive).length).toBeGreaterThan(0);
    expect(Object.values(alive)).not.toContain(true);
  });

  it('when the legacy probe gets no answer or a server error, the 405 check is could-not-run, never judged as modern-only', async () => {
    const at = async (initStatus: number | 'hang') => {
      const served = await serve({ sessions: false, discover: 'names-modern', get: 400, del: 400, initStatus });
      const r = await run({ url: served.url, check: ['http-modern-get-delete-405'], protocolVersion: '2026-07-28' });
      const c = r.checks[0];
      return `${c?.state} (${c?.reason})`;
    };
    expect(await at('hang')).toBe('could-not-run (timeout)');
    expect(await at(503)).toBe('could-not-run (transport-error)');
  }, 30_000);

  it('what a good server leaves unmeasured always comes with a reason', () => {
    for (const [name, r] of goodRuns)
      for (const c of r.checks.filter(
        (c) => c.state === 'not-applicable' || c.state === 'could-not-run',
      ))
        expect(c.reason, `${name}: ${c.id}`).toBeTruthy();
  });
});
