// `plune mcp conformance` end to end: the catalog without a server, and a run against the stdio fixture
// (./fixtures/stdio-server.mjs) as a process and a Streamable HTTP server on 127.0.0.1. Nothing reaches past this
// machine.

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  handleMcpConformance,
  type McpConformanceFlags,
} from '../../cli/commands/mcp-conformance.js';
import { CATALOG } from '../conformance/catalog.js';
import { manifestDigest, PROFILE } from '../conformance/profile.js';
import { BUCKETS } from '../conformance/score.js';
import type { McpConformanceReport } from '../result.js';
import { streamableServer, type Fixture } from './fixtures/http-servers.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/stdio-server.mjs', import.meta.url));
const STDIO = [process.execPath, FIXTURE];

const servers: Fixture[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

async function run(flags: McpConformanceFlags, server: string[] = []) {
  let out = '';
  let err = '';
  const code = await handleMcpConformance({ timeout: '20s', ...flags }, server, {
    out: (s) => (out += s),
    err: (s) => (err += s),
    env: {},
    clientVersion: '9.9.9',
  });
  return { code, out, err };
}

async function report(flags: McpConformanceFlags, server: string[] = STDIO) {
  const r = await run({ ...flags, format: 'json' }, server);
  return { code: r.code, report: JSON.parse(r.out) as McpConformanceReport };
}

describe('CLI · mcp conformance · the catalog without a server', () => {
  it('--list-checks --format json prints every entry with id, level, specRefs, eras and transports, exit 0', async () => {
    // No server is named: a connection would be a flag error (exit 2).
    const { code, out } = await run({ listChecks: true, format: 'json' });
    expect(code).toBe(0);
    const doc = JSON.parse(out) as {
      kind: string;
      profile: { version: string; manifestDigest: string };
      checks: Record<string, unknown>[];
    };
    expect(doc.kind).toBe('mcp-conformance-catalog');
    expect(doc.profile).toMatchObject({ version: PROFILE.version, manifestDigest: manifestDigest(PROFILE.checks) });
    expect(doc.checks.map((c) => c['id'])).toEqual(CATALOG.map((e) => e.id));
    for (const c of doc.checks) {
      expect(Object.keys(c)).toEqual(expect.arrayContaining(['id', 'level', 'specRefs', 'eras', 'transports']));
      expect((c['specRefs'] as unknown[]).length).toBeGreaterThan(0);
    }
  });

  it('--list-checks prints a table, and --suite narrows it', async () => {
    const all = await run({ listChecks: true });
    expect(all.code).toBe(0);
    expect(all.out).toContain('life-initialize-result');
    expect(all.out).toContain(`${CATALOG.length} checks.`);
    const oauth = await run({ listChecks: true, suite: ['oauth'] });
    expect(oauth.out).toContain('0 checks.');
  });

  it('--explain prints the whole entry; an unknown id is exit 2', async () => {
    const human = await run({ explain: 'logging-set-level' });
    expect(human.code).toBe(0);
    expect(human.out).toContain('level: MUST (derived: ');
    expect(human.out).toContain('https://modelcontextprotocol.io/specification/2025-11-25/server/utilities/logging');
    const asJson = await run({ explain: 'tools-name-format', format: 'json' });
    expect(JSON.parse(asJson.out)).toEqual(CATALOG.find((e) => e.id === 'tools-name-format'));
    const unknown = await run({ explain: 'no-such-check' });
    expect(unknown.code).toBe(2);
    expect(unknown.err).toContain('--explain no-such-check: no such check.');
  });

  it('a wrong flag is exit 2 before any server starts', async () => {
    for (const [flags, says] of [
      [{ suite: ['transport'] }, '--suite must be one of protocol, oauth, tasks, apps'],
      [{ check: ['no-such-check'] }, '--check no-such-check: no such check'],
      [{ check: ['life-ping-empty-result'], suite: ['oauth'] }, 'is in the protocol suite: add --suite protocol'],
      [{ protocolVersion: 'latest' }, '--protocol-version must be auto or a revision'],
      [{ format: 'junit-xml' }, '--format must be one of human, json'],
      [{ listChecks: true, out: 'x.json' }, '--out is for a run'],
      [{ out: join(tmpdir(), 'no-such-folder-plune', 'r.json') }, 'does not exist'],
    ] as [McpConformanceFlags, string][]) {
      const r = await run(flags, ['this-command-does-not-exist']);
      expect(r.code, JSON.stringify(flags)).toBe(2);
      expect(r.err, JSON.stringify(flags)).toContain(says);
    }
  });

  it('a server that does not start is exit 2', async () => {
    const r = await run({}, ['plune-no-such-command-for-conformance']);
    expect(r.code).toBe(2);
  });
});

describe('CLI · mcp conformance · a run', () => {
  it('records the profile, the checker and the protocol version; nothing measured is score null, incomplete, exit 3', async () => {
    // A check of the other era and an advisory: nothing that counts is measured.
    const { code, report: r } = await report({ check: ['tools-list-order-stable', 'tools-name-format'] });
    expect(code).toBe(3);
    expect(r).toMatchObject({
      kind: 'mcp-conformance-report',
      schemaVersion: 1,
      checkerVersion: '9.9.9',
      profileId: PROFILE.id,
      profileVersion: PROFILE.version,
      manifestDigest: manifestDigest(PROFILE.checks),
      protocolVersionRequested: 'auto',
      server: { name: 'fixture', version: '1.0.0' },
      transport: 'stdio',
      suites: ['protocol'],
      exitCode: 3,
    });
    expect(r.protocolVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(r.summary).toMatchObject({ score: null, applicable: 0, verdict: 'incomplete' });
    expect(r.pendingCheckIds).toEqual(r.summary.pending);
    expect(r.bySuite.protocol).toEqual(r.summary);
  });

  it('every selected check lands in one bucket, and the buckets add up to the checks', async () => {
    const { report: r } = await report({});
    expect(r.checks.map((c) => c.id)).toEqual(CATALOG.filter((e) => e.suite === 'protocol').map((e) => e.id));
    expect(BUCKETS.reduce((n, k) => n + r.summary[k].length, 0)).toBe(r.checks.length);
    for (const c of r.checks) expect(r.summary[c.bucket], c.id).toContain(c.id);
  });

  it('a check of another era is not-applicable (era), never passed', async () => {
    const { report: r } = await report({ protocolVersion: '2026-07-28', check: ['life-ping-empty-result', 'tools-list-order-stable'] });
    expect(r.protocolVersion).toBe('2026-07-28');
    expect(r.checks.map((c) => [c.id, c.state, c.reason])).toEqual([
      ['life-ping-empty-result', 'not-applicable', 'era'],
      ['tools-list-order-stable', 'passed', undefined],
    ]);
  });

  it('over HTTP the stdio checks are not-applicable (transport)', async () => {
    const http = await streamableServer();
    servers.push(http);
    const { report: r } = await report(
      { url: `${http.origin}/mcp`, check: ['stdio-stdout-clean', 'stdio-exit-on-eof'] },
      [],
    );
    expect(r.transport).toBe('http');
    expect(r.checks.map((c) => `${c.id} ${c.state} ${c.reason ?? ''}`)).toEqual([
      'stdio-stdout-clean not-applicable transport',
      'stdio-exit-on-eof not-applicable transport',
    ]);
  });

  it('a suite with no checks yet is an empty run: score null, incomplete, exit 3', async () => {
    const { code, report: r } = await report({ suite: ['oauth'] });
    expect(code).toBe(3);
    expect(r.checks).toEqual([]);
    expect(r.summary).toMatchObject({ score: null, verdict: 'incomplete' });
  });

  it('the human report explains the score in one line per suite, and --out holds the same JSON', async () => {
    const out = join(mkdtempSync(join(tmpdir(), 'plune-conformance-')), 'r.json');
    const r = await run({ out, suite: ['protocol', 'oauth'], check: ['tools-list-order-stable', 'tools-name-format'] }, STDIO);
    expect(r.code).toBe(3);
    expect(r.out).toMatch(/^protocol: Score none = 0 of 0 \| outside the score: advisories 2$/m);
    expect(r.out).toMatch(/^oauth: Score none = 0 of 0$/m);
    expect(r.out).toMatch(/^all suites: Score none = 0 of 0/m);
    expect(r.out).toContain('Verdict: incomplete (exit 3): nothing was measured, so nothing is proven.');
    const saved = JSON.parse(readFileSync(out, 'utf8')) as McpConformanceReport;
    expect(saved.exitCode).toBe(3);
    expect(saved.suites).toEqual(['protocol', 'oauth']);
  });
});
