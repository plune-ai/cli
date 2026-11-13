// The matrix of the oauth suite: one run for each revision and each registration method of --config, each with its own
// summary, and one more summary made from the counters of all of them. Against the loopback servers of auth-fixture.ts.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  handleMcpConformance,
  type McpConformanceFlags,
} from '../../../cli/commands/mcp-conformance.js';
import type { McpConformanceReport, McpConformanceReportSet } from '../../result.js';
import { parseOauthConfig } from '../checks/auth-config.js';
import {
  authFixture,
  CLIENT_ID,
  CLIENT_SECRET,
  type AuthFixture,
  type AuthOpts,
} from './auth-fixture.js';

const dir = mkdtempSync(join(tmpdir(), 'plune-oauth-matrix-'));
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
const PREREG = { method: 'preregistered', clientId: CLIENT_ID, clientSecretEnv: SECRET_ENV };
const CIMD = {
  method: 'cimd',
  clientIdMetadataUrl: 'https://client.example/client.json',
  clientIdMetadataMismatchUrl: 'https://client.example/mismatch.json',
};
const base = { redirectUri: 'http://127.0.0.1:8765/callback', scopes: ['mcp:tools'] };

async function run(url: string, config: string, flags: Partial<McpConformanceFlags> = {}) {
  let out = '';
  let err = '';
  const code = await handleMcpConformance(
    {
      timeout: '10s',
      format: 'json',
      suite: ['oauth'],
      protocolVersion: 'both',
      url,
      config,
      allowOrigin: [new URL(url).origin],
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
    doc: out.startsWith('{')
      ? (JSON.parse(out) as McpConformanceReport | McpConformanceReportSet)
      : undefined,
  };
}

const state = (r: McpConformanceReport, id: string) => {
  const c = r.checks.find((x) => x.id === id)!;
  return c.reason === undefined ? c.state : `${c.state} (${c.reason})`;
};

describe('CLI · mcp conformance · oauth matrix · --config', () => {
  it('registration is one object or a list of objects with a method each, never the same method twice', () => {
    expect(
      parseOauthConfig(JSON.stringify({ registration: [PREREG, CIMD] })).registrations,
    ).toHaveLength(2);
    expect(parseOauthConfig(JSON.stringify({ registration: PREREG })).registration?.method).toBe(
      'preregistered',
    );
    for (const [bad, says] of [
      [{ registration: [] }, /empty list/],
      [{ registration: [PREREG, PREREG] }, /"preregistered" twice/],
      [{ registration: [PREREG, 5] }, /"registration\[1\]" must be an object/],
      [
        { registration: [PREREG, { method: 'cimd', extra: 1 }] },
        /unknown key "registration\[1\]\.extra"/,
      ],
      [{ registration: [{ method: 'nope' }] }, /"registration\[0\]\.method"/],
      [
        { registration: [{ method: 'preregistered', clientSecret: 'x' }] },
        /secret is never written/,
      ],
    ] as const)
      expect(() => parseOauthConfig(JSON.stringify(bad)), JSON.stringify(bad)).toThrow(says);
  });
});

describe('CLI · mcp conformance · oauth matrix · the runs', () => {
  it('two revisions and two methods give four runs, each labelled, and one summary from the counters of all', async () => {
    const s = await serve({ as: { cimd: true } });
    const { code, doc } = await run(
      s.url,
      configFile({ ...base, auth: 'client-credentials', registration: [PREREG, CIMD] }),
    );
    const set = doc as McpConformanceReportSet;
    expect(set.kind).toBe('mcp-conformance-report-set');
    expect(set.reports).toHaveLength(4);
    expect(
      set.reports.map((r) => `${r.matrix?.revision} ${r.matrix?.registration}`).sort(),
    ).toEqual([
      '2025-11-25 cimd',
      '2025-11-25 preregistered',
      '2026-07-28 cimd',
      '2026-07-28 preregistered',
    ]);
    // Each run keeps to its own method: the checks of the other one are not for it.
    for (const r of set.reports) {
      const prereg = r.matrix?.registration === 'preregistered';
      expect(state(r, 'oauth-reg-prereg')).toBe(prereg ? 'passed' : 'not-applicable (not-offered)');
      expect(state(r, 'oauth-reg-cimd')).toBe(prereg ? 'not-applicable (not-offered)' : 'passed');
    }
    // The combined summary is the counters added up, and the score is made from the sums.
    const sum = (key: 'passed' | 'failed' | 'couldNotRun') =>
      set.reports.reduce((a, r) => a + r.summary[key].length, 0);
    const applicable = set.reports.reduce((a, r) => a + r.summary.applicable, 0);
    expect(set.combined).toEqual({
      runs: 4,
      passed: sum('passed'),
      failed: sum('failed'),
      couldNotRun: sum('couldNotRun'),
      applicable,
      score: applicable === 0 ? null : Math.floor((1000 * sum('passed')) / applicable) / 10,
      verdict:
        sum('failed') > 0
          ? 'failed'
          : sum('couldNotRun') > 0 || applicable === 0
            ? 'incomplete'
            : 'passed',
    });
    expect(code).toBe(set.exitCode);
  });

  it('one registration object and a revision named give one report with its label and no combined summary', async () => {
    const s = await serve({});
    const { doc } = await run(s.url, configFile({ ...base, registration: PREREG }), {
      protocolVersion: '2026-07-28',
    });
    const r = doc as McpConformanceReport;
    expect(r.kind).toBe('mcp-conformance-report');
    expect(r.matrix).toEqual({ revision: '2026-07-28', registration: 'preregistered' });
  });

  it('a config with no registration is one run per revision, labelled with no method', async () => {
    const s = await serve({});
    const { doc } = await run(s.url, configFile({ ...base }));
    const set = doc as McpConformanceReportSet;
    expect(set.reports.map((r) => r.matrix)).toEqual([
      { revision: '2025-11-25', registration: null },
      { revision: '2026-07-28', registration: null },
    ]);
    expect(set.combined?.runs).toBe(2);
  });

  it('the human report names the method of each run and prints the combined line', async () => {
    const s = await serve({ as: { cimd: true } });
    const { out } = await run(s.url, configFile({ ...base, registration: [PREREG, CIMD] }), {
      format: 'human',
    });
    expect(out).toMatch(/registration preregistered/);
    expect(out).toMatch(/registration cimd/);
    expect(out).toMatch(/Combined over 4 runs: Score /);
  });

  it('a public server: every run is not-applicable (no-auth), nothing passed, in every cell of the matrix', async () => {
    const s = await serve({ public: true });
    const { doc } = await run(s.url, configFile({ ...base, registration: [PREREG, CIMD] }));
    const set = doc as McpConformanceReportSet;
    expect(set.reports).toHaveLength(4);
    for (const r of set.reports) expect(r.summary.passed).toEqual([]);
    expect(set.combined?.passed).toBe(0);
  });
});
