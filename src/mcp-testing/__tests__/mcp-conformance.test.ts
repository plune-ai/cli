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
import { BUCKETS, exitCodeOf, summarize } from '../conformance/score.js';
import { readJUnit } from '../../importers/junit.js';
import { conformanceRun, render } from '../report/index.js';
import type { ConformanceResult, McpConformanceReport } from '../result.js';
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
    expect(oauth.out).toContain(`${CATALOG.filter((e) => e.suite === 'oauth').length} checks.`);
    expect(oauth.out).not.toContain('life-initialize-result');
    const tasks = await run({ listChecks: true, suite: ['tasks'] });
    expect(tasks.out).toContain('0 checks.');
  });

  it('--explain prints the whole entry; an unknown id is exit 2', async () => {
    const human = await run({ explain: 'logging-set-level' });
    expect(human.code).toBe(0);
    expect(human.out).toContain('level: SHOULD (derived: ');
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
  }, 15_000);

  it('every selected check lands in one bucket, and the buckets add up to the checks', async () => {
    const { report: r } = await report({});
    expect(r.checks.map((c) => c.id)).toEqual(CATALOG.filter((e) => e.suite === 'protocol').map((e) => e.id));
    expect(BUCKETS.reduce((n, k) => n + r.summary[k].length, 0)).toBe(r.checks.length);
    for (const c of r.checks) expect(r.summary[c.bucket], c.id).toContain(c.id);
  }, 15_000);

  it('a check of another era is not-applicable (era), never passed', async () => {
    const { report: r } = await report({ protocolVersion: '2026-07-28', check: ['life-ping-empty-result', 'tools-list-order-stable'] });
    expect(r.protocolVersion).toBe('2026-07-28');
    // A modern run makes no initialize handshake: this legacy-only server has no server/discover to stand on.
    expect(r.checks.map((c) => [c.id, c.state, c.reason])).toEqual([
      ['life-ping-empty-result', 'not-applicable', 'era'],
      ['tools-list-order-stable', 'could-not-run', 'prerequisite-failed'],
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
    const { code, report: r } = await report({ suite: ['tasks'] });
    expect(code).toBe(3);
    expect(r.checks).toEqual([]);
    expect(r.summary).toMatchObject({ score: null, verdict: 'incomplete' });
  });

  it('the human report explains the score in one line per suite, and --out holds the same JSON', async () => {
    const out = join(mkdtempSync(join(tmpdir(), 'plune-conformance-')), 'r.json');
    const r = await run({ out, suite: ['protocol', 'tasks'], check: ['tools-list-order-stable', 'tools-name-format'] }, STDIO);
    expect(r.code).toBe(3);
    expect(r.out).toMatch(/^protocol: Score none = 0 of 0 \| outside the score: advisories 2$/m);
    expect(r.out).toMatch(/^tasks: Score none = 0 of 0$/m);
    expect(r.out).toMatch(/^all suites: Score none = 0 of 0/m);
    expect(r.out).toContain('Verdict: incomplete (exit 3): nothing was measured, so nothing is proven.');
    const saved = JSON.parse(readFileSync(out, 'utf8')) as McpConformanceReport;
    expect(saved.exitCode).toBe(3);
    expect(saved.suites).toEqual(['protocol', 'tasks']);
  });
});

const CONFORMANCE = fileURLToPath(new URL('./fixtures/conformance-server.mjs', import.meta.url));
const conformanceServer = (mode: string) => [process.execPath, CONFORMANCE, mode];
const statuses = (xml: string) =>
  Object.fromEntries(readJUnit(xml, 'r.xml').map((r) => [r.keys[0]?.value, r.rawStatus]));
const caseOf = (xml: string, id: string) =>
  readJUnit(xml, 'r.xml').find((r) => r.keys[0]?.value === `mcp.conformance.protocol#${id}`);
/** The counts the suite claims, and the counts of its cases: the same, or a reader is misled. */
function totals(xml: string) {
  const suite = /<testsuite name="plune mcp conformance" tests="(\d+)" failures="(\d+)" errors="(\d+)" skipped="(\d+)">/.exec(xml);
  const s = Object.values(statuses(xml));
  return {
    claimed: suite?.slice(1).map(Number),
    counted: [s.length, ...['failure', 'error', 'skipped'].map((k) => s.filter((x) => x === k).length)],
  };
}

/** A report as a run would make it, from verdicts alone: what no fixture server can send (`pending`). */
function handMade(verdicts: [string, ConformanceResult['state'], ConformanceResult['reason']?][]): McpConformanceReport {
  const checks = verdicts.map(([id, state, reason]): ConformanceResult => {
    const e = CATALOG.find((c) => c.id === id)!;
    return {
      id,
      suite: e.suite,
      kind: e.kind,
      class: 'deterministic',
      level: e.level,
      state,
      ...(reason === undefined ? {} : { reason }),
      bucket: 'pending',
      expected: e.description,
      actual: `what ${id} saw`,
      fix: `fix ${id}`,
      specRef: `https://modelcontextprotocol.io/specification/2025-11-25/x (${id})`,
    };
  });
  const summary = summarize(checks);
  for (const c of checks) c.bucket = BUCKETS.find((k) => summary[k].includes(c.id))!;
  return {
    kind: 'mcp-conformance-report',
    schemaVersion: 1,
    command: 'conformance',
    checkerVersion: '9.9.9',
    profileId: PROFILE.id,
    profileVersion: PROFILE.version,
    manifestDigest: manifestDigest(PROFILE.checks),
    protocolVersion: '2025-11-25',
    protocolVersionRequested: 'auto',
    server: { name: 'fixture', version: '1.0.0' },
    transport: 'stdio',
    suites: ['protocol'],
    checks,
    pendingCheckIds: summary.pending,
    bySuite: { protocol: summary },
    summary,
    exitCode: exitCodeOf(summary.verdict),
  };
}

describe('CLI · mcp conformance · junit-xml', () => {
  it('one case per check: a failed MUST is a failure, could-not-run an error, not-applicable and pending skipped, a failed SHOULD advice', () => {
    const xml = render(
      conformanceRun(
        handMade([
          ['life-initialize-result', 'passed'],
          ['life-ping-empty-result', 'failed'],
          ['tools-name-format', 'failed'],
          ['base-jsonrpc-parse-error', 'could-not-run', 'timeout'],
          ['tools-structured-conformant', 'could-not-run', 'needs-input'],
          ['tools-list-order-stable', 'not-applicable', 'era'],
          ['resources-read-listed', 'pending'],
        ]),
      ),
      'junit-xml',
    );
    const p = 'mcp.conformance.protocol#';
    expect(statuses(xml)).toEqual({
      [`${p}life-initialize-result`]: 'pass',
      [`${p}life-ping-empty-result`]: 'failure',
      [`${p}tools-name-format`]: 'skipped',
      [`${p}base-jsonrpc-parse-error`]: 'error',
      [`${p}tools-structured-conformant`]: 'error',
      [`${p}tools-list-order-stable`]: 'skipped',
      [`${p}resources-read-listed`]: 'skipped',
    });
    const t = totals(xml);
    expect(t.claimed).toEqual([7, 1, 2, 3]);
    expect(t.counted).toEqual(t.claimed);
    // The reason and the specRef are in the case's text.
    expect(caseOf(xml, 'base-jsonrpc-parse-error')?.errorContext).toContain(
      'could-not-run: timeout: what base-jsonrpc-parse-error saw',
    );
    expect(caseOf(xml, 'tools-list-order-stable')?.errorContext).toContain('not-applicable: era');
    expect(caseOf(xml, 'tools-name-format')?.errorContext).toContain('advisory');
    expect(caseOf(xml, 'life-ping-empty-result')?.errorContext).toContain(
      'spec: https://modelcontextprotocol.io/specification/2025-11-25/x (life-ping-empty-result)',
    );
    expect(xml).toContain('<skipped type="pending"');
  });

  it('nothing selected is one case "run" that could not run, never an empty suite', () => {
    const xml = render(conformanceRun({ ...handMade([]), suites: ['oauth'] }), 'junit-xml');
    expect(readJUnit(xml, 'r.xml').map((r) => [r.keys[0]?.value, r.rawStatus])).toEqual([
      ['mcp.conformance#run', 'error'],
    ]);
  });

  it('--reporter junit-xml and --out json=: both files from one run, the exit code of a run without them', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'plune-conformance-junit-'));
    const xmlPath = join(dir, 'conformance.xml');
    const jsonPath = join(dir, 'conformance.json');
    const plain = await run({ format: 'json' }, conformanceServer('bad'));
    const r = await run(
      { format: 'json', reporter: 'junit-xml', out: [xmlPath, `json=${jsonPath}`] },
      conformanceServer('bad'),
    );
    expect(r.code).toBe(1);
    expect(r.code).toBe(plain.code);
    expect(readFileSync(jsonPath, 'utf8')).toBe(r.out);
    const xml = readFileSync(xmlPath, 'utf8');
    expect(statuses(xml)).toMatchObject({
      'mcp.conformance.protocol#life-ping-empty-result': 'failure',
      'mcp.conformance.protocol#tools-name-format': 'skipped',
      'mcp.conformance.protocol#tools-list-order-stable': 'skipped',
      'mcp.conformance.protocol#tools-structured-conformant': 'error',
    });
    const report = JSON.parse(r.out) as McpConformanceReport;
    expect(Object.keys(statuses(xml))).toEqual(report.checks.map((c) => `mcp.conformance.protocol#${c.id}`));
    const t = totals(xml);
    expect(t.counted).toEqual(t.claimed);
    expect(t.claimed?.[1]).toBe(report.summary.failed.length);
  }, 60_000);

  it('could-not-run is an error with its reason, never a pass: a server that stops answering, exit 3', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'plune-conformance-junit-'));
    const xmlPath = join(dir, 'c.xml');
    const r = await run({ timeout: '300ms', reporter: 'junit-xml', out: xmlPath }, conformanceServer('silent'));
    expect(r.code).toBe(3);
    const xml = readFileSync(xmlPath, 'utf8');
    const asJson = await run({ timeout: '300ms', format: 'json' }, conformanceServer('silent'));
    const cnr = (JSON.parse(asJson.out) as McpConformanceReport).checks.filter((c) => c.state === 'could-not-run');
    expect(cnr.length).toBeGreaterThan(2);
    for (const c of cnr) {
      expect(caseOf(xml, c.id)?.rawStatus, c.id).toBe('error');
      expect(caseOf(xml, c.id)?.errorContext, c.id).toContain(`could-not-run: ${c.reason}`);
    }
  }, 60_000);

  it('a secret the server repeats is in no file and nothing printed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'plune-conformance-junit-'));
    const marker = 'conformance-secret-4242';
    const r = await run(
      { env: [`API_TOKEN=${marker}`], reporter: 'junit-xml', out: [join(dir, 'c.xml'), `json=${join(dir, 'c.json')}`] },
      conformanceServer('bad'),
    );
    expect(r.code).toBe(1);
    const xml = readFileSync(join(dir, 'c.xml'), 'utf8');
    expect(caseOf(xml, 'tools-name-format')?.errorContext).toContain('bad name, spaced ***');
    for (const text of [xml, readFileSync(join(dir, 'c.json'), 'utf8'), r.out, r.err]) expect(text).not.toContain(marker);
  }, 60_000);

  it('a wrong report flag is exit 2 before any server starts', async () => {
    for (const [flags, says] of [
      [{ reporter: 'junit-xml' }, '--reporter junit-xml writes a file: give it --out <path>.'],
      [{ reporter: 'xunit', out: 'r.xml' }, '--reporter must be one of junit-xml'],
      [{ out: 'markdown=r.md' }, '--out markdown=r.md: plune mcp conformance writes json or junit-xml.'],
      [{ listChecks: true, reporter: 'junit-xml', out: 'r.xml' }, '--out is for a run'],
    ] as [McpConformanceFlags, string][]) {
      const r = await run(flags, ['this-command-does-not-exist']);
      expect(r.code, JSON.stringify(flags)).toBe(2);
      expect(r.err, JSON.stringify(flags)).toContain(says);
    }
  });
});
