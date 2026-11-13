// The registration and token checks of the oauth suite: a pre-registered client at the authorization endpoint, a client
// made by dynamic registration (and removed again), a redirect the server must refuse, a client_id that is a URL, and the
// shape of the token response. Against the loopback servers of auth-fixture.ts.

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
  DCR_SECRET,
  REG_TOKEN,
  type AuthFixture,
  type AuthOpts,
} from './auth-fixture.js';

const dir = mkdtempSync(join(tmpdir(), 'plune-oauth-reg-'));
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
const prereg = (extra: Record<string, unknown> = {}, reg: Record<string, unknown> = {}) =>
  configFile({
    auth: 'client-credentials',
    redirectUri: CB,
    scopes: ['mcp:tools'],
    registration: {
      method: 'preregistered',
      clientId: CLIENT_ID,
      clientSecretEnv: SECRET_ENV,
      ...reg,
    },
    ...extra,
  });
const dcr = (allow = true, extra: Record<string, unknown> = {}) =>
  configFile({
    redirectUri: CB,
    registration: { method: 'dcr', ...(allow ? { allowClientCreation: true } : {}) },
    ...extra,
  });
const cimd = (reg: Record<string, unknown>) =>
  configFile({ redirectUri: CB, registration: { method: 'cimd', ...reg } });

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

const IDS = [
  'oauth-reg-prereg',
  'oauth-reg-dcr',
  'oauth-reg-dcr-http-redirect-rejected',
  'oauth-reg-cimd',
  'oauth-token-format',
];

describe('CLI · mcp conformance · oauth registration · catalog', () => {
  it('the five checks are catalogued with a level no higher than the text they cite, and are outside the profile', () => {
    for (const id of IDS) {
      const e = CATALOG.find((x) => x.id === id);
      expect(e, id).toBeDefined();
      expect(e!.suite).toBe('oauth');
      expect(e!.specRefs.length, id).toBeGreaterThan(0);
      if (e!.derived) expect(e!.derivation, id).toBeTruthy();
      expect(PROFILE.checks).not.toContain(id);
    }
    expect(CATALOG.find((x) => x.id === 'oauth-reg-dcr')!.level).toBe('MAY');
    // The text says "SHOULD support static client credentials" of the client: the level of a check of the server is not higher.
    expect(CATALOG.find((x) => x.id === 'oauth-reg-prereg')!.level).toBe('SHOULD');
  });
});

describe('CLI · mcp conformance · oauth registration · a pre-registered client', () => {
  it('is accepted at the authorization endpoint: passed, and only the client_id is sent', async () => {
    const s = await serve({});
    const { report } = await run(s.url, { config: prereg() });
    expect(verdict(report, 'oauth-reg-prereg')).toBe('passed');
    const asked = s.seen.filter((x) => x.path === '/authorize');
    // The client asked for, and a made-up one as the control (the probes of auth-probes.ts ask too).
    expect(asked.filter((x) => x.query.includes('no-such-client'))).toHaveLength(1);
    expect(asked.some((x) => x.query.includes('client_id=plune-test-client'))).toBe(true);
    expect(asked.every((x) => x.authorization === undefined)).toBe(true);
  });

  it('a client the server does not know is failed', async () => {
    const s = await serve({});
    const { report } = await run(s.url, { config: prereg({}, { clientId: 'no-such-client' }) });
    expect(verdict(report, 'oauth-reg-prereg')).toBe('failed');
  });

  const cases: [string, AuthOpts, string][] = [
    [
      'a sign-in page cannot be told from an error page',
      { authorize: 'login-all' },
      'could-not-run (needs-input)',
    ],
    [
      'a redirect with another error (access_denied) says nothing of the client',
      { authorize: 'error-redirect' },
      'could-not-run (prerequisite-failed)',
    ],
    ['503', { authorize: 503 }, 'could-not-run (transport-error)'],
    ['429', { authorize: 429 }, 'could-not-run (transport-error)'],
  ];
  for (const [name, opts, expected] of cases)
    it(`${name}: ${expected}`, async () => {
      const s = await serve(opts);
      const { report } = await run(s.url, { config: prereg() });
      expect(verdict(report, 'oauth-reg-prereg')).toBe(expected);
    });

  it('needs a redirectUri and the preregistered method: could-not-run, or not-applicable for another method', async () => {
    const s = await serve({});
    const noUri = await run(s.url, { config: prereg({ redirectUri: undefined }) });
    expect(verdict(noUri.report, 'oauth-reg-prereg')).toBe('could-not-run (needs-input)');
    const other = await run(s.url, { config: dcr() });
    expect(verdict(other.report, 'oauth-reg-prereg')).toBe('not-applicable (not-offered)');
    const none = await run(s.url, {});
    expect(verdict(none.report, 'oauth-reg-prereg')).toBe('could-not-run (needs-input)');
  });
});

describe('CLI · mcp conformance · oauth registration · dynamic registration', () => {
  it('without the permission in --config nothing is registered: could-not-run (needs-input), no POST', async () => {
    const s = await serve({ as: { registration: true } });
    const { report } = await run(s.url, { config: dcr(false) });
    expect(verdict(report, 'oauth-reg-dcr')).toBe('could-not-run (needs-input)');
    expect(verdict(report, 'oauth-reg-dcr-http-redirect-rejected')).toBe(
      'could-not-run (needs-input)',
    );
    expect(actual(report, 'oauth-reg-dcr')).toContain('allowClientCreation');
    expect(s.seen.filter((x) => x.path === '/register')).toEqual([]);
    expect(s.registered).toEqual([]);
  });

  it('with the permission a client is made with a correct body, and removed again (RFC 7592)', async () => {
    const s = await serve({ as: { registration: true } });
    const { report } = await run(s.url, { config: dcr() });
    expect(verdict(report, 'oauth-reg-dcr')).toBe('passed');
    const post = s.seen.find((x) => x.path === '/register' && x.method === 'POST')!;
    const body = JSON.parse(post.body) as Record<string, unknown>;
    expect(body['application_type']).toBe('native');
    expect(body['redirect_uris']).toEqual([CB]);
    expect(body['token_endpoint_auth_method']).toBe('none');
    expect(s.deleted).toEqual(s.registered);
    expect(actual(report, 'oauth-reg-dcr')).toContain('removed');
  });

  it('a server that does not support DELETE keeps the client, and the report says so with its client_id', async () => {
    const s = await serve({ as: { registration: true }, dcr: { remove: '405' } });
    const { report } = await run(s.url, { config: dcr() });
    expect(verdict(report, 'oauth-reg-dcr')).toBe('passed');
    expect(s.deleted).toEqual([]);
    expect(actual(report, 'oauth-reg-dcr')).toContain('remains');
    expect(actual(report, 'oauth-reg-dcr')).toContain(s.registered[0]);
    const del = report!.checks
      .find((c) => c.id === 'oauth-reg-dcr')!
      .details!.find((d) => d.request.method === 'DELETE');
    expect(del?.response?.status).toBe(405);
  });

  it('a server that returns no registration_client_uri keeps the client: no DELETE is sent, and the report says so', async () => {
    const s = await serve({ as: { registration: true }, dcr: { remove: 'none' } });
    const { report } = await run(s.url, { config: dcr() });
    expect(s.seen.filter((x) => x.method === 'DELETE')).toEqual([]);
    expect(actual(report, 'oauth-reg-dcr')).toContain('remains');
    expect(actual(report, 'oauth-reg-dcr')).toContain(s.registered[0]);
  });

  it('a server with no registration_endpoint is not-applicable (not-offered)', async () => {
    const s = await serve({});
    const { report } = await run(s.url, { config: dcr() });
    expect(verdict(report, 'oauth-reg-dcr')).toBe('not-applicable (not-offered)');
    expect(verdict(report, 'oauth-reg-dcr-http-redirect-rejected')).toBe(
      'not-applicable (not-offered)',
    );
  });

  const answers: [string, AuthOpts['dcr'], string][] = [
    ['400 to a correct body', { mode: 'reject-all' }, 'failed'],
    ['a 201 without client_id', { mode: 'no-client-id' }, 'failed'],
    [
      '401: registration needs a credential this run has not',
      { mode: 'auth-required' },
      'could-not-run (needs-input)',
    ],
    ['503', { mode: 'error' }, 'could-not-run (transport-error)'],
  ];
  for (const [name, d, expected] of answers)
    it(`${name}: ${expected}`, async () => {
      const s = await serve({ as: { registration: true }, dcr: d });
      const { report } = await run(s.url, { config: dcr() });
      expect(verdict(report, 'oauth-reg-dcr')).toBe(expected);
    });

  it('a registration endpoint on an origin not named, or on http outside loopback, gets no request', async () => {
    const foreign = await serve({});
    const s = await serve({ as: { registration: `${foreign.origin}/register` } });
    const a = await run(s.url, { config: dcr() });
    expect(verdict(a.report, 'oauth-reg-dcr')).toBe('could-not-run (needs-input)');
    expect(actual(a.report, 'oauth-reg-dcr')).toContain('--allow-origin');
    expect(foreign.seen.filter((x) => x.path === '/register')).toEqual([]);
    const t = await serve({ as: { registration: 'http://203.0.113.7/register' } });
    const b = await run(t.url, { config: dcr(), allowOrigin: [t.origin, 'http://203.0.113.7'] });
    expect(verdict(b.report, 'oauth-reg-dcr')).toBe('could-not-run (needs-input)');
    expect(actual(b.report, 'oauth-reg-dcr')).toContain('https');
  });

  it('what the server issued (client_secret, registration_access_token) is in no output', async () => {
    const s = await serve({ as: { registration: true }, dcr: { secret: true } });
    const json = join(dir, 'reg.json');
    const xml = join(dir, 'reg.xml');
    const { out, err } = await run(s.url, {
      config: dcr(),
      out: [`json=${json}`, `junit-xml=${xml}`],
    });
    const all = [out, err, readFileSync(json, 'utf8'), readFileSync(xml, 'utf8')].join('\n');
    expect(all).toContain('DELETE');
    expect(all).not.toContain(DCR_SECRET);
    expect(all).not.toMatch(REG_TOKEN);
  });
});

describe('CLI · mcp conformance · oauth registration · a redirect over http outside loopback', () => {
  it('a server that refuses it passes, with a registration that works as the control', async () => {
    const s = await serve({ as: { registration: true } });
    const { report } = await run(s.url, { config: dcr() });
    expect(verdict(report, 'oauth-reg-dcr-http-redirect-rejected')).toBe('passed');
    const bodies = s.seen
      .filter((x) => x.path === '/register' && x.method === 'POST')
      .map((x) => x.body);
    expect(bodies.some((x) => x.includes('http://plune-conformance.invalid'))).toBe(true);
  });

  it('a server that accepts it is failed, and the client it made is removed', async () => {
    const s = await serve({ as: { registration: true }, dcr: { mode: 'accept-http' } });
    const { report } = await run(s.url, { config: dcr() });
    expect(verdict(report, 'oauth-reg-dcr-http-redirect-rejected')).toBe('failed');
    expect(s.registered.length).toBe(2);
    expect(s.deleted).toEqual(s.registered);
  });

  it('a server that accepts it and cannot delete is failed, and the report names the client that remains', async () => {
    const s = await serve({
      as: { registration: true },
      dcr: { mode: 'accept-http', remove: '405' },
    });
    const { report } = await run(s.url, { config: dcr() });
    expect(verdict(report, 'oauth-reg-dcr-http-redirect-rejected')).toBe('failed');
    const said = actual(report, 'oauth-reg-dcr-http-redirect-rejected');
    expect(said).toContain('remains');
    for (const id of s.registered) expect(said).toContain(id);
  });

  it('a server that refuses every registration proves nothing: could-not-run, not passed', async () => {
    const s = await serve({ as: { registration: true }, dcr: { mode: 'reject-all' } });
    const { report } = await run(s.url, { config: dcr() });
    expect(verdict(report, 'oauth-reg-dcr-http-redirect-rejected')).toBe(
      'could-not-run (prerequisite-failed)',
    );
  });
});

describe('CLI · mcp conformance · oauth registration · a client_id that is a URL', () => {
  const good = 'https://client.example/good.json';
  const bad = 'https://client.example/mismatch.json';

  it('a server that takes the document and refuses one whose client_id does not match passes', async () => {
    const s = await serve({ as: { cimd: true } });
    const { report } = await run(s.url, {
      config: cimd({ clientIdMetadataUrl: good, clientIdMetadataMismatchUrl: bad }),
    });
    expect(verdict(report, 'oauth-reg-cimd')).toBe('passed');
    expect(s.seen.filter((x) => x.path === '/authorize')).toHaveLength(2);
  });

  it('a server that takes the mismatched document too is failed', async () => {
    const s = await serve({ as: { cimd: true }, cimdMismatch: 'accept' });
    const { report } = await run(s.url, {
      config: cimd({ clientIdMetadataUrl: good, clientIdMetadataMismatchUrl: bad }),
    });
    expect(verdict(report, 'oauth-reg-cimd')).toBe('failed');
  });

  it('a server that refuses the good document is failed', async () => {
    const s = await serve({ as: { cimd: true } });
    const { report } = await run(s.url, {
      config: cimd({ clientIdMetadataUrl: bad, clientIdMetadataMismatchUrl: bad }),
    });
    expect(verdict(report, 'oauth-reg-cimd')).toBe('failed');
  });

  it('without a document that does not match, the half that was seen is said, and the check is could-not-run (needs-input)', async () => {
    const s = await serve({ as: { cimd: true } });
    const { report } = await run(s.url, { config: cimd({ clientIdMetadataUrl: good }) });
    expect(verdict(report, 'oauth-reg-cimd')).toBe('could-not-run (needs-input)');
    expect(actual(report, 'oauth-reg-cimd')).toContain('accepted');
  });

  it('without a document URL: needs-input; without the advertisement: not-applicable (not-offered)', async () => {
    const s = await serve({ as: { cimd: true } });
    const none = await run(s.url, { config: cimd({}) });
    expect(verdict(none.report, 'oauth-reg-cimd')).toBe('could-not-run (needs-input)');
    const t = await serve({});
    const off = await run(t.url, { config: cimd({ clientIdMetadataUrl: good }) });
    expect(verdict(off.report, 'oauth-reg-cimd')).toBe('not-applicable (not-offered)');
  });

  it('a sign-in page after the good document cannot be told from an error page: needs-input', async () => {
    const s = await serve({ as: { cimd: true }, authorize: 'login' });
    const { report } = await run(s.url, {
      config: cimd({ clientIdMetadataUrl: good, clientIdMetadataMismatchUrl: bad }),
    });
    expect(verdict(report, 'oauth-reg-cimd')).toBe('could-not-run (needs-input)');
  });
});

describe('CLI · mcp conformance · oauth registration · the token response', () => {
  const cases: [string, AuthOpts, string][] = [
    ['access_token, token_type Bearer and expires_in', {}, 'passed'],
    [
      'token_type in lower case (the value is case insensitive)',
      { tokenResponse: 'bearer-lower' },
      'passed',
    ],
    ['no expires_in is still passed, and says it', { tokenResponse: 'no-expires' }, 'passed'],
    ['no token_type', { tokenResponse: 'no-type' }, 'failed'],
    ['token_type mac', { tokenResponse: 'mac' }, 'failed'],
    ['no access_token', { tokenResponse: 'no-token' }, 'failed'],
    [
      '503 from the token endpoint',
      { force: { 'token:own': 503 } },
      'could-not-run (transport-error)',
    ],
    [
      '429 from the token endpoint',
      { force: { 'token:own': 429 } },
      'could-not-run (transport-error)',
    ],
  ];
  for (const [name, opts, expected] of cases)
    it(`${name}: ${expected}`, async () => {
      const s = await serve(opts);
      const { report } = await run(s.url, { config: prereg() });
      expect(verdict(report, 'oauth-token-format')).toBe(expected);
    });

  it('a response without expires_in says it in actual; the token is in no output', async () => {
    const s = await serve({ tokenResponse: 'no-expires' });
    const { report, out, err } = await run(s.url, { config: prereg() });
    expect(actual(report, 'oauth-token-format')).toContain('expires_in');
    expect(out + err).not.toMatch(/at-\d+-7c1d9e5b3f2a8064/);
    expect(out + err).not.toContain(CLIENT_SECRET);
  });

  it('without credentials in --config: could-not-run (needs-input), and no token is asked for', async () => {
    const s = await serve({});
    const { report } = await run(s.url, { config: dcr() });
    expect(verdict(report, 'oauth-token-format')).toBe('could-not-run (needs-input)');
    expect(s.seen.filter((x) => x.path === '/token')).toEqual([]);
  });
});

describe('CLI · mcp conformance · oauth registration · the new keys of --config', () => {
  it('allowClientCreation is a boolean, off by default; a client_id URL is https with a path', () => {
    expect(
      parseOauthConfig('{"registration":{"method":"dcr"}}').registration?.allowClientCreation,
    ).toBeUndefined();
    expect(
      parseOauthConfig('{"registration":{"method":"dcr","allowClientCreation":true}}').registration
        ?.allowClientCreation,
    ).toBe(true);
    expect(() =>
      parseOauthConfig('{"registration":{"method":"dcr","allowClientCreation":"yes"}}'),
    ).toThrow(/true or false/);
    for (const u of ['http://c.example/a.json', 'https://c.example/', 'not a url'])
      expect(() =>
        parseOauthConfig(
          JSON.stringify({ registration: { method: 'cimd', clientIdMetadataUrl: u } }),
        ),
      ).toThrow(/https URL with a path/);
  });
});

const MAY = 'may have been created and could not be named';
const run1s = (url: string, flags: Partial<McpConformanceFlags> = {}) =>
  run(url, { timeout: '1s', ...flags });

describe('CLI · mcp conformance · oauth registration · a client that may exist without a trace', () => {
  it('a POST that gets no answer (the client was made): could-not-run (timeout), and the report says so', async () => {
    const s = await serve({ as: { registration: true }, dcr: { mode: 'timeout-after-write' } });
    const { report } = await run1s(s.url, { config: dcr() });
    expect(verdict(report, 'oauth-reg-dcr')).toBe('could-not-run (timeout)');
    expect(actual(report, 'oauth-reg-dcr')).toContain(MAY);
    expect(actual(report, 'oauth-reg-dcr-http-redirect-rejected')).toContain(MAY);
    expect(s.registered).toHaveLength(1);
  });

  it('a 502 after the write: could-not-run (transport-error), and the report says so', async () => {
    const s = await serve({ as: { registration: true }, dcr: { mode: 'bad-gateway-after-write' } });
    const { report } = await run(s.url, { config: dcr() });
    expect(verdict(report, 'oauth-reg-dcr')).toBe('could-not-run (transport-error)');
    expect(actual(report, 'oauth-reg-dcr')).toContain(MAY);
    expect(s.registered).toHaveLength(1);
  });

  it('a 201 larger than a reader takes is not failed: could-not-run, and the report says so', async () => {
    const s = await serve({ as: { registration: true }, dcr: { mode: 'big' } });
    const { report } = await run(s.url, { config: dcr() });
    expect(verdict(report, 'oauth-reg-dcr')).toBe('could-not-run (transport-error)');
    expect(actual(report, 'oauth-reg-dcr')).toContain(MAY);
  });

  it('a 201 without client_id and without the means to delete: failed, and the report says so', async () => {
    const s = await serve({ as: { registration: true }, dcr: { mode: 'no-client-id' } });
    const { report } = await run(s.url, { config: dcr() });
    expect(verdict(report, 'oauth-reg-dcr')).toBe('failed');
    expect(actual(report, 'oauth-reg-dcr')).toContain(MAY);
  });

  it('a 201 without client_id but with the means to delete: the client is deleted all the same', async () => {
    const s = await serve({ as: { registration: true }, dcr: { mode: 'no-client-id-deletable' } });
    const { report } = await run(s.url, { config: dcr() });
    expect(verdict(report, 'oauth-reg-dcr')).toBe('failed');
    expect(s.deleted).toEqual(s.registered);
    expect(actual(report, 'oauth-reg-dcr')).toContain('removed');
    expect(actual(report, 'oauth-reg-dcr')).not.toContain(MAY);
  });

  it('a 5xx before the write is still said to be possible: the checker cannot know', async () => {
    const s = await serve({ as: { registration: true }, dcr: { mode: 'error' } });
    const { report } = await run(s.url, { config: dcr() });
    expect(actual(report, 'oauth-reg-dcr')).toContain(MAY);
  });

  it('a 429 made nothing: no such sentence', async () => {
    const s = await serve({ as: { registration: true }, dcr: { mode: 'rate-limit' } });
    const { report } = await run(s.url, { config: dcr() });
    expect(verdict(report, 'oauth-reg-dcr')).toBe('could-not-run (transport-error)');
    expect(actual(report, 'oauth-reg-dcr')).not.toContain(MAY);
  });
});

describe('CLI · mcp conformance · oauth registration · everything the server issued is masked', () => {
  const secrets = [
    /rt-9b2e47c1a8d03f65/,
    /idt-3c7a5e91f2b840d6/,
    /iat-4d8f21b6a09c7e53/,
    /qk-6a31f8c2d95b/,
    REG_TOKEN,
  ];
  const noneIn = (texts: string[]) => {
    const all = texts.join('\n');
    for (const s of secrets) expect(all).not.toMatch(s);
  };
  const outputs = async (s: AuthFixture, config: string, name: string) => {
    const json = join(dir, `${name}.json`);
    const xml = join(dir, `${name}.xml`);
    const r = await run(s.url, { config, out: [`json=${json}`, `junit-xml=${xml}`] });
    return { ...r, files: [readFileSync(json, 'utf8'), readFileSync(xml, 'utf8')] };
  };

  for (const [name, opts] of [
    ['passed', {}],
    ['failed (token_type missing)', { tokenResponse: 'no-type' }],
  ] as [string, AuthOpts][])
    it(`a token response with refresh_token and id_token, ${name}: neither is in any output`, async () => {
      const s = await serve({ ...opts, tokenExtras: true });
      const r = await outputs(s, prereg(), `tok-${name.length}`);
      expect(verdict(r.report, 'oauth-token-format')).toBe(name === 'passed' ? 'passed' : 'failed');
      noneIn([r.out, r.err, ...r.files]);
    });

  for (const [name, mode] of [
    ['passed', 'ok'],
    ['failed', 'accept-http'],
  ] as const)
    it(`a registration with an initial_access_token and a secret in the query of registration_client_uri, ${name}: none is in any output`, async () => {
      const s = await serve({ as: { registration: true }, dcr: { mode, extras: true } });
      const r = await outputs(s, dcr(), `reg-${name}`);
      expect(verdict(r.report, 'oauth-reg-dcr-http-redirect-rejected')).toBe(
        mode === 'ok' ? 'passed' : 'failed',
      );
      noneIn([r.out, r.err, ...r.files]);
    });
});

describe('CLI · mcp conformance · oauth registration · the registration access token goes only to the registration origin', () => {
  it('a registration_client_uri on another allowed origin gets no DELETE; the client is named as left, with the reason', async () => {
    const other = await serve({});
    const s = await serve({ as: { registration: true }, dcr: { uriBase: other.origin } });
    const { report } = await run(s.url, { config: dcr(), allowOrigin: [s.origin, other.origin] });
    expect(verdict(report, 'oauth-reg-dcr')).toBe('passed');
    expect(other.seen.filter((x) => x.method === 'DELETE')).toEqual([]);
    expect(s.deleted).toEqual([]);
    const said = actual(report, 'oauth-reg-dcr');
    expect(said).toContain('remains');
    expect(said).toContain(s.registered[0]);
    expect(said).toContain('another origin');
  });
});

describe('CLI · mcp conformance · oauth registration · what is registered', () => {
  const bodyOf = (s: AuthFixture, n = 0) =>
    JSON.parse(
      s.seen.filter((x) => x.path === '/register' && x.method === 'POST')[n]!.body,
    ) as Record<string, unknown>;

  it('the client is named plune-conformance-test', async () => {
    const s = await serve({ as: { registration: true } });
    await run(s.url, { config: dcr() });
    expect(bodyOf(s)['client_name']).toBe('plune-conformance-test');
  });

  it('a redirectUri that is not loopback is not the control: the default loopback one is, and the result says so', async () => {
    const s = await serve({ as: { registration: true } });
    const { report } = await run(s.url, {
      config: dcr(true, { redirectUri: 'https://app.example/cb' }),
    });
    expect(bodyOf(s)['redirect_uris']).toEqual(['http://127.0.0.1:8765/callback']);
    expect(actual(report, 'oauth-reg-dcr-http-redirect-rejected')).toContain('not a loopback');
    expect(verdict(report, 'oauth-reg-dcr-http-redirect-rejected')).toBe('passed');
  });

  it('a loopback redirectUri is the control as it is', async () => {
    const s = await serve({ as: { registration: true } });
    await run(s.url, { config: dcr(true, { redirectUri: 'http://localhost:9/cb' }) });
    expect(bodyOf(s)['redirect_uris']).toEqual(['http://localhost:9/cb']);
  });

  it('the status in the result is the one the server sent', async () => {
    const s = await serve({ as: { registration: true } });
    const { report } = await run(s.url, { config: dcr() });
    expect(actual(report, 'oauth-reg-dcr')).toContain('HTTP 201');
    const t = await serve({ as: { registration: true }, dcr: { mode: 'accept-http' } });
    const r = await run(t.url, { config: dcr() });
    expect(actual(r.report, 'oauth-reg-dcr-http-redirect-rejected')).toContain('HTTP 201');
  });
});

describe('CLI · mcp conformance · oauth registration · the authorization endpoint, read with a control', () => {
  it('a made-up client is asked for too, and the real one passes only when the made-up one is refused', async () => {
    const s = await serve({});
    const { report } = await run(s.url, { config: prereg() });
    expect(verdict(report, 'oauth-reg-prereg')).toBe('passed');
    const made = s.seen.filter(
      (x) => x.path === '/authorize' && x.query.includes('no-such-client'),
    );
    expect(made).toHaveLength(1);
  });

  for (const mode of ['login-all', 'redirect-login-all'] as const)
    it(`a server that sends every client, a made-up one too, to ${mode}: could-not-run (needs-input), with the reason`, async () => {
      const s = await serve({ authorize: mode });
      const { report } = await run(s.url, { config: prereg() });
      expect(verdict(report, 'oauth-reg-prereg')).toBe('could-not-run (needs-input)');
      expect(actual(report, 'oauth-reg-prereg')).toContain('made-up');
    });

  it('a redirect to somewhere that is not the redirect URI is not an acceptance', async () => {
    const s = await serve({ authorize: 'redirect-login-all' });
    const { report } = await run(s.url, { config: prereg() });
    expect(verdict(report, 'oauth-reg-prereg')).not.toBe('passed');
  });
});

describe('CLI · mcp conformance · oauth registration · the client_id URL, refused for the client or for something else', () => {
  const good = 'https://client.example/good.json';
  const bad = 'https://client.example/mismatch.json';
  const both = () => cimd({ clientIdMetadataUrl: good, clientIdMetadataMismatchUrl: bad });
  const badAsGood = () => cimd({ clientIdMetadataUrl: bad, clientIdMetadataMismatchUrl: bad });

  const goodCases: [string, AuthOpts, string][] = [
    ['invalid_client', {}, 'failed'],
    ['invalid_request that names the client_id', { authorize: 'invalid-request-client' }, 'failed'],
    [
      'invalid_request that does not',
      { authorize: 'invalid-request-plain' },
      'could-not-run (prerequisite-failed)',
    ],
    ['403 with no code', { authorize: 'forbidden' }, 'could-not-run (prerequisite-failed)'],
    [
      'access_denied in the redirect',
      { authorize: 'error-redirect' },
      'could-not-run (prerequisite-failed)',
    ],
    ['503', { authorize: 503 }, 'could-not-run (transport-error)'],
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
  ];
  for (const [name, opts, expected] of goodCases)
    it(`the good document refused with ${name}: ${expected}`, async () => {
      const s = await serve({ as: { cimd: true }, ...opts });
      const { report } = await run(s.url, { config: badAsGood() });
      expect(verdict(report, 'oauth-reg-cimd')).toBe(expected);
    });

  it('the mismatched half passes only for a refusal of the client', async () => {
    const plain = await serve({ as: { cimd: true }, authorize: 'invalid-request-plain' });
    const a = await run(plain.url, { config: both() });
    expect(verdict(a.report, 'oauth-reg-cimd')).toBe('could-not-run (prerequisite-failed)');
    const named = await serve({ as: { cimd: true }, authorize: 'invalid-request-client' });
    const b = await run(named.url, { config: both() });
    expect(verdict(b.report, 'oauth-reg-cimd')).toBe('passed');
  });

  it('the good document must be accepted before the mismatched one is read: a wrong URL of the user is not a pass', async () => {
    const s = await serve({ as: { cimd: true } });
    const { report } = await run(s.url, { config: badAsGood() });
    expect(verdict(report, 'oauth-reg-cimd')).toBe('failed');
    expect(s.seen.filter((x) => x.path === '/authorize')).toHaveLength(1);
  });
});
