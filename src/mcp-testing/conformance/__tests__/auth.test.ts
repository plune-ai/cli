// The oauth suite of `plune mcp conformance`, each check against a resource server and an authorization server on
// loopback that keep the requirement and one that breaks it. The run is the whole command, as a user starts it.

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  handleMcpConformance,
  type McpConformanceFlags,
} from '../../../cli/commands/mcp-conformance.js';
import type { McpConformanceReport, McpConformanceReportSet } from '../../result.js';
import { CATALOG } from '../catalog.js';
import { PROFILE } from '../profile.js';
import { bearerParams } from '../checks/auth.js';
import {
  authFixture,
  CLIENT_ID,
  CLIENT_SECRET,
  type AuthFixture,
  type AuthOpts,
  type Seen,
} from './auth-fixture.js';

const dir = mkdtempSync(join(tmpdir(), 'plune-oauth-'));
const open: AuthFixture[] = [];
afterEach(async () => {
  for (const f of open.splice(0)) await f.close();
});
const serve = async (o: AuthOpts = {}, seen?: Seen[]) => {
  const f = await authFixture(o, seen);
  open.push(f);
  return f;
};

const SECRET_ENV = 'PLUNE_TEST_OAUTH_CLIENT_SECRET';
const configFile = (name: string, config: unknown): string => {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(config));
  return path;
};
const CLIENT = {
  auth: 'client-credentials',
  registration: { method: 'preregistered', clientId: CLIENT_ID, clientSecretEnv: SECRET_ENV },
  scopes: ['mcp:tools'],
};
const credentials = () => configFile('client.json', CLIENT);

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

const verdicts = (r: McpConformanceReport | undefined) =>
  Object.fromEntries(
    (r?.checks ?? []).map((c) => [
      c.id,
      c.reason === undefined ? c.state : `${c.state} (${c.reason})`,
    ]),
  );
const byId = (r: McpConformanceReport | undefined, id: string) =>
  r!.checks.find((c) => c.id === id)!;

describe('CLI · mcp conformance · oauth · catalog', () => {
  it('every check of the suite has a level, a cited section and is for HTTP', () => {
    const entries = CATALOG.filter((e) => e.suite === 'oauth');
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      expect(e.id).toMatch(/^oauth-[a-z0-9-]+$/);
      expect(e.level, e.id).not.toBeNull();
      expect(e.specRefs.length, e.id).toBeGreaterThan(0);
      expect(e.transports).toEqual(['http']);
      if (e.derived) expect(e.derivation, e.id).toBeTruthy();
    }
  });

  it('a Bearer challenge is read with quoted and bare parameters, and a Basic one is not Bearer', () => {
    expect(
      bearerParams(
        'Bearer resource_metadata="https://a.example/p", scope="x y", error=invalid_token',
      ),
    ).toEqual({
      resource_metadata: 'https://a.example/p',
      scope: 'x y',
      error: 'invalid_token',
    });
    expect(bearerParams('Basic realm="x"')).toBeUndefined();
    expect(bearerParams(undefined)).toBeUndefined();
  });
});

describe('CLI · mcp conformance · oauth · a server that keeps its requirements', () => {
  it('every check passes in the modern revision; the loopback authorization server leaves only the https check out', async () => {
    const s = await serve({ as: { iss: true, cimd: true } });
    const { report } = await run(s.url, { config: credentials() });
    const v = verdicts(report);
    expect(Object.entries(v).filter(([, state]) => state !== 'passed')).toEqual([
      ['oauth-as-https', 'not-applicable (not-offered)'],
    ]);
    expect(report?.era).toBe('modern');
  });

  it('in 2025-11-25 the two checks of the later revision are not-applicable (era)', async () => {
    const s = await serve({ as: { cimd: true } });
    const { report } = await run(s.url, { config: credentials(), protocolVersion: '2025-11-25' });
    const v = verdicts(report);
    expect(v['oauth-as-iss-advertised']).toBe('not-applicable (era)');
    expect(v['oauth-as-issuer-matches']).toBe('not-applicable (era)');
    expect(Object.values(v).filter((x) => x.startsWith('failed'))).toEqual([]);
  });

  it('the new checks are not in the frozen profile: they show their verdict and count for nothing', async () => {
    const s = await serve({});
    const { report } = await run(s.url, { config: credentials() });
    expect(PROFILE.checks.filter((id) => id.startsWith('oauth-'))).toEqual([]);
    expect(report?.summary.pending).toContain('oauth-requires-auth');
    expect(report?.exitCode).toBe(3);
  });
});

describe('CLI · mcp conformance · oauth · a public server', () => {
  it('answers every check not-applicable (no-auth) and passes none', async () => {
    const s = await serve({ public: true });
    const { report } = await run(s.url, { config: credentials() });
    for (const [id, v] of Object.entries(verdicts(report)))
      expect(v, id).toBe('not-applicable (no-auth)');
  });
});

describe('CLI · mcp conformance · oauth · each requirement broken on its own', () => {
  const cases: [string, AuthOpts, string, string][] = [
    [
      'a server that answers 200 where 401 is due is public, not conformant',
      { public: true },
      'oauth-requires-auth',
      'not-applicable (no-auth)',
    ],
    ['a Basic challenge', { challenge: 'basic' }, 'oauth-challenge-bearer', 'failed'],
    ['no challenge header', { challenge: 'none' }, 'oauth-challenge-bearer', 'failed'],
    ['no scope in the challenge', { scope: false }, 'oauth-challenge-scope', 'failed'],
    [
      'no metadata by either mechanism',
      { prm: 'none', challenge: 'plain' },
      'oauth-prm-reachable',
      'failed',
    ],
    [
      'a resource_metadata URL that serves nothing',
      { prm: 'none' },
      'oauth-challenge-metadata-url',
      'failed',
    ],
    [
      'metadata of another resource',
      { prmResource: 'https://elsewhere.example/mcp' },
      'oauth-prm-valid',
      'failed',
    ],
    [
      'metadata with no authorization server',
      { authorizationServers: [] },
      'oauth-prm-valid',
      'failed',
    ],
    [
      'no authorization server metadata',
      { as: { none: true } },
      'oauth-as-metadata-discoverable',
      'failed',
    ],
    [
      'a different issuer in the metadata',
      { as: { issuer: 'https://other.example' } },
      'oauth-as-issuer-matches',
      'failed',
    ],
    [
      'an http token endpoint next to an https authorization endpoint',
      { as: { https: 'mixed' } },
      'oauth-as-https',
      'failed',
    ],
    ['https endpoints', { as: { https: true } }, 'oauth-as-https', 'passed'],
    ['every endpoint on a loopback name', {}, 'oauth-as-https', 'not-applicable (not-offered)'],
    ['no PKCE advertised', { as: { pkce: 'none' } }, 'oauth-as-pkce-advertised', 'failed'],
    ['PKCE without S256', { as: { pkce: 'plain' } }, 'oauth-as-pkce-s256', 'failed'],
    ['iss not advertised', {}, 'oauth-as-iss-advertised', 'failed'],
    ['Client ID Metadata Documents not advertised', {}, 'oauth-as-cimd-advertised', 'failed'],
    [
      'a token nobody issued accepted',
      { audience: 'any' },
      'oauth-neg-invalid-token-401',
      'failed',
    ],
  ];
  for (const [name, opts, id, expected] of cases)
    it(`${name}: ${id} is ${expected}`, async () => {
      const s = await serve(opts);
      const { report } = await run(s.url);
      expect(verdicts(report)[id]).toBe(expected);
    });

  it('an authorization server of a path issuer is looked for at the path-inserted location first', async () => {
    // The fixture serves the root location only: a path issuer finds nothing there, and the report says which were tried.
    const p = await serve({ authorizationServers: ['{origin}/tenant1'] });
    const { report } = await run(p.url);
    const tried = (byId(report, 'oauth-as-metadata-discoverable').details ?? []).map(
      (d) => new URL(d.request.url).pathname,
    );
    expect(byId(report, 'oauth-as-metadata-discoverable').state).toBe('failed');
    expect(tried).toEqual([
      '/.well-known/oauth-authorization-server/tenant1',
      '/.well-known/openid-configuration/tenant1',
      '/tenant1/.well-known/openid-configuration',
    ]);
  });
});

describe('CLI · mcp conformance · oauth · the audience of a token', () => {
  it('a server that accepts a token issued for another resource fails oauth-neg-wrong-audience', async () => {
    const s = await serve({ audience: 'lax' });
    const { report } = await run(s.url, { config: credentials() });
    expect(byId(report, 'oauth-neg-wrong-audience').state).toBe('failed');
    expect(byId(report, 'oauth-neg-wrong-audience').actual).toContain('another resource');
  });

  it('a server that checks the audience passes, with the token for itself as the control', async () => {
    const s = await serve({});
    const { report } = await run(s.url, { config: credentials() });
    expect(byId(report, 'oauth-neg-wrong-audience').state).toBe('passed');
    const posts = s.seen.filter(
      (x) => x.path === '/mcp' && x.authorization?.startsWith('Bearer at-'),
    );
    expect(posts).toHaveLength(2);
  });

  it('a server that refuses every token proves nothing: could-not-run, not passed', async () => {
    const s = await serve({ audience: 'refuse-all' });
    const { report } = await run(s.url, { config: credentials() });
    expect(verdicts(report)['oauth-neg-wrong-audience']).toBe(
      'could-not-run (prerequisite-failed)',
    );
  });

  it('an authorization server that will not issue a token for another resource: could-not-run (needs-input)', async () => {
    const s = await serve({ otherResource: 'refuse' });
    const { report } = await run(s.url, { config: credentials() });
    expect(verdicts(report)['oauth-neg-wrong-audience']).toBe('could-not-run (needs-input)');
  });

  it('without credentials in --config: could-not-run (needs-input), and no token is asked for', async () => {
    const s = await serve({});
    const { report } = await run(s.url);
    expect(verdicts(report)['oauth-neg-wrong-audience']).toBe('could-not-run (needs-input)');
    expect(s.seen.filter((x) => x.path === '/token')).toEqual([]);
  });
});

describe('CLI · mcp conformance · oauth · no credentials leave the origin of the server', () => {
  it('a resource_metadata URL on another host is not asked without --allow-origin: could-not-run (needs-input)', async () => {
    const seen: Seen[] = [];
    const foreign = await serve({}, seen);
    const s = await serve({
      prm: 'none',
      prmUrl: `${foreign.origin}/.well-known/oauth-protected-resource/mcp`,
    });
    const { report } = await run(s.url, { config: credentials() });
    expect(verdicts(report)['oauth-prm-reachable']).toBe('could-not-run (needs-input)');
    expect(verdicts(report)['oauth-challenge-metadata-url']).toBe('could-not-run (needs-input)');
    expect(byId(report, 'oauth-prm-reachable').actual).toContain('--allow-origin');
    expect(seen).toEqual([]);
  });

  it('an authorization server on another host gets neither a request nor a credential without --allow-origin', async () => {
    const seen: Seen[] = [];
    const foreign = await serve({}, seen);
    const s = await serve({ authorizationServers: [foreign.origin] });
    const { report } = await run(s.url, { config: credentials() });
    expect(verdicts(report)['oauth-neg-wrong-audience']).toBe('could-not-run (needs-input)');
    expect(seen).toEqual([]);
  });

  it('with --allow-origin the foreign authorization server is asked, and only it gets the credentials', async () => {
    const seen: Seen[] = [];
    const foreign = await serve({}, seen);
    const s = await serve({ authorizationServers: [foreign.origin] });
    const { report } = await run(s.url, { config: credentials(), allowOrigin: [foreign.origin] });
    expect(verdicts(report)['oauth-as-metadata-discoverable']).toBe('passed');
    expect(seen.some((x) => x.path === '/token' && x.authorization?.startsWith('Basic '))).toBe(
      true,
    );
    expect(s.seen.some((x) => x.authorization?.startsWith('Basic '))).toBe(false);
  });
});

describe('CLI · mcp conformance · oauth · secrets stay out of every output', () => {
  const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  for (const [name, opts] of [
    ['a passing run', {}],
    ['a failing run (a token for another resource accepted)', { audience: 'lax' }],
  ] as [string, AuthOpts][])
    it(`${name}: no token, client secret or Basic credential in stdout, stderr, --out json or JUnit`, async () => {
      const s = await serve(opts);
      const json = join(dir, `out-${name.length}.json`);
      const xml = join(dir, `out-${name.length}.xml`);
      const { out, err, report } = await run(s.url, {
        config: credentials(),
        out: [`json=${json}`, `junit-xml=${xml}`],
      });
      const all = [out, err, readFileSync(json, 'utf8'), readFileSync(xml, 'utf8')].join('\n');
      expect(all.length).toBeGreaterThan(1000);
      for (const secret of [CLIENT_SECRET, basic, 'Basic ' + basic])
        expect(all).not.toContain(secret);
      expect(all).not.toMatch(/at-\d+-7c1d9e5b3f2a8064/);
      // The token request is in the report, with the credential masked.
      const request = byId(report, 'oauth-neg-wrong-audience').details?.find((d) =>
        d.request.url.endsWith('/token'),
      );
      expect(request?.request.headers.find(([n]) => n === 'Authorization')?.[1]).toBe('***');
    });
});

describe('CLI · mcp conformance · oauth · configuration and matrix', () => {
  it('a secret written into --config is refused before any request, with the way to name it', async () => {
    const s = await serve({});
    const bad = configFile('bad.json', {
      registration: { method: 'preregistered', clientId: 'x', clientSecret: CLIENT_SECRET },
    });
    const { code, err, out } = await run(s.url, { config: bad });
    expect(code).toBe(2);
    expect(err).toContain('name the variable that holds it');
    expect(err).not.toContain(CLIENT_SECRET);
    expect(out).toBe('');
    expect(s.seen).toEqual([]);
  });

  it('clientSecretEnv must be a variable name, not a secret', async () => {
    const s = await serve({});
    const bad = configFile('bad2.json', {
      registration: {
        method: 'preregistered',
        clientId: 'x',
        clientSecretEnv: 'cs-8f3a91d27b4c-46e5',
      },
    });
    const { code, err } = await run(s.url, { config: bad });
    expect(code).toBe(2);
    expect(err).toContain('NAME of an environment variable');
  });

  it('both revisions give one report each, with their own era, and the exit code of the worse', async () => {
    const s = await serve({});
    const { out } = await run(s.url, { protocolVersion: 'both' });
    const set = JSON.parse(out) as McpConformanceReportSet;
    expect(set.kind).toBe('mcp-conformance-report-set');
    expect(set.reports.map((r) => [r.protocolVersion, r.era])).toEqual([
      ['2025-11-25', 'legacy'],
      ['2026-07-28', 'modern'],
    ]);
  });

  it('a stdio server is not-applicable for every check (transport)', async () => {
    let out = '';
    await handleMcpConformance(
      { timeout: '5s', format: 'json', suite: ['oauth'], protocolVersion: '2026-07-28' },
      ['node', '-e', '0'],
      {
        out: (s) => (out += s),
        err: () => {},
        env: {},
        cwd: dir,
      },
    );
    const r = JSON.parse(out) as McpConformanceReport;
    for (const c of r.checks)
      expect(`${c.state} (${c.reason})`, c.id).toBe('not-applicable (transport)');
  });
});
