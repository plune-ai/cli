// The unattended sign-in of the oauth suite: a token from the client-credentials grant, and the one request that shows
// whether the server takes it. Against the loopback servers of auth-fixture.ts.

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

const dir = mkdtempSync(join(tmpdir(), 'plune-oauth-token-'));
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
const creds = (reg: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  configFile({
    auth: 'client-credentials',
    registration: {
      method: 'preregistered',
      clientId: CLIENT_ID,
      clientSecretEnv: SECRET_ENV,
      ...reg,
    },
    ...extra,
  });

const ID = 'oauth-e2e-token-works';

async function run(url: string, flags: Partial<McpConformanceFlags> = {}, only = true) {
  let out = '';
  let err = '';
  const code = await handleMcpConformance(
    {
      timeout: '10s',
      format: 'json',
      suite: ['oauth'],
      protocolVersion: '2026-07-28',
      url,
      ...(only ? { check: [ID] } : {}),
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
    report: out.startsWith('{') ? (JSON.parse(out) as McpConformanceReport) : undefined,
  };
}

const verdict = (r: McpConformanceReport | undefined) => {
  const c = r!.checks.find((x) => x.id === ID)!;
  return c.reason === undefined ? c.state : `${c.state} (${c.reason})`;
};
const actual = (r: McpConformanceReport | undefined) => r!.checks.find((x) => x.id === ID)!.actual;

const tokens = (s: AuthFixture) => s.seen.filter((x) => x.path === '/token');
const bearer = (s: AuthFixture) =>
  s.seen.filter((x) => x.path === '/mcp' && x.authorization?.startsWith('Bearer '));
const windows = (value: string, k = 8): string[] =>
  Array.from({ length: value.length - k + 1 }, (_, i) => value.slice(i, i + k));
const TOKEN = 'at-1-7c1d9e5b3f2a8064';

describe('CLI · mcp conformance · oauth token · catalog', () => {
  it('the check is catalogued as MUST, derived, with its derivation, and outside the profile', () => {
    const e = CATALOG.find((x) => x.id === ID);
    expect(e).toBeDefined();
    expect(e!.suite).toBe('oauth');
    expect(e!.level).toBe('MUST');
    expect(e!.derived).toBe(true);
    expect(e!.derivation).toBeTruthy();
    expect(e!.specRefs.length).toBeGreaterThan(0);
    expect(PROFILE.checks).not.toContain(ID);
  });
});

describe('CLI · mcp conformance · oauth token · a token the server issued for itself', () => {
  it('is accepted: passed, with one token request and one request that carries the token', async () => {
    const s = await serve({});
    const { report } = await run(s.url, { config: creds() });
    expect(verdict(report)).toBe('passed');
    expect(actual(report)).toMatch(/not revoked/);
    // The request without a token (the first probe of the suite) and the one with the token.
    expect(tokens(s)).toHaveLength(1);
    expect(bearer(s)).toHaveLength(1);
    expect(s.seen.filter((x) => x.path === '/mcp')).toHaveLength(2);
    // The token is asked for the resource of the server.
    expect(new URLSearchParams(tokens(s)[0]!.body).get('resource')).toBe(s.url);
  });

  it('refused by the server that issued it: failed', async () => {
    const s = await serve({ force: { 'mcp:own': 401 } });
    const { report } = await run(s.url, { config: creds() });
    expect(verdict(report)).toBe('failed');
    expect(actual(report)).toContain('401');
    expect(tokens(s)).toHaveLength(1);
    expect(bearer(s)).toHaveLength(1);
  });

  const unjudged: [string, AuthOpts, string][] = [
    ['403', { force: { 'mcp:own': 403 } }, 'could-not-run (prerequisite-failed)'],
    ['400', { force: { 'mcp:own': 400 } }, 'could-not-run (prerequisite-failed)'],
    ['429', { force: { 'mcp:own': 429 } }, 'could-not-run (transport-error)'],
    ['503', { force: { 'mcp:own': 503 } }, 'could-not-run (transport-error)'],
    [
      '429 at the token endpoint',
      { force: { 'token:own': 429 } },
      'could-not-run (transport-error)',
    ],
    [
      '503 at the token endpoint',
      { force: { 'token:own': 503 } },
      'could-not-run (transport-error)',
    ],
    [
      'a dropped connection at the token endpoint',
      { force: { 'token:own': 'drop' } },
      'could-not-run (transport-error)',
    ],
    [
      'a dropped connection at the MCP endpoint',
      { force: { 'mcp:own': 'drop' } },
      'could-not-run (transport-error)',
    ],
  ];
  for (const [name, opts, expected] of unjudged)
    it(`${name}: ${expected}`, async () => {
      const s = await serve(opts);
      const { report } = await run(s.url, { config: creds() });
      expect(verdict(report)).toBe(expected);
      expect(tokens(s)).toHaveLength(1);
      expect(bearer(s).length).toBeLessThanOrEqual(1);
    });

  for (const [name, force] of [
    ['the token endpoint', 'token:own'],
    ['the MCP endpoint', 'mcp:own'],
  ] as const)
    it(`no answer from ${name} before the timeout: could-not-run`, async () => {
      const s = await serve({ force: { [force]: 'hang' } });
      const { report } = await run(s.url, { config: creds(), timeout: '1s' });
      expect(verdict(report)).toMatch(/^could-not-run \((transport-error|timeout)\)$/);
    });

  it('the token endpoint refuses the client: could-not-run (prerequisite-failed), one token request', async () => {
    const s = await serve({});
    const { report } = await run(s.url, { config: creds({ clientId: 'no-such-client' }) });
    expect(verdict(report)).toBe('could-not-run (prerequisite-failed)');
    expect(tokens(s)).toHaveLength(1);
    expect(bearer(s)).toHaveLength(0);
  });

  it('a public server: not-applicable (no-auth), and no token is asked for', async () => {
    const s = await serve({ public: true });
    const { report } = await run(s.url, { config: creds() });
    expect(verdict(report)).toBe('not-applicable (no-auth)');
    expect(tokens(s)).toHaveLength(0);
  });
});

describe('CLI · mcp conformance · oauth token · what --config does not give', () => {
  const noRequests = (s: AuthFixture) => {
    expect(tokens(s)).toHaveLength(0);
    expect(bearer(s)).toHaveLength(0);
  };
  it('a grant other than client-credentials: could-not-run (needs-input), and nothing is sent', async () => {
    const s = await serve({});
    const bare = configFile({
      registration: { method: 'preregistered', clientId: CLIENT_ID, clientSecretEnv: SECRET_ENV },
    });
    const { report } = await run(s.url, { config: bare });
    expect(verdict(report)).toBe('could-not-run (needs-input)');
    noRequests(s);
  });

  it('a secret variable that is not set: could-not-run (needs-input), and nothing is sent', async () => {
    const s = await serve({});
    const { report } = await run(s.url, {
      config: creds({ clientSecretEnv: 'PLUNE_TEST_NOT_SET_ANYWHERE' }),
    });
    expect(verdict(report)).toBe('could-not-run (needs-input)');
    noRequests(s);
  });

  it('a token endpoint on an origin that was not named: could-not-run (needs-input); neither secret nor token goes there', async () => {
    const other = await serve({});
    const s = await serve({ as: { tokenEndpoint: `${other.origin}/token` } });
    const { report } = await run(s.url, { config: creds() });
    expect(verdict(report)).toBe('could-not-run (needs-input)');
    expect(other.seen).toEqual([]);
    noRequests(s);
  });

  it('a token endpoint that redirects to another origin that was named: the redirect is not followed', async () => {
    const other = await serve({});
    const s = await serve({ force: { 'token:own': `${other.origin}/token` } });
    const { report } = await run(s.url, { config: creds(), allowOrigin: [s.origin, other.origin] });
    expect(verdict(report)).toBe('could-not-run (transport-error)');
    expect(other.seen).toEqual([]);
  });

  it('an MCP endpoint that redirects the request with the token: not followed, the token goes nowhere else', async () => {
    const other = await serve({});
    const s = await serve({ force: { 'mcp:own': `${other.origin}/mcp` } });
    const { report } = await run(s.url, { config: creds(), allowOrigin: [s.origin, other.origin] });
    expect(verdict(report)).toBe('could-not-run (transport-error)');
    expect(other.seen).toEqual([]);
  });
});

describe('CLI · mcp conformance · oauth token · nothing issued is printed', () => {
  for (const format of ['json', 'human'] as const)
    it(`the token and the client secret are not in the ${format} output; the secret went only to the token endpoint`, async () => {
      const s = await serve({});
      const { out, err } = await run(s.url, { config: creds(), format });
      const all = out + err;
      expect(all.length).toBeGreaterThan(0);
      for (const w of windows(TOKEN)) expect(all).not.toContain(w);
      expect(all).not.toContain(CLIENT_SECRET);
      expect(
        s.seen.filter((x) => x.authorization?.startsWith('Basic ')).map((x) => x.path),
      ).toEqual(['/token']);
      expect(bearer(s).every((x) => x.path === '/mcp')).toBe(true);
    });

  it('the same in a run of the whole suite', async () => {
    const s = await serve({});
    const { out, err, code, report } = await run(s.url, { config: creds(), format: 'json' }, false);
    for (const w of windows(TOKEN)) expect(out + err).not.toContain(w);
    expect(out + err).not.toContain(CLIENT_SECRET);
    expect(code).toBe(3);
    expect(report?.summary.pending).toContain(ID);
  });
});
