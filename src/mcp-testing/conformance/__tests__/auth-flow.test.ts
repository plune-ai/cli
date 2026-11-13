// The checks that need an authorization code, run without a person: the authorization endpoint of a test environment
// that does not ask for a sign-in answers with a redirect that carries a code. Where it shows a sign-in instead, the
// checks are could-not-run (needs-input). Against the loopback servers of auth-fixture.ts.

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
  AUTH_CODE,
  CLIENT_ID,
  CLIENT_SECRET,
  type AuthFixture,
  type AuthOpts,
} from './auth-fixture.js';

const dir = mkdtempSync(join(tmpdir(), 'plune-oauth-flow-'));
const open: AuthFixture[] = [];
afterEach(async () => {
  for (const f of open.splice(0)) await f.close();
});
const serve = async (o: AuthOpts = {}) => {
  const f = await authFixture({ echoState: true, ...o });
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
const headless = (reg: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  configFile({
    auth: 'headless',
    redirectUri: CB,
    registration: {
      method: 'preregistered',
      clientId: CLIENT_ID,
      clientSecretEnv: SECRET_ENV,
      ...reg,
    },
    ...extra,
  });
/** A public client: no secret. */
const publicClient = () =>
  configFile({
    auth: 'headless',
    redirectUri: CB,
    registration: { method: 'preregistered', clientId: CLIENT_ID },
  });

const ISS = 'oauth-authz-response-iss';
const PKCE = 'oauth-neg-pkce-wrong-verifier';
const REDIR = 'oauth-neg-token-redirect-mismatch';

async function run(
  url: string,
  checks: string[],
  flags: Partial<McpConformanceFlags> = {},
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
      ...(checks.length > 0 ? { check: checks } : {}),
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

const verdict = (r: McpConformanceReport | undefined, id: string) => {
  const c = r!.checks.find((x) => x.id === id)!;
  return c.reason === undefined ? c.state : `${c.state} (${c.reason})`;
};
const actual = (r: McpConformanceReport | undefined, id: string) =>
  r!.checks.find((x) => x.id === id)!.actual;
const authorizeAsked = (s: AuthFixture) => s.seen.filter((x) => x.path === '/authorize');
const tokensAsked = (s: AuthFixture) => s.seen.filter((x) => x.path === '/token');
const windows = (value: string, k = 8): string[] =>
  Array.from({ length: value.length - k + 1 }, (_, i) => value.slice(i, i + k));

describe('CLI · mcp conformance · oauth flow · catalog', () => {
  it('the three checks are catalogued with a level, a derivation and a cited section, and are outside the profile', () => {
    for (const id of [ISS, PKCE, REDIR]) {
      const e = CATALOG.find((x) => x.id === id);
      expect(e, id).toBeDefined();
      expect(e!.suite).toBe('oauth');
      expect(['MUST', 'SHOULD']).toContain(e!.level);
      expect(e!.derived).toBe(true);
      expect(e!.derivation).toBeTruthy();
      expect(e!.specRefs.length).toBeGreaterThan(0);
      expect(PROFILE.checks).not.toContain(id);
    }
    expect(CATALOG.find((x) => x.id === ISS)!.eras).toEqual(['modern']);
    expect(CATALOG.find((x) => x.id === ISS)!.derivation).toContain(
      'Authorization servers that include the iss parameter MUST advertise this by setting authorization_response_iss_parameter_supported to true in their metadata',
    );
  });
});

describe('CLI · mcp conformance · oauth flow · iss in the authorization response', () => {
  it('iss equal to the issuer and advertised: passed, from one authorization request, with nothing exchanged', async () => {
    const s = await serve({ authIss: 'correct', as: { iss: true } });
    const { report } = await run(s.url, [ISS], { config: headless() });
    expect(verdict(report, ISS)).toBe('passed');
    expect(authorizeAsked(s)).toHaveLength(1);
    expect(tokensAsked(s)).toHaveLength(0);
    expect(actual(report, ISS)).toMatch(/authorization code was issued and was not used/i);
  });

  const failing: [string, AuthOpts][] = [
    ['an iss that is not the issuer', { authIss: 'wrong', as: { iss: true } }],
    ['an iss that the metadata does not advertise', { authIss: 'correct' }],
    ['no iss, though the metadata advertises it', { as: { iss: true } }],
  ];
  for (const [name, opts] of failing)
    it(`${name}: failed`, async () => {
      const s = await serve(opts);
      const { report } = await run(s.url, [ISS], { config: headless() });
      expect(verdict(report, ISS)).toBe('failed');
    });

  it('no iss and none advertised: not-applicable, there is nothing to compare', async () => {
    const s = await serve({});
    const { report } = await run(s.url, [ISS], { config: headless() });
    expect(verdict(report, ISS)).toBe('not-applicable (not-offered)');
  });

  it('in 2025-11-25 the check is not-applicable (era)', async () => {
    const s = await serve({ authIss: 'correct', as: { iss: true } });
    const { report } = await run(s.url, [ISS], {
      config: headless(),
      protocolVersion: '2025-11-25',
    });
    expect(verdict(report, ISS)).toBe('not-applicable (era)');
  });

  const unjudged: [string, AuthOpts, string][] = [
    ['a sign-in page', { authorize: 'login-all' }, 'could-not-run (needs-input)'],
    [
      'a redirect to the sign-in of the server',
      { authorize: 'redirect-login-all' },
      'could-not-run (needs-input)',
    ],
    ['429', { authorize: 429 }, 'could-not-run (transport-error)'],
    ['503', { authorize: 503 }, 'could-not-run (transport-error)'],
    ['a refusal of the client', { authorize: 'forbidden' }, 'could-not-run (prerequisite-failed)'],
  ];
  for (const [name, opts, expected] of unjudged)
    it(`${name}: ${expected}`, async () => {
      const s = await serve({ ...opts, authIss: 'correct', as: { iss: true } });
      const { report } = await run(s.url, [ISS], { config: headless() });
      expect(verdict(report, ISS)).toBe(expected);
    });

  it('a sign-in says that a signed-in authorization code is needed', async () => {
    const s = await serve({ authorize: 'login-all' });
    const { report } = await run(s.url, [ISS], { config: headless() });
    expect(actual(report, ISS)).toMatch(/needs a signed-in authorization code/);
  });

  it('a state that does not come back as it was sent: could-not-run (prerequisite-failed), not a verdict on iss', async () => {
    const s = await serve({ echoState: false, authIss: 'wrong', as: { iss: true } });
    const { report } = await run(s.url, [ISS], { config: headless() });
    expect(verdict(report, ISS)).toBe('could-not-run (prerequisite-failed)');
    expect(actual(report, ISS)).toMatch(/state/);
  });

  it('without auth headless: could-not-run (needs-input), and no authorization request', async () => {
    const s = await serve({ authIss: 'correct', as: { iss: true } });
    const config = configFile({
      auth: 'client-credentials',
      redirectUri: CB,
      registration: { method: 'preregistered', clientId: CLIENT_ID },
    });
    const { report } = await run(s.url, [ISS], { config });
    expect(verdict(report, ISS)).toBe('could-not-run (needs-input)');
    expect(authorizeAsked(s)).toHaveLength(0);
  });
});

describe('CLI · mcp conformance · oauth flow · the code is exchanged only with a control', () => {
  it('both pass: a control exchange, then a wrong verifier and a wrong redirect_uri, each with a fresh code', async () => {
    const s = await serve({});
    const { report } = await run(s.url, [PKCE, REDIR], { config: headless() });
    expect(verdict(report, PKCE)).toBe('passed');
    expect(verdict(report, REDIR)).toBe('passed');
    // One control (shared by both), then one fresh code for each probe.
    expect(authorizeAsked(s)).toHaveLength(3);
    expect(tokensAsked(s)).toHaveLength(3);
    expect(actual(report, PKCE)).toMatch(/a token was issued and was not revoked/i);
    expect(actual(report, REDIR)).toMatch(/a token was issued and was not revoked/i);
  });

  it('a verifier that is not checked: the wrong-verifier check is failed, and says two tokens were issued', async () => {
    const s = await serve({ codeFault: 'lax-pkce' });
    const { report } = await run(s.url, [PKCE, REDIR], { config: headless() });
    expect(verdict(report, PKCE)).toBe('failed');
    expect(actual(report, PKCE)).toMatch(/two tokens were issued and were not revoked/i);
    expect(verdict(report, REDIR)).toBe('passed');
  });

  it('a redirect_uri that is not compared: the redirect check is failed', async () => {
    const s = await serve({ codeFault: 'lax-redirect' });
    const { report } = await run(s.url, [PKCE, REDIR], { config: headless() });
    expect(verdict(report, REDIR)).toBe('failed');
    expect(verdict(report, PKCE)).toBe('passed');
  });

  it('a bare invalid_grant for the wrong redirect_uri does not show it was compared: could-not-run, not passed', async () => {
    const s = await serve({ codeFault: 'generic-redirect' });
    const { report } = await run(s.url, [PKCE, REDIR], { config: headless() });
    expect(verdict(report, REDIR)).toBe('could-not-run (prerequisite-failed)');
    expect(actual(report, REDIR)).toMatch(/does not say|generic/i);
    expect(verdict(report, PKCE)).toBe('passed');
  });

  it('a sign-in page: both are could-not-run (needs-input), and the token endpoint is not asked', async () => {
    const s = await serve({ authorize: 'login-all' });
    const { report } = await run(s.url, [PKCE, REDIR], { config: headless() });
    expect(verdict(report, PKCE)).toBe('could-not-run (needs-input)');
    expect(verdict(report, REDIR)).toBe('could-not-run (needs-input)');
    expect(tokensAsked(s)).toHaveLength(0);
  });

  it('a control that the token endpoint answers 429: both are could-not-run (transport-error), nothing more is asked', async () => {
    const s = await serve({ force: { 'token:code': 429 } });
    const { report } = await run(s.url, [PKCE, REDIR], { config: headless() });
    expect(verdict(report, PKCE)).toBe('could-not-run (transport-error)');
    expect(verdict(report, REDIR)).toBe('could-not-run (transport-error)');
    expect(authorizeAsked(s)).toHaveLength(1);
    expect(tokensAsked(s)).toHaveLength(1);
  });

  it('a probe that gets 503 after a good control: could-not-run (transport-error), the control token is said to be issued', async () => {
    const s = await serve({ codeFault: 'lax-pkce', force: { 'token:code:2': 503 } });
    const { report } = await run(s.url, [PKCE], { config: headless() });
    expect(verdict(report, PKCE)).toBe('could-not-run (transport-error)');
    expect(actual(report, PKCE)).toMatch(/a token was issued and was not revoked/i);
  });

  it('a redirect probe that gets 503 after a good control: could-not-run (transport-error), not a refusal', async () => {
    const s = await serve({ codeFault: 'lax-redirect', force: { 'token:code:2': 503 } });
    const { report } = await run(s.url, [REDIR], { config: headless() });
    expect(verdict(report, REDIR)).toBe('could-not-run (transport-error)');
    expect(actual(report, REDIR)).toMatch(/a token was issued and was not revoked/i);
  });

  it('a control that the token endpoint refuses (a wrong secret): both are could-not-run (prerequisite-failed), no probe is made', async () => {
    const s = await serve({});
    const { report } = await run(
      s.url,
      [PKCE, REDIR],
      { config: headless() },
      { [SECRET_ENV]: 'not-the-secret-1234' },
    );
    expect(verdict(report, PKCE)).toBe('could-not-run (prerequisite-failed)');
    expect(verdict(report, REDIR)).toBe('could-not-run (prerequisite-failed)');
    expect(tokensAsked(s)).toHaveLength(1);
    expect(authorizeAsked(s)).toHaveLength(1);
  });

  it('a public client: the code goes with the client_id and no Authorization header', async () => {
    const s = await serve({});
    const { report } = await run(s.url, [PKCE, REDIR], { config: publicClient() });
    expect(verdict(report, PKCE)).toBe('passed');
    expect(tokensAsked(s).every((x) => x.authorization === undefined)).toBe(true);
    expect(
      tokensAsked(s).every((x) => new URLSearchParams(x.body).get('client_id') === CLIENT_ID),
    ).toBe(true);
  });

  it('a client with a secret: the secret goes only to the token endpoint, as Basic', async () => {
    const s = await serve({});
    await run(s.url, [PKCE, REDIR], { config: headless() });
    expect(
      s.seen.filter((x) => x.authorization?.startsWith('Basic ')).every((x) => x.path === '/token'),
    ).toBe(true);
    expect(s.seen.filter((x) => x.authorization?.startsWith('Basic '))).toHaveLength(3);
  });

  it('a token endpoint on an origin that was not named: could-not-run (needs-input), no code and no secret goes there', async () => {
    const other = await serve({});
    const s = await serve({ as: { tokenEndpoint: `${other.origin}/token` } });
    const { report } = await run(s.url, [PKCE, REDIR], { config: headless() });
    expect(verdict(report, PKCE)).toBe('could-not-run (needs-input)');
    expect(other.seen).toEqual([]);
  });

  it('without auth headless: could-not-run (needs-input), and no authorization request', async () => {
    const s = await serve({});
    const config = configFile({
      auth: 'client-credentials',
      redirectUri: CB,
      registration: { method: 'preregistered', clientId: CLIENT_ID },
    });
    const { report } = await run(s.url, [PKCE, REDIR], { config });
    expect(verdict(report, PKCE)).toBe('could-not-run (needs-input)');
    expect(authorizeAsked(s)).toHaveLength(0);
  });

  it('a public server: not-applicable (no-auth), and no authorization request', async () => {
    const s = await serve({ public: true });
    const { report } = await run(s.url, [PKCE, REDIR], { config: headless() });
    expect(verdict(report, PKCE)).toBe('not-applicable (no-auth)');
    expect(authorizeAsked(s)).toHaveLength(0);
  });
});

describe('CLI · mcp conformance · oauth flow · nothing issued is printed', () => {
  for (const format of ['json', 'human'] as const)
    it(`the code, the verifier, the tokens and the secret are not in the ${format} output`, async () => {
      const s = await serve({ authIss: 'correct', as: { iss: true } });
      const { out, err } = await run(s.url, [ISS, PKCE, REDIR], { config: headless(), format });
      const all = out + err;
      expect(all.length).toBeGreaterThan(0);
      const verifiers = tokensAsked(s).map(
        (x) => new URLSearchParams(x.body).get('code_verifier') ?? '',
      );
      expect(verifiers.every((v) => v.length > 20)).toBe(true);
      for (const v of verifiers) for (const w of windows(v)) expect(all).not.toContain(w);
      for (const w of windows(AUTH_CODE)) expect(all).not.toContain(w);
      for (const t of ['at-1-7c1d9e5b3f2a8064', 'at-2-7c1d9e5b3f2a8064'])
        for (const w of windows(t)) expect(all).not.toContain(w);
      expect(all).not.toContain(CLIENT_SECRET);
    });

  it('the suite still exits 3, and the new ids are outside the score', async () => {
    const s = await serve({ authIss: 'correct', as: { iss: true } });
    const { code, report } = await run(s.url, [], { config: headless() });
    expect(code).toBe(3);
    for (const id of [ISS, PKCE, REDIR]) expect(report?.summary.pending).toContain(id);
  });
});
