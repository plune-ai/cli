// The Streamable HTTP and local-protection checks of `plune mcp conformance`, each against a plain HTTP server on
// this machine that keeps its requirement and one that breaks it. The server below speaks JSON-RPC over node:http with
// no MCP library, so each behaviour can be broken on its own; the run is the whole command, as a user starts it.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { handleMcpConformance, type McpConformanceFlags } from '../../../cli/commands/mcp-conformance.js';
import { closeServed, serve } from '../../__tests__/fixtures/conformance-http-servers.js';
import { recorder } from '../../__tests__/fixtures/http-servers.js';
import { ConnectError } from '../../connect/session.js';
import { createRedactor } from '../../connect/redact.js';
import type { McpConformanceReport } from '../../result.js';
import { CATALOG } from '../catalog.js';
import type { ConformanceContext } from '../checks/index.js';
import { outsideAddresses, SECURITY } from '../checks/security.js';
import { exchange, isLocal, rawRequest, type HttpTarget } from '../raw-http.js';

const servers: { close(): Promise<void> }[] = [];
afterEach(closeServed);
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

const HTTP_IDS = CATALOG.filter((e) => e.id.startsWith('http-')).map((e) => e.id);

async function run(flags: McpConformanceFlags) {
  let out = '';
  let err = '';
  // The HTTP checks only: the rest of the protocol suite has tests of its own (checks.test.ts).
  const code = await handleMcpConformance({ timeout: '10s', format: 'json', check: HTTP_IDS, ...flags }, [], {
    out: (s) => (out += s),
    err: (s) => (err += s),
    env: {},
    clientVersion: '9.9.9',
  });
  return { code, out, err, report: out.startsWith('{') ? (JSON.parse(out) as McpConformanceReport) : undefined };
}

const states = (r: McpConformanceReport) =>
  Object.fromEntries(
    r.checks.filter((c) => c.id.startsWith('http-')).map((c) => [c.id, c.reason === undefined ? c.state : `${c.state} (${c.reason})`]),
  );
const byId = (r: McpConformanceReport, id: string) => r.checks.find((c) => c.id === id)!;
const outside = outsideAddresses().length > 0;
/** Each outside address tried, by its family and what the connection got; the address itself never in the report. */
const triedEach = (actual: string | undefined, said: RegExp) => {
  const tried = [...(actual ?? '').matchAll(/IPv[46] ([a-z0-9 ]+?)(?=[,)])/g)].map((m) => m[1]);
  expect(tried, actual).toHaveLength(outsideAddresses().length);
  for (const got of tried) expect(got).toMatch(said);
  for (const a of outsideAddresses()) expect(actual).not.toContain(a);
};

describe('CLI · mcp conformance · Streamable HTTP on the wire', () => {
  it('a server that keeps every requirement passes every HTTP check that applies to a legacy run', async () => {
    const s = await serve({ origin: 'check', host: 'check' });
    const { report, code } = await run({ url: s.url });
    expect(states(report!)).toEqual({
      'http-notification-202': 'passed',
      'http-request-content-type': 'passed',
      'http-response-utf8': 'passed',
      'http-single-endpoint': 'passed',
      'http-get-stream-or-405': 'passed',
      'http-modern-get-delete-405': 'not-applicable (era)',
      'http-session-id-visible-ascii': 'passed',
      'http-session-required-400': 'passed',
      'http-protocol-version-header-invalid-400': 'passed',
      'http-concurrent-posts-matched': 'passed',
      'http-sse-event-ids-unique': 'not-applicable (not-offered)',
      'http-sse-stream-closes': 'not-applicable (not-offered)',
      'http-sse-no-server-requests': 'not-applicable (era)',
      'http-accel-buffering-header': 'not-applicable (era)',
      'http-close-cancels': 'not-applicable (era)',
      'http-session-terminated-404': 'passed',
      'http-sse-no-broadcast': 'could-not-run (needs-input)',
      'http-origin-invalid-403': 'passed',
      'http-origin-localhost-accepted': 'passed',
      'http-origin-absent-accepted': 'passed',
      'http-bind-loopback': outside ? 'passed' : 'could-not-run (needs-input)',
      'http-host-rebinding-advice': 'passed',
    });
    expect(Object.keys(states(report!))).toEqual(HTTP_IDS);
    // Every measured check keeps what it sent and what came back.
    for (const id of ['http-notification-202', 'http-origin-invalid-403', 'http-session-terminated-404'])
      expect(byId(report!, id).details?.length, id).toBeGreaterThan(0);
    expect(byId(report!, 'http-origin-invalid-403').details?.[1]?.request.headers).toContainEqual(['Origin', 'https://evil.example']);
    if (outside) triedEach(byId(report!, 'http-bind-loopback').actual, /^(refused|no answer in 500 ms)$/);
    // None of these is in the frozen profile yet: they show their verdict and stay out of the score.
    expect(report!.summary).toMatchObject({ failed: [], score: null });
    expect(code).toBe(3);
  });

  it('a server that breaks each requirement fails each check, with what it got and how to fix it', async () => {
    const s = await serve({
      sessions: (n) => `bad id ${n}`,
      notification: 'body',
      answer: 'text',
      badUtf8: true,
      lax: true,
      get: 'json',
      origin: 'ignore',
      host: 'ignore',
      bind: '0.0.0.0',
    });
    const { report, code } = await run({ url: s.url });
    const got = states(report!);
    for (const id of [
      'http-notification-202',
      'http-request-content-type',
      'http-response-utf8',
      'http-get-stream-or-405',
      'http-session-id-visible-ascii',
      'http-session-required-400',
      'http-protocol-version-header-invalid-400',
      'http-concurrent-posts-matched',
      'http-session-terminated-404',
      'http-origin-invalid-403',
      'http-host-rebinding-advice',
    ])
      expect(got[id], id).toBe('failed');
    expect(got['http-bind-loopback']).toBe(outside ? 'failed' : 'could-not-run (needs-input)');
    if (outside) triedEach(byId(report!, 'http-bind-loopback').actual, /^(open|refused|no answer in 500 ms)$/);
    expect(got['http-single-endpoint']).toBe('passed');
    for (const c of report!.checks.filter((c) => c.id.startsWith('http-') && c.state === 'failed')) {
      expect(c.actual, c.id).not.toBe('');
      expect(c.fix, c.id).not.toBe('');
      expect(c.specRef, c.id).toMatch(/^https:\/\/modelcontextprotocol\.io\/specification\//);
    }
    expect(byId(report!, 'http-notification-202').actual).toContain('HTTP 200 and a body');
    expect(byId(report!, 'http-session-id-visible-ascii').actual).toContain('0x20');
    expect(byId(report!, 'http-response-utf8').actual).toContain('not valid UTF-8');
    expect(report!.summary.score).toBeNull();
    expect(code).toBe(3);
  });

  it('AC-6: a non-ASCII session id fails, and a server without sessions makes the session checks not-applicable', async () => {
    const bad = await serve({ sessions: (n) => `sé${n}`, lax: true });
    expect(states((await run({ url: bad.url })).report!)['http-session-id-visible-ascii']).toBe('failed');
    const none = await serve({ sessions: false });
    const got = states((await run({ url: none.url })).report!);
    for (const id of ['http-session-id-visible-ascii', 'http-session-required-400', 'http-session-terminated-404'])
      expect(got[id], id).toBe('not-applicable (not-offered)');
    expect(got['http-notification-202']).toBe('passed');
  });

  it('a session the server does not let a client end (DELETE 405) is not-applicable, not failed', async () => {
    const s = await serve({ del: '405' });
    expect(states((await run({ url: s.url })).report!)['http-session-terminated-404']).toBe('not-applicable (not-offered)');
  });

  it('AC-5: modern: a notification refused with 400 passes; one answered 200, or 202, with a body fails', async () => {
    const refused = await serve({ sessions: false, notification: 'refuse', discover: true });
    const ok = await run({ url: refused.url, protocolVersion: '2026-07-28' });
    expect(states(ok.report!)['http-notification-202']).toBe('passed');
    // A modern probe carries its version and method as headers and in _meta.
    const discover = refused.bodies.find((b) => b.body.includes('server/discover'))!;
    expect(discover.headers['mcp-method']).toBe('server/discover');
    expect(discover.headers['mcp-protocol-version']).toBe('2026-07-28');
    expect(discover.body).toContain('io.modelcontextprotocol/protocolVersion');
    const body = await serve({ sessions: false, notification: 'body', discover: true });
    expect(states((await run({ url: body.url, protocolVersion: '2026-07-28' })).report!)['http-notification-202']).toBe('failed');
    const body202 = await serve({ notification: 'body202' });
    const r = (await run({ url: body202.url })).report!;
    expect(states(r)['http-notification-202']).toBe('failed');
    expect(byId(r, 'http-notification-202').actual).toBe('The notification got HTTP 202 and a body of 17 characters.');
  });

  it('SSE answers: a stream left open with repeated event ids fails, one that closes with unique ids passes', async () => {
    const bad = await serve({ answer: 'sse', keepOpen: true, eventIds: 'repeat' });
    const red = states((await run({ url: bad.url })).report!);
    expect(red['http-sse-stream-closes']).toBe('failed');
    expect(red['http-sse-event-ids-unique']).toBe('failed');
    expect(red['http-request-content-type']).toBe('passed');
    const good = await serve({ answer: 'sse' });
    const green = states((await run({ url: good.url })).report!);
    expect(green['http-sse-stream-closes']).toBe('passed');
    expect(green['http-sse-event-ids-unique']).toBe('passed');
    expect(green['http-response-utf8']).toBe('passed');
    const noIds = await serve({ answer: 'sse', eventIds: 'none' });
    expect(states((await run({ url: noIds.url })).report!)['http-sse-event-ids-unique']).toBe('not-applicable (not-offered)');
  });

  it('modern SSE: a request of the server on the stream and no X-Accel-Buffering fail; without them they pass', async () => {
    const bad = await serve({ sessions: false, answer: 'sse', serverRequest: true, discover: true });
    const red = states((await run({ url: bad.url, protocolVersion: '2026-07-28' })).report!);
    expect(red['http-sse-no-server-requests']).toBe('failed');
    expect(red['http-accel-buffering-header']).toBe('failed');
    // Its server/discover names 2025-11-25 too: a dual-era server, which the GET and DELETE check is not for.
    expect(red['http-modern-get-delete-405']).toBe('not-applicable (era)');
    expect(red['http-close-cancels']).toBe('could-not-run (needs-input)');
    const good = await serve({ sessions: false, answer: 'sse', accel: true, discover: true });
    const green = states((await run({ url: good.url, protocolVersion: '2026-07-28' })).report!);
    expect(green['http-sse-no-server-requests']).toBe('passed');
    expect(green['http-accel-buffering-header']).toBe('passed');
    const json = await serve({ sessions: false, discover: true });
    expect(states((await run({ url: json.url, protocolVersion: '2026-07-28' })).report!)['http-accel-buffering-header']).toBe(
      'not-applicable (not-offered)',
    );
  });

  it('answers under the wrong id fail http-concurrent-posts-matched', async () => {
    const s = await serve({ wrongId: true });
    const r = (await run({ url: s.url })).report!;
    expect(states(r)['http-concurrent-posts-matched']).toBe('failed');
    expect(byId(r, 'http-concurrent-posts-matched').actual).toContain('the id "not-yours"');
  });

  it('two GET streams: a message sent to both fails http-sse-no-broadcast, a message sent to one passes', async () => {
    const fixture = [{ tool: 'note', arguments: {} }];
    const bad = await serve({ get: 'sse', broadcast: true });
    const red = await run({ url: bad.url, fixture: fixtureFile(fixture) });
    expect(states(red.report!)['http-sse-no-broadcast']).toBe('failed');
    const good = await serve({ get: 'sse' });
    expect(states((await run({ url: good.url, fixture: fixtureFile(fixture) })).report!)['http-sse-no-broadcast']).toBe('passed');
  }, 20_000);
});

describe('CLI · mcp conformance · a local server against DNS rebinding', () => {
  it('AC-4: a server that takes a foreign Origin fails http-origin-invalid-403', async () => {
    const s = await serve({ origin: 'ignore' });
    const r = (await run({ url: s.url })).report!;
    expect(states(r)['http-origin-invalid-403']).toBe('failed');
    expect(byId(r, 'http-origin-invalid-403').actual).toContain('https://evil.example got HTTP 200');
  });

  it('AC-4: a server that refuses every Origin is could-not-run (prerequisite-failed), never passed', async () => {
    const s = await serve({ origin: 'any403' });
    const r = (await run({ url: s.url })).report!;
    expect(states(r)['http-origin-invalid-403']).toBe('could-not-run (prerequisite-failed)');
    expect(states(r)['http-origin-localhost-accepted']).toBe('failed');
    expect(states(r)['http-origin-absent-accepted']).toBe('passed');
    // A control is printed, never scored.
    expect(byId(r, 'http-origin-localhost-accepted')).toMatchObject({ kind: 'control', level: null, bucket: 'controls' });
  });

  it('AC-7: the Host advice never moves the score or the exit code, and says it is outside the specification', async () => {
    // The whole protocol suite, against the same server with and without the foreign Host refused.
    const s = await serve({ host: 'ignore' });
    const { report, code } = await run({ url: s.url, check: [] });
    const advice = byId(report!, 'http-host-rebinding-advice');
    expect(advice).toMatchObject({ state: 'failed', kind: 'advice', class: 'heuristic', level: null, bucket: 'advisories' });
    expect(advice.fix).toContain('Not a requirement of the specification');
    expect(report!.summary.failed).not.toContain('http-host-rebinding-advice');
    const kept = await run({ url: (await serve({ host: 'check' })).url, check: [] });
    expect(byId(kept.report!, 'http-host-rebinding-advice').state).toBe('passed');
    expect(report!.summary.score).toBe(kept.report!.summary.score);
    expect(report!.summary.verdict).toBe(kept.report!.summary.verdict);
    expect(code).toBe(kept.code);
    // The probe did reach the server with the foreign Host.
    expect(s.requests.some((r) => r.headers.host === 'evil.example')).toBe(true);
  });

  it('AC-3: on a host that is not a loopback name the security checks are not-applicable (not-local)', async () => {
    const ctx = {
      http: { url: 'https://mcp.example.com/mcp', headers: {}, redact: createRedactor([]), fetch: () => Promise.reject(new Error('no request')) },
    } as unknown as ConformanceContext;
    for (const [id, check] of Object.entries(SECURITY)) expect(await check(ctx), id).toMatchObject({ state: 'not-applicable', reason: 'not-local' });
    for (const url of ['http://localhost:3000/mcp', 'http://127.0.0.1/mcp', 'http://[::1]:8080/mcp', 'http://app.localhost/mcp'])
      expect(isLocal(url), url).toBe(true);
    for (const url of ['http://127.0.0.2/mcp', 'https://localhost.example.com/mcp', 'http://10.0.0.5/mcp']) expect(isLocal(url), url).toBe(false);
  });
});

describe('CLI · mcp conformance · the raw HTTP layer', () => {
  const token = 'raw-http-secret-marker-5d1e';
  const targetOf = (url: string, headers: Record<string, string> = {}): HttpTarget => ({
    url,
    headers,
    redact: createRedactor(Object.values(headers).concat(token)),
    // The session's fetch for the origin, as the command gives it: the --header values added, no redirect followed.
    fetch: (input, init) => {
      const h = new Headers(init?.headers);
      for (const [n, v] of Object.entries(headers)) if (!h.has(n)) h.set(n, v);
      return fetch(input, { ...init, headers: h, redirect: 'manual' });
    },
  });

  async function stream(write: (res: ServerResponse) => void) {
    const server = createServer((_req, res) => write(res));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push({
      close: () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    });
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  }

  it('reads SSE events with their id, event, retry and data; skips comments; stops at the event limit', async () => {
    const url = await stream((res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(': keep-alive\n\nid: 7\nevent: message\nretry: 1500\ndata: {"a":\ndata: 1}\n\nid: 8\ndata: two\n\ndata: three\n\n');
    });
    const r = await rawRequest(targetOf(url), { method: 'GET', headers: [['Accept', 'text/event-stream']] });
    expect(r.events).toEqual([
      { id: '7', event: 'message', retry: 1500, data: '{"a":\n1}' },
      { id: '8', data: 'two' },
      { data: 'three' },
    ]);
    expect(r.ended).toBe(true);
    const cut = await rawRequest(targetOf(url), { method: 'GET', headers: [] }, { maxEvents: 2 });
    expect(cut.events).toHaveLength(2);
    expect(cut.ended).toBe(false);
  });

  it('a stream that stays open is read until the time limit and returned, not thrown', async () => {
    const url = await stream((res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: first\n\n');
    });
    const r = await rawRequest(targetOf(url), { method: 'GET', headers: [] }, { timeoutMs: 300 });
    expect(r).toMatchObject({ status: 200, ended: false, events: [{ data: 'first' }] });
    expect(r.ms).toBeGreaterThanOrEqual(250);
  });

  it('no status in time is a ConnectError (timeout); an unreachable server is one (network)', async () => {
    const url = await stream(() => {});
    await expect(rawRequest(targetOf(url), { method: 'GET', headers: [] }, { timeoutMs: 200 })).rejects.toMatchObject({
      kind: 'timeout',
    });
    const closed = 'http://127.0.0.1:1/mcp';
    const err = await rawRequest(targetOf(closed), { method: 'GET', headers: [] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectError);
    expect((err as ConnectError).kind).toBe('network');
  });

  it('AC-8: an exchange keeps no credential: secret headers masked, the token masked in the body', async () => {
    const url = await stream((res) => res.writeHead(401, { 'content-type': 'text/plain' }).end(`bad token ${token}`));
    const t = targetOf(url, { Authorization: `Bearer ${token}` });
    const req = { method: 'POST', headers: [['Authorization', `Bearer ${token}`], ['X-Api-Key', 'short']] as [string, string][], body: `{"t":"${token}"}` };
    const x = exchange(t, req, await rawRequest(t, req));
    expect(JSON.stringify(x)).not.toContain(token);
    expect(x.request.headers).toEqual([
      ['Authorization', '***'],
      ['X-Api-Key', '***'],
    ]);
    expect(x.response?.body).toBe('bad token ***');
  });

  it('a secret that straddles the cut of a body is masked before the body is cut, in the request and the response', async () => {
    // The secret starts fifteen characters before the 2000th, so the cut would leave a part of it that is not the whole.
    const straddle = (tail: string) => `${'x'.repeat(1985)}${token}${tail}`;
    const body = straddle('y'.repeat(500));
    const url = await stream((res) => res.writeHead(200, { 'content-type': 'text/plain' }).end(body));
    const t = targetOf(url);
    const req = { method: 'POST', headers: [] as [string, string][], body: straddle('z'.repeat(40)) };
    const x = exchange(t, req, await rawRequest(t, req));
    const all = JSON.stringify(x);
    for (let i = 0; i + 8 <= token.length; i++) expect(all).not.toContain(token.slice(i, i + 8));
    // The note keeps the length of the body as it was.
    expect(x.response?.body).toContain(`(cut: ${body.length} characters)`);
    expect(x.request.body).toContain(`(cut: ${req.body.length} characters)`);
  });

  it('a Host of its own goes through node:http, to the same address, with the --header values', async () => {
    let seen: IncomingMessage['headers'] = {};
    const url = await stream((res) => {
      seen = (res.req as IncomingMessage).headers;
      res.writeHead(204).end();
    });
    const r = await rawRequest(targetOf(url, { Authorization: `Bearer ${token}` }), { method: 'GET', headers: [['Host', 'evil.example']] });
    expect(r.status).toBe(204);
    expect(seen.host).toBe('evil.example');
    expect(seen.authorization).toBe(`Bearer ${token}`);
  });
});

describe('CLI · mcp conformance · credentials reach the server under test only', () => {
  it('AC-8: a redirect to another origin is not followed: the token never leaves, and no detail holds it', async () => {
    const token = 'conformance-redirect-marker-a41c';
    const other = await recorder();
    servers.push(other);
    const s = await serve({ redirect: other.origin });
    const { out, err, report } = await run({ url: s.url, header: [`Authorization: Bearer ${token}`] });
    expect(other.requests).toEqual([]);
    expect(out + err).not.toContain(token);
    const notified = byId(report!, 'http-request-content-type');
    expect(notified.state).toBe('could-not-run');
    expect(notified.details?.[0]?.response?.status).toBe(307);
    // The server under test did get it.
    expect(s.requests.some((r) => r.headers.authorization === `Bearer ${token}`)).toBe(true);
    expect(JSON.stringify(report!.checks.flatMap((c) => c.details ?? []))).toContain('"Authorization","***"');
  });
});

function fixtureFile(calls: unknown): string {
  const path = join(mkdtempSync(join(tmpdir(), 'plune-conformance-http-')), 'fixture.json');
  writeFileSync(path, JSON.stringify(calls));
  return path;
}

describe('CLI · mcp conformance · a status that proves nothing is could-not-run, a refusal needs its control', () => {
  const NOT_JUDGED = 'could-not-run (transport-error)';
  const one = async (opts: Parameters<typeof serve>[0], id: string, flags: Partial<McpConformanceFlags> = {}) => {
    const s = await serve(opts);
    return states((await run({ url: s.url, check: [id], ...flags })).report!)[id];
  };

  for (const status of [429, 503, 302])
    it(`HTTP ${status} to the notification, to GET or to a refusal probe is not a verdict`, async () => {
      expect(await one({ notification: status }, 'http-notification-202')).toBe(NOT_JUDGED);
      expect(await one({ get: status }, 'http-get-stream-or-405')).toBe(NOT_JUDGED);
      const refusals = await serve({ refuse: status, origin: 'check', host: 'check', get: '405' });
      const got = states(
        (
          await run({
            url: refusals.url,
            check: [
              'http-session-required-400',
              'http-protocol-version-header-invalid-400',
              'http-session-terminated-404',
              'http-origin-invalid-403',
              'http-host-rebinding-advice',
            ],
          })
        ).report!,
      );
      for (const id of Object.keys(got)) expect(got[id], id).toBe(NOT_JUDGED);
    });

  it('HTTP 401 is a wall in front of the endpoint: could-not-run (prerequisite-failed), not a verdict', async () => {
    expect(await one({ notification: 401 }, 'http-notification-202')).toBe('could-not-run (prerequisite-failed)');
    expect(await one({ get: 401 }, 'http-get-stream-or-405')).toBe('could-not-run (prerequisite-failed)');
  });

  it('modern: a 503 to GET or DELETE is not a verdict', async () => {
    expect(
      await one({ sessions: false, discover: 'modern-only', get: 503, del: 503 }, 'http-modern-get-delete-405', {
        protocolVersion: '2026-07-28',
      }),
    ).toBe(NOT_JUDGED);
  });

  it('a server that refuses the valid request too: the 400 of the probe proves nothing, could-not-run (prerequisite-failed)', async () => {
    const s = await serve({ pingStatus: 400 });
    const got = states(
      (
        await run({
          url: s.url,
          check: ['http-session-required-400', 'http-protocol-version-header-invalid-400', 'http-session-terminated-404'],
        })
      ).report!,
    );
    for (const id of Object.keys(got)) expect(got[id], id).toBe('could-not-run (prerequisite-failed)');
  });

  it('a stream that opens and never sends the answer is could-not-run (timeout) for the concurrent POSTs, not failed', async () => {
    const s = await serve({ silent: true });
    const got = states((await run({ url: s.url, check: ['http-concurrent-posts-matched'] })).report!);
    expect(got['http-concurrent-posts-matched']).toBe('could-not-run (timeout)');
  }, 30_000);
});

describe('CLI · mcp conformance · the sessions a run opens', () => {
  it('each session the run opened and did not end is closed with DELETE, and the report counts them', async () => {
    const s = await serve({});
    const { report } = await run({ url: s.url });
    const deletes = s.requests.filter((r) => r.method === 'DELETE');
    // One is the DELETE of http-session-terminated-404 itself; the other closes the session the checks shared.
    expect(deletes).toHaveLength(2);
    expect(new Set(deletes.map((d) => d.headers['mcp-session-id'])).size).toBe(2);
    expect(report!.ownSessions).toEqual({ opened: 2, closed: 2, leftOpen: 0 });
  });

  it('a server that does not let a client end a session: the sessions are reported as left open, in JSON and in the human report', async () => {
    const s = await serve({ del: '405' });
    const json = await run({ url: s.url });
    expect(json.report!.ownSessions).toEqual({ opened: 2, closed: 0, leftOpen: 2 });
    const human = await run({ url: s.url, format: 'human' });
    expect(human.out).toMatch(/2 sessions? of this run (was|were) left open/);
  });

  it('a session id is a secret: masked in every header of every detail and absent from the output', async () => {
    const s = await serve({ sessions: (n) => `sess-abcdefgh-${n}` });
    const { out, report } = await run({ url: s.url });
    expect(out).not.toContain('sess-abcdefgh');
    const sent = report!.checks.flatMap((c) => c.details ?? []).flatMap((d) => d.request.headers);
    expect(sent.filter(([n]) => n.toLowerCase() === 'mcp-session-id').every(([, v]) => v === '***')).toBe(true);
    expect(sent.some(([n]) => n.toLowerCase() === 'mcp-session-id')).toBe(true);
  });

  it('a session id that the server prints in a body is masked there too', async () => {
    const s = await serve({ sessions: (n) => `sess-abcdefgh-${n}`, echoSession: true });
    const { out } = await run({ url: s.url });
    expect(out).not.toContain('sess-abcdefgh');
  });
});
