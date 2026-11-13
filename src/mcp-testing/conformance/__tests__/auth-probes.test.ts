// The probes of the oauth suite that need no person and create nothing: an unknown client, and a redirect URI that is not
// registered. Each depends on a refusal, so each has a control: the real client, with its real redirect URI, must not be
// refused. Against the loopback servers of auth-fixture.ts.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  handleMcpConformance,
  type McpConformanceFlags,
} from '../../../cli/commands/mcp-conformance.js';
import type { McpConformanceReport } from '../../result.js';
import { CATALOG } from '../catalog.js';
import { PROFILE } from '../profile.js';
import {
  authFixture,
  CLIENT_ID,
  CLIENT_SECRET,
  type AuthFixture,
  type AuthOpts,
} from './auth-fixture.js';

const dir = mkdtempSync(join(tmpdir(), 'plune-oauth-probes-'));
const open: AuthFixture[] = [];
afterEach(async () => {
  for (const f of open.splice(0)) await f.close();
});
const serve = async (o: AuthOpts = {}) => {
  const f = await authFixture(o);
  open.push(f);
  return f;
};

const SECRET_ENV = 'PLUNE_TEST_OAUTH_CLIENT_SECRET';
let n = 0;
const configFile = (config: unknown): string => {
  const path = join(dir, `c${++n}.json`);
  writeFileSync(path, JSON.stringify(config));
  return path;
};
const CB = 'http://127.0.0.1:8765/callback';
/** A pre-registered client with credentials; `bare`: with a client_id only. */
const client = (reg: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  configFile({
    auth: 'client-credentials',
    redirectUri: CB,
    registration: {
      method: 'preregistered',
      clientId: CLIENT_ID,
      clientSecretEnv: SECRET_ENV,
      ...reg,
    },
    ...extra,
  });
const bare = () =>
  configFile({ redirectUri: CB, registration: { method: 'preregistered', clientId: CLIENT_ID } });

async function run(url: string, flags: Partial<McpConformanceFlags> = {}) {
  let out = '';
  let err = '';
  const code = await handleMcpConformance(
    {
      timeout: '10s',
      format: 'json',
      suite: ['oauth'],
      protocolVersion: '2026-07-28',
      url,
      ...(flags.config === undefined ? {} : { allowOrigin: [new URL(url).origin] }),
      ...flags,
    },
    [],
    {
      out: (s) => (out += s),
      err: (s) => (err += s),
      env: { [SECRET_ENV]: CLIENT_SECRET },
      cwd: dir,
      clientVersion: '9.9.9',
    },
  );
  return {
    code,
    out,
    err,
    report: out === '' ? undefined : (JSON.parse(out) as McpConformanceReport),
  };
}

const verdict = (r: McpConformanceReport | undefined, id: string) => {
  const c = r!.checks.find((x) => x.id === id)!;
  return c.reason === undefined ? c.state : `${c.state} (${c.reason})`;
};
const actual = (r: McpConformanceReport | undefined, id: string) =>
  r!.checks.find((x) => x.id === id)!.actual;

const IC = 'oauth-neg-invalid-client';
const RM = 'oauth-neg-authorize-redirect-mismatch';
const FOREIGN = 'plune-conformance-other.invalid';
const asked = (s: AuthFixture) => s.seen.filter((x) => x.path === '/authorize');
const UNKNOWN = 'plune-conformance-unknown-client-';
const unknownAsked = (s: AuthFixture) => asked(s).filter((x) => x.query.includes(UNKNOWN));
const foreignAsked = (s: AuthFixture) =>
  asked(s).filter((x) => x.query.includes('invalid%2F') || x.query.includes(FOREIGN));
const basicOf = (x: { authorization: string | undefined }) =>
  Buffer.from((x.authorization ?? '').replace('Basic ', ''), 'base64').toString();
const unknownTokens = (s: AuthFixture) =>
  s.seen.filter((x) => x.path === '/token' && basicOf(x).startsWith(UNKNOWN));

describe('CLI · mcp conformance · oauth probes · catalog', () => {
  it('both checks are catalogued as MUST with a cited section, and are outside the profile', () => {
    for (const id of [IC, RM]) {
      const e = CATALOG.find((x) => x.id === id);
      expect(e, id).toBeDefined();
      expect(e!.suite).toBe('oauth');
      expect(e!.level).toBe('MUST');
      expect(e!.specRefs.length).toBeGreaterThan(0);
      if (e!.derived) expect(e!.derivation).toBeTruthy();
      expect(PROFILE.checks).not.toContain(id);
    }
  });
});

describe('CLI · mcp conformance · oauth probes · a client that does not exist', () => {
  it('is refused at both endpoints: passed, with the real client as the control for each', async () => {
    const s = await serve({});
    const { report } = await run(s.url, { config: client() });
    expect(verdict(report, IC)).toBe('passed');
    expect(unknownAsked(s)).toHaveLength(1);
    expect(unknownTokens(s)).toHaveLength(1);
  });

  it('the made-up client never carries the real secret', async () => {
    const s = await serve({});
    await run(s.url, { config: client() });
    expect(unknownTokens(s)).toHaveLength(1);
    for (const x of unknownTokens(s)) expect(basicOf(x)).not.toContain(CLIENT_SECRET);
    expect(unknownTokens(s).some((x) => (x.authorization ?? '').includes(CLIENT_SECRET))).toBe(
      false,
    );
  });

  const failing: [string, AuthOpts, RegExp][] = [
    ['redirected to the redirect URI with a code', { authorize: 'accept-unknown' }, /redirect/i],
    [
      'redirected to the redirect URI with an error (RFC 6749 4.1.2.1)',
      { authorize: 'unknown-error-redirect' },
      /MUST NOT|redirect/i,
    ],
    ['given a token at the token endpoint', { tokenUnknown: 'accept' }, /token/i],
  ];
  for (const [name, opts, says] of failing)
    it(`a client that is ${name}: failed`, async () => {
      const s = await serve(opts);
      const { report } = await run(s.url, { config: client() });
      expect(verdict(report, IC)).toBe('failed');
      expect(actual(report, IC)).toMatch(says);
    });

  it('invalid_request at the token endpoint is a refusal too', async () => {
    const s = await serve({ tokenUnknown: 'invalid-request' });
    const { report } = await run(s.url, { config: client() });
    expect(verdict(report, IC)).toBe('passed');
  });

  const inconclusive: [string, AuthOpts, string][] = [
    [
      '403 with no code at the token endpoint',
      { tokenUnknown: 'forbidden' },
      'could-not-run (prerequisite-failed)',
    ],
    [
      'the sign-in page for every client',
      { authorize: 'login-all' },
      'could-not-run (needs-input)',
    ],
    [
      'a redirect to the sign-in for every client',
      { authorize: 'redirect-login-all' },
      'could-not-run (needs-input)',
    ],
    ['429 at the authorization endpoint', { authorize: 429 }, 'could-not-run (transport-error)'],
    ['503 at the authorization endpoint', { authorize: 503 }, 'could-not-run (transport-error)'],
    [
      '503 at the token endpoint (the control)',
      { force: { 'token:own': 503 } },
      'could-not-run (transport-error)',
    ],
  ];
  for (const [name, opts, expected] of inconclusive)
    it(`${name}: ${expected}`, async () => {
      const s = await serve(opts);
      const { report } = await run(s.url, { config: client() });
      expect(verdict(report, IC)).toBe(expected);
    });

  it('a pre-registered client the server refuses is not a control: could-not-run', async () => {
    const s = await serve({});
    const { report } = await run(s.url, { config: client({ clientId: 'no-such-client' }) });
    expect(verdict(report, IC)).toMatch(/^could-not-run/);
  });

  it('the real client refused at the authorization endpoint is no control, with or without credentials', async () => {
    const s = await serve({});
    const unknown = configFile({
      redirectUri: CB,
      registration: { method: 'preregistered', clientId: 'no-such-client' },
    });
    const { report } = await run(s.url, { config: unknown });
    expect(verdict(report, IC)).toBe('could-not-run (prerequisite-failed)');
    const all = await serve({ authorize: 'forbidden' });
    const b = await run(all.url, { config: bare() });
    expect(verdict(b.report, IC)).toBe('could-not-run (prerequisite-failed)');
  });

  it('without credentials only the authorization half runs, and the result says so', async () => {
    const s = await serve({});
    const { report } = await run(s.url, { config: bare() });
    expect(verdict(report, IC)).toBe('passed');
    expect(actual(report, IC)).toContain('token endpoint was not asked');
    expect(unknownTokens(s)).toEqual([]);
  });

  it('a token endpoint on an origin that was not named gets nothing, and the result says so', async () => {
    const s = await serve({});
    const { report } = await run(s.url, { config: client(), allowOrigin: [] });
    expect(verdict(report, IC)).toBe('passed');
    expect(actual(report, IC)).toContain('token endpoint was not asked');
    expect(s.seen.filter((x) => x.path === '/token')).toEqual([]);
  });

  it('without a pre-registered client_id and redirectUri: could-not-run (needs-input), and no request', async () => {
    const s = await serve({});
    const dcr = configFile({ redirectUri: CB, registration: { method: 'dcr' } });
    const a = await run(s.url, { config: dcr });
    expect(verdict(a.report, IC)).toBe('could-not-run (needs-input)');
    const noUri = await run(s.url, {
      config: configFile({ registration: { method: 'preregistered', clientId: CLIENT_ID } }),
    });
    expect(verdict(noUri.report, IC)).toBe('could-not-run (needs-input)');
    expect(asked(s)).toEqual([]);
  });

  it('a public server: not-applicable (no-auth)', async () => {
    const s = await serve({ public: true });
    const { report } = await run(s.url, { config: client() });
    expect(verdict(report, IC)).toBe('not-applicable (no-auth)');
  });
});

describe('CLI · mcp conformance · oauth probes · a redirect URI that is not registered', () => {
  it('is refused: passed, with the registered redirect URI as the control', async () => {
    const s = await serve({});
    const { report } = await run(s.url, { config: bare() });
    expect(verdict(report, RM)).toBe('passed');
    expect(foreignAsked(s)).toHaveLength(1);
  });

  it('the other URI is on an .invalid host, and is not followed', async () => {
    const other = await serve({});
    const s = await serve({ force: { authorize: `${other.origin}/x` } });
    const { report } = await run(s.url, { config: bare() });
    expect(verdict(report, RM)).toBe('could-not-run (needs-input)');
    expect(other.seen).toEqual([]);
  });

  const violated: [string, AuthOpts][] = [
    ['with a code', { authorize: 'redirect-any' }],
    ['with an error', { authorize: 'redirect-any-error' }],
  ];
  for (const [name, opts] of violated)
    it(`a redirect to the other URI ${name}: failed, and the result names the URI`, async () => {
      const s = await serve(opts);
      const { report } = await run(s.url, { config: bare() });
      expect(verdict(report, RM)).toBe('failed');
      expect(actual(report, RM)).toContain(FOREIGN);
    });

  it('a redirect to the sign-in of the server that keeps the other URI in a parameter is not a violation', async () => {
    const s = await serve({ authorize: 'redirect-login-keeps-uri' });
    const { report } = await run(s.url, { config: bare() });
    expect(verdict(report, RM)).toBe('could-not-run (needs-input)');
    expect(actual(report, RM)).not.toMatch(/violat/i);
  });

  const inconclusive: [string, AuthOpts, string][] = [
    [
      'the sign-in page for every request',
      { authorize: 'login-all' },
      'could-not-run (needs-input)',
    ],
    ['429', { authorize: 429 }, 'could-not-run (transport-error)'],
    ['503', { authorize: 503 }, 'could-not-run (transport-error)'],
    [
      '403 for every request: the control is refused too',
      { authorize: 'forbidden' },
      'could-not-run (prerequisite-failed)',
    ],
  ];
  for (const [name, opts, expected] of inconclusive)
    it(`${name}: ${expected}`, async () => {
      const s = await serve(opts);
      const { report } = await run(s.url, { config: bare() });
      expect(verdict(report, RM)).toBe(expected);
    });

  it('a client the server refuses is not a control: could-not-run', async () => {
    const s = await serve({});
    const { report } = await run(s.url, {
      config: configFile({
        redirectUri: CB,
        registration: { method: 'preregistered', clientId: 'no-such-client' },
      }),
    });
    expect(verdict(report, RM)).toBe('could-not-run (prerequisite-failed)');
  });

  it('without a pre-registered client_id or redirectUri: could-not-run (needs-input), and no request', async () => {
    const s = await serve({});
    const { report } = await run(s.url, {
      config: configFile({ registration: { method: 'dcr' } }),
    });
    expect(verdict(report, RM)).toBe('could-not-run (needs-input)');
    expect(asked(s)).toEqual([]);
  });
});
