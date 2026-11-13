// A token with a narrower scope than the endpoint needs, from the client-credentials grant: the server answers 403 with
// insufficient_scope. Against the loopback servers of auth-fixture.ts.

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
import { parseOauthConfig } from '../checks/auth-config.js';
import { PROFILE } from '../profile.js';
import {
  authFixture,
  CLIENT_ID,
  CLIENT_SECRET,
  type AuthFixture,
  type AuthOpts,
} from './auth-fixture.js';

const dir = mkdtempSync(join(tmpdir(), 'plune-oauth-scope-'));
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
const FULL = ['mcp:tools', 'mcp:read'];
const NARROW = ['mcp:read'];
const creds = (extra: Record<string, unknown> = {}, reg: Record<string, unknown> = {}) =>
  configFile({
    auth: 'client-credentials',
    scopes: FULL,
    narrowScopes: NARROW,
    registration: {
      method: 'preregistered',
      clientId: CLIENT_ID,
      clientSecretEnv: SECRET_ENV,
      ...reg,
    },
    ...extra,
  });

const ID = 'oauth-neg-insufficient-scope';

async function run(
  url: string,
  flags: Partial<McpConformanceFlags> = {},
  only = true,
  env: Record<string, string> = {},
) {
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
      env: { [SECRET_ENV]: CLIENT_SECRET, ...env },
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
const asked = (s: AuthFixture) => tokens(s).map((x) => new URLSearchParams(x.body).get('scope'));
const windows = (value: string, k = 8): string[] =>
  Array.from({ length: value.length - k + 1 }, (_, i) => value.slice(i, i + k));
const ISSUED = /tokens? (was|were) issued and (was|were) not revoked/i;

describe('CLI · mcp conformance · oauth scope · catalog and --config', () => {
  it('the check is a SHOULD that quotes the specification, derived, with its derivation, outside the profile', () => {
    const e = CATALOG.find((x) => x.id === ID);
    expect(e).toBeDefined();
    expect(e!.suite).toBe('oauth');
    expect(e!.level).toBe('SHOULD');
    expect(e!.derived).toBe(true);
    expect(e!.derivation).toContain(
      'the server SHOULD respond with: HTTP 403 Forbidden status code (per RFC 6750 Section 3.1)',
    );
    expect(e!.specRefs.map((r) => r.revision).sort()).toEqual(['2025-11-25', '2026-07-28']);
    expect(PROFILE.checks).not.toContain(ID);
  });

  it('narrowScopes is a list of non-empty strings with no duplicates that differs from scopes', () => {
    expect(parseOauthConfig('{"scopes":["a","b"],"narrowScopes":["a"]}').narrowScopes).toEqual([
      'a',
    ]);
    expect(parseOauthConfig('{"narrowScopes":["a"]}').narrowScopes).toEqual(['a']);
    for (const bad of [
      '{"narrowScopes":"a"}',
      '{"narrowScopes":[""]}',
      '{"narrowScopes":[1]}',
      '{"narrowScopes":["a","a"]}',
      '{"narrowScopes":[]}',
      '{"scopes":["a","b"],"narrowScopes":["b","a"]}',
      '{"scopes":["a"],"narrowScopes":["a"]}',
    ])
      expect(() => parseOauthConfig(bad), bad).toThrow(/narrowScopes/);
  });
});

describe('CLI · mcp conformance · oauth scope · a narrow token is refused with insufficient_scope', () => {
  it('passed, with the control first: two token requests, two requests with a token, the scopes asked as configured', async () => {
    const s = await serve({ scopeRule: 'require-full' });
    const { report } = await run(s.url, { config: creds() });
    expect(verdict(report)).toBe('passed');
    expect(actual(report)).toMatch(/two tokens were issued and were not revoked/i);
    expect(tokens(s)).toHaveLength(2);
    expect(bearer(s)).toHaveLength(2);
    expect(s.seen.filter((x) => x.path === '/mcp')).toHaveLength(3);
    expect(asked(s)).toEqual([FULL.join(' '), NARROW.join(' ')]);
  });

  it('passed when the token endpoint says what it granted, and that is narrower', async () => {
    const s = await serve({ scopeRule: 'require-full', tokenScope: 'echo' });
    const { report } = await run(s.url, { config: creds() });
    expect(verdict(report)).toBe('passed');
  });

  const answers: [string, AuthOpts][] = [
    ['401', { scopeRule: 'unauthorized' }],
    ['403 with no insufficient_scope', { scopeRule: 'forbidden-plain' }],
  ];
  for (const [name, opts] of answers)
    it(`${name} to the narrow token: failed (a SHOULD that was not followed), with the token sentence`, async () => {
      const s = await serve(opts);
      const { report } = await run(s.url, { config: creds() });
      expect(verdict(report)).toBe('failed');
      expect(actual(report)).toMatch(ISSUED);
      expect(bearer(s)).toHaveLength(2);
    });

  it('a 2xx to the narrow token is not a verdict: could-not-run (prerequisite-failed), the request did not need the wider scope', async () => {
    const s = await serve({});
    const { report } = await run(s.url, { config: creds() });
    expect(verdict(report)).toBe('could-not-run (prerequisite-failed)');
    expect(actual(report)).toMatch(/did not need the wider scope/);
    expect(actual(report)).toMatch(ISSUED);
  });

  const transientAnswers: [string, AuthOpts][] = [
    ['429', { scopeRule: { status: 429 } }],
    ['503', { scopeRule: { status: 503 } }],
    ['a redirect', { scopeRule: { status: 302, location: 'http://127.0.0.1:9/x' } }],
    ['a dropped connection', { scopeRule: 'drop' }],
  ];
  for (const [name, opts] of transientAnswers)
    it(`${name} to the narrow token: could-not-run (transport-error), with the token sentence`, async () => {
      const s = await serve(opts);
      const { report } = await run(s.url, { config: creds() });
      expect(verdict(report)).toBe('could-not-run (transport-error)');
      expect(actual(report)).toMatch(ISSUED);
    });

  it('no answer to the narrow token before the timeout: could-not-run, with the token sentence', async () => {
    const s = await serve({ scopeRule: 'hang' });
    const { report } = await run(s.url, { config: creds(), timeout: '1s' });
    expect(verdict(report)).toMatch(/^could-not-run \((transport-error|timeout)\)$/);
    expect(actual(report)).toMatch(ISSUED);
  });

  it('another 4xx to the narrow token: could-not-run (prerequisite-failed)', async () => {
    const s = await serve({ scopeRule: { status: 400 } });
    const { report } = await run(s.url, { config: creds() });
    expect(verdict(report)).toBe('could-not-run (prerequisite-failed)');
  });
});

describe('CLI · mcp conformance · oauth scope · the control and the narrow token have to exist', () => {
  it('a control that is not accepted: could-not-run (prerequisite-failed), and the narrow token is not asked for', async () => {
    const s = await serve({ force: { 'mcp:own': 403 } });
    const { report } = await run(s.url, { config: creds() });
    expect(verdict(report)).toBe('could-not-run (prerequisite-failed)');
    expect(tokens(s)).toHaveLength(1);
    expect(bearer(s)).toHaveLength(1);
    expect(actual(report)).toMatch(ISSUED);
  });

  it('a control that gets 429: could-not-run (transport-error), one token request', async () => {
    const s = await serve({ force: { 'mcp:own': 429 } });
    const { report } = await run(s.url, { config: creds() });
    expect(verdict(report)).toBe('could-not-run (transport-error)');
    expect(tokens(s)).toHaveLength(1);
  });

  it('a token endpoint that does not narrow the scope: could-not-run (prerequisite-failed), and the narrow token is not sent', async () => {
    const s = await serve({ scopeRule: 'require-full', tokenScope: 'full' });
    const { report } = await run(s.url, { config: creds() });
    expect(verdict(report)).toBe('could-not-run (prerequisite-failed)');
    expect(actual(report)).toMatch(/did not issue a narrower token/);
    expect(tokens(s)).toHaveLength(2);
    expect(bearer(s)).toHaveLength(1);
    expect(actual(report)).toMatch(ISSUED);
  });

  it('a token endpoint that refuses the narrow request: could-not-run (prerequisite-failed), and nothing more is sent', async () => {
    const s = await serve({ scopeRule: 'require-full', tokenScope: 'refuse-narrow' });
    const { report } = await run(s.url, { config: creds() });
    expect(verdict(report)).toBe('could-not-run (prerequisite-failed)');
    expect(actual(report)).toMatch(/did not issue a narrower token/);
    expect(tokens(s)).toHaveLength(2);
    expect(bearer(s)).toHaveLength(1);
  });

  it('a token endpoint that drops the narrow request: could-not-run (transport-error), and the first token is said to be issued', async () => {
    const s = await serve({ scopeRule: 'require-full', tokenScope: 'drop-narrow' });
    const { report } = await run(s.url, { config: creds() });
    expect(verdict(report)).toBe('could-not-run (transport-error)');
    expect(actual(report)).toMatch(/a token was issued and was not revoked/i);
    expect(tokens(s)).toHaveLength(2);
    expect(bearer(s)).toHaveLength(1);
  });

  it('a token endpoint with a 429 for the control: could-not-run (transport-error), one token request', async () => {
    const s = await serve({ force: { 'token:own': 429 } });
    const { report } = await run(s.url, { config: creds() });
    expect(verdict(report)).toBe('could-not-run (transport-error)');
    expect(tokens(s)).toHaveLength(1);
    expect(bearer(s)).toHaveLength(0);
  });

  it('a token type that is not Bearer: could-not-run (prerequisite-failed), and no token is sent', async () => {
    const s = await serve({ tokenResponse: 'dpop' });
    const { report } = await run(s.url, { config: creds() });
    expect(verdict(report)).toBe('could-not-run (prerequisite-failed)');
    expect(actual(report)).toMatch(/token type/);
    expect(bearer(s)).toHaveLength(0);
    expect(tokens(s)).toHaveLength(1);
  });

  it('a public server: not-applicable (no-auth), and no token is asked for', async () => {
    const s = await serve({ public: true });
    const { report } = await run(s.url, { config: creds() });
    expect(verdict(report)).toBe('not-applicable (no-auth)');
    expect(tokens(s)).toHaveLength(0);
  });
});

describe('CLI · mcp conformance · oauth scope · what --config does not give', () => {
  const nothingSent = (s: AuthFixture) => {
    expect(tokens(s)).toHaveLength(0);
    expect(bearer(s)).toHaveLength(0);
  };
  it('no narrowScopes: could-not-run (needs-input), nothing is sent', async () => {
    const s = await serve({ scopeRule: 'require-full' });
    const config = configFile({
      auth: 'client-credentials',
      scopes: FULL,
      registration: { method: 'preregistered', clientId: CLIENT_ID, clientSecretEnv: SECRET_ENV },
    });
    const { report } = await run(s.url, { config });
    expect(verdict(report)).toBe('could-not-run (needs-input)');
    expect(actual(report)).toMatch(/narrowScopes/);
    nothingSent(s);
  });

  it('a grant other than client-credentials: could-not-run (needs-input), nothing is sent', async () => {
    const s = await serve({ scopeRule: 'require-full' });
    const { report } = await run(s.url, { config: creds({ auth: 'headless' }) });
    expect(verdict(report)).toBe('could-not-run (needs-input)');
    nothingSent(s);
  });

  it('a secret variable that is empty: could-not-run (needs-input), nothing is sent', async () => {
    const s = await serve({ scopeRule: 'require-full' });
    const { report } = await run(
      s.url,
      { config: creds({}, { clientSecretEnv: 'PLUNE_TEST_EMPTY_SECRET' }) },
      true,
      { PLUNE_TEST_EMPTY_SECRET: '' },
    );
    expect(verdict(report)).toBe('could-not-run (needs-input)');
    nothingSent(s);
  });

  it('a token endpoint on an origin that was not named: could-not-run (needs-input), nothing reaches it', async () => {
    const other = await serve({});
    const s = await serve({ as: { tokenEndpoint: `${other.origin}/token` } });
    const { report } = await run(s.url, { config: creds() });
    expect(verdict(report)).toBe('could-not-run (needs-input)');
    expect(other.seen).toEqual([]);
    nothingSent(s);
  });
});

describe('CLI · mcp conformance · oauth scope · nothing issued is printed', () => {
  for (const format of ['json', 'human'] as const)
    it(`neither token and not the client secret is in the ${format} output; the secret went only to the token endpoint`, async () => {
      const s = await serve({ scopeRule: 'require-full' });
      const { out, err } = await run(s.url, { config: creds(), format });
      const all = out + err;
      expect(all.length).toBeGreaterThan(0);
      for (const t of ['at-1-7c1d9e5b3f2a8064', 'at-2-7c1d9e5b3f2a8064'])
        for (const w of windows(t)) expect(all).not.toContain(w);
      expect(all).not.toContain(CLIENT_SECRET);
      expect(
        s.seen.filter((x) => x.authorization?.startsWith('Basic ')).map((x) => x.path),
      ).toEqual(['/token', '/token']);
    });

  it('the suite still exits 3, with the id shown among the advisories and counted for nothing', async () => {
    const s = await serve({ scopeRule: 'require-full' });
    const { code, report } = await run(s.url, { config: creds() }, false);
    expect(code).toBe(3);
    expect(verdict(report)).toBe('passed');
    // A SHOULD is advice: it counts for nothing in the score, whatever its verdict.
    expect(report?.summary.advisories).toContain(ID);
    expect(report?.summary.passed).not.toContain(ID);
  });
});
