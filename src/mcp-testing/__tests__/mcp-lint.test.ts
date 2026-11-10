// `plune mcp lint` end to end against real servers: the stdio fixture (./fixtures/lint-server.mjs) as a process, and
// the same server over Streamable HTTP on 127.0.0.1. Nothing here reaches past this machine.

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProgram } from '../../cli.js';
import { handleMcpLint, type McpLintFlags } from '../../cli/commands/mcp-lint.js';
import { CALL_RULES, LINT_RULES } from '../lint/index.js';
import type { McpReport } from '../result.js';
import { lintServer } from './fixtures/lint-server.mjs';
import { recorder, type Fixture } from './fixtures/http-servers.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/lint-server.mjs', import.meta.url));
const TODAY = '2026-11-10';

const servers: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  vi.unstubAllEnvs();
});

const tmp = () => mkdtempSync(join(tmpdir(), 'plune-lint-'));

interface Run {
  code: number;
  out: string;
  err: string;
}

/** Runs the command as its action would; `mode` starts the stdio fixture, `server` replaces it. */
async function lint(
  opts: {
    mode?: string;
    flags?: McpLintFlags;
    server?: string[];
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<Run> {
  let out = '';
  let err = '';
  const server =
    opts.server ?? (opts.mode === undefined ? [] : [process.execPath, FIXTURE, opts.mode]);
  const code = await handleMcpLint({ timeout: '20s', ...opts.flags }, server, {
    out: (s) => (out += s),
    err: (s) => (err += s),
    env: opts.env ?? {},
    cwd: opts.cwd ?? tmp(),
    today: TODAY,
  });
  return { code, out, err };
}

async function json(
  opts: Parameters<typeof lint>[0] = {},
): Promise<{ code: number; report: McpReport }> {
  const run = await lint({ ...opts, flags: { ...opts.flags, format: 'json' } });
  return { code: run.code, report: JSON.parse(run.out) as McpReport };
}

const ids = (report: McpReport) =>
  report.findings.map((f) => `${f.level} ${f.rule} ${f.target.tool}`);

/** The fixture over Streamable HTTP, stateless: a fresh SDK server per request, as http-servers.ts does. */
async function httpServer(mode: string): Promise<string> {
  const server: HttpServer = createServer((req, res) => {
    if (!req.url?.startsWith('/mcp')) {
      res.writeHead(404).end();
      return;
    }
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    void lintServer(mode)
      .connect(transport)
      .then(() => transport.handleRequest(req, res));
  });
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

async function serve(start: Promise<Fixture>): Promise<Fixture> {
  const f = await start;
  servers.push(f);
  return f;
}

describe('CLI · mcp lint · findings and exit codes', () => {
  it('CLI · mcp lint · a stdio server with a finding on each level fails at the default --fail-on error (AC-1, AC-3)', async () => {
    const run = await lint({ mode: 'mixed' });
    expect(run.code).toBe(1);
    expect(run.out).toContain('lint-mixed 1.2.3 · stdio · 3 tools');
    expect(run.out).toMatch(/^error +broken +input-schema-not-object$/m);
    expect(run.out).toMatch(/^warn +broken +desc-missing$/m);
    expect(run.out).toContain('fix: Give the tool an inputSchema');
    // info is counted, not shown, unless asked
    expect(run.out).not.toContain('annotations-missing');
    expect(run.out).toContain('1 info finding not shown (--show-info shows it).');
    expect(run.out).toContain('1 error, 1 warning, 1 info, 0 suppressed · failing on: error');
    const shown = await lint({ mode: 'mixed', flags: { showInfo: true } });
    expect(shown.out).toMatch(/^info +broken +annotations-missing$/m);
  });

  it('CLI · mcp lint · rows are sorted by level, then tool, then rule', async () => {
    const { report } = await json({ mode: 'mixed' });
    expect(ids(report)).toEqual([
      'error input-schema-not-object broken',
      'warn desc-missing broken',
      'info annotations-missing broken',
    ]);
    expect(report.findings[0]).toMatchObject({
      class: 'deterministic',
      state: 'failed',
      specRef: expect.stringContaining('inputschema'),
    });
  });

  it('CLI · mcp lint · a clean server: no findings, exit 0 (AC-1)', async () => {
    const run = await lint({ mode: 'clean' });
    expect(run.code).toBe(0);
    expect(run.out).toContain('0 errors, 0 warnings, 0 info, 0 suppressed · failing on: error');
  });

  it('CLI · mcp lint · --url: the same findings from a Streamable HTTP server (AC-1)', async () => {
    const { code, report } = await json({ flags: { url: await httpServer('mixed') } });
    expect(code).toBe(1);
    expect(report.transport).toBe('http');
    expect(ids(report)).toEqual([
      'error input-schema-not-object broken',
      'warn desc-missing broken',
      'info annotations-missing broken',
    ]);
    expect((await json({ flags: { url: await httpServer('clean') } })).code).toBe(0);
  });

  it('CLI · mcp lint · heuristic warnings pass by default, fail at --fail-on warn, never at never (AC-2)', async () => {
    const { code, report } = await json({ mode: 'heuristic' });
    expect(report.findings.map((f) => `${f.class} ${f.level}`)).toEqual(['heuristic warn']);
    expect(code).toBe(0);
    expect((await lint({ mode: 'heuristic', flags: { failOn: 'warn' } })).code).toBe(1);
    expect((await lint({ mode: 'heuristic', flags: { failOn: 'never' } })).code).toBe(0);
  });

  it('CLI · mcp lint · --fail-on on each value', async () => {
    const expected = { error: 1, warn: 1, info: 1, never: 0 } as const;
    for (const [failOn, code] of Object.entries(expected)) {
      const run = await lint({ mode: 'mixed', flags: { failOn } });
      expect([failOn, run.code]).toEqual([failOn, code]);
      expect(run.out).toContain(`failing on: ${failOn}`);
    }
  });

  it('CLI · mcp lint · a server with no tools exits 3: nothing measured, not clean (AC-5)', async () => {
    const run = await lint({ mode: 'empty' });
    expect(run.code).toBe(3);
    expect(run.out).toContain('Nothing measured: the server lists no tools.');
  });

  it('CLI · mcp lint · tools/list is read to its last page', async () => {
    const { code, report } = await json({ mode: 'paged' });
    expect(code).toBe(0);
    expect(report.toolCount).toBe(2);
    expect(report.listing).toEqual({ state: 'passed', pages: 2 });
  });

  it('CLI · mcp lint · a list that never ends stops at the page limit as could-not-run, exit 3', async () => {
    const { code, report } = await json({ mode: 'forever', flags: { failOn: 'never' } });
    expect(code).toBe(3);
    expect(report.listing.state).toBe('could-not-run');
    expect(report.listing.pages).toBe(100);
  });

  it('CLI · mcp lint · Ukrainian descriptions written well give no findings (AC-10)', async () => {
    const { code, report } = await json({ mode: 'ukrainian' });
    expect(report.toolCount).toBe(5);
    expect(report.findings).toEqual([]);
    expect(code).toBe(0);
  });
});

describe('CLI · mcp lint · a server that does not start', () => {
  it('CLI · mcp lint · a command that does not exist exits 2 (AC-4)', async () => {
    const run = await lint({ server: ['plune-no-such-server-command'] });
    expect(run.code).toBe(2);
    expect(run.err).toMatch(/server/i);
    expect(run.out).toBe('');
  });

  it('CLI · mcp lint · a server that exits before initialize: exit 2, its stderr tail, no secret (AC-4)', async () => {
    const run = await lint({ mode: 'crash', flags: { env: ['API_TOKEN=lint-secret-token-1234'] } });
    expect(run.code).toBe(2);
    expect(run.err).toContain('fatal: cannot open the database');
    expect(run.err).toContain('API_TOKEN=***');
    expect(run.err).not.toContain('lint-secret-token-1234');
  });
});

describe('CLI · mcp lint · flags', () => {
  it.each([
    [{ failOn: 'fatal' }, '--fail-on'],
    [{ format: 'xml' }, '--format'],
    [{ callLimit: '0' }, '--call-limit'],
    [{ callTimeout: 'soon' }, '--call-timeout'],
  ] as [McpLintFlags, string][])(
    'CLI · mcp lint · a wrong %o is a usage error, exit 2',
    async (flags, name) => {
      const run = await lint({ mode: 'clean', flags });
      expect(run.code).toBe(2);
      expect(run.err).toContain(name);
    },
  );

  it('CLI · mcp lint · no server named is a usage error, exit 2', async () => {
    const run = await lint();
    expect(run.code).toBe(2);
    expect(run.err).toContain('Name a server');
  });
});

describe('CLI · mcp lint · the exceptions file', () => {
  const write = (body: string) => {
    const dir = tmp();
    writeFileSync(join(dir, 'plune-mcp-ignore.yaml'), body);
    return dir;
  };

  it('CLI · mcp lint · an entry without a reason exits 2 with its line (AC-6)', async () => {
    const cwd = write(
      'ignore:\n  - rule: desc-missing\n    tool: broken\n  - rule: annotations-missing\n    reason: "  "\n',
    );
    const run = await lint({ mode: 'mixed', cwd });
    expect(run.code).toBe(2);
    expect(run.err).toContain('plune-mcp-ignore.yaml:2');
    expect(run.err).toContain('plune-mcp-ignore.yaml:4');
    expect(run.err).toMatch(/reason/);
    expect(run.out).toBe('');
  });

  it('CLI · mcp lint · an entry with a reason suppresses the finding, and json keeps it with the reason (AC-6)', async () => {
    const cwd = write(
      'ignore:\n  - rule: input-schema-not-object\n    tool: broken\n    reason: "Fixed in the next release."\n    expires: 2026-12-31\n',
    );
    const { code, report } = await json({ mode: 'mixed', cwd });
    expect(code).toBe(0);
    expect(ids(report)).toEqual(['warn desc-missing broken', 'info annotations-missing broken']);
    expect(report.suppressed).toEqual([
      expect.objectContaining({
        rule: 'input-schema-not-object',
        target: { tool: 'broken' },
        reason: 'Fixed in the next release.',
        expires: '2026-12-31',
      }),
    ]);
    expect(report.counts).toEqual({ error: 0, warn: 1, info: 1, suppressed: 1 });
    const human = await lint({ mode: 'mixed', cwd });
    expect(human.out).toContain('0 errors, 1 warning, 1 info, 1 suppressed · failing on: error');
  });

  it('CLI · mcp lint · an entry without tool covers the rule on every tool', async () => {
    const cwd = write(
      'ignore:\n  - rule: input-schema-not-object\n    reason: "Our client sends no arguments."\n',
    );
    const { code, report } = await json({ mode: 'mixed', cwd });
    expect(code).toBe(0);
    expect(report.suppressed.map((s) => s.rule)).toEqual(['input-schema-not-object']);
  });

  it('CLI · mcp lint · an expired entry does not apply and is warned about (AC-6)', async () => {
    const cwd = write(
      'ignore:\n  - rule: input-schema-not-object\n    tool: broken\n    reason: "Until the fix."\n    expires: 2026-11-09\n',
    );
    const run = await lint({ mode: 'mixed', cwd });
    expect(run.code).toBe(1);
    expect(run.out).toContain(
      'warning: plune-mcp-ignore.yaml:2: the exception for input-schema-not-object on broken expired on 2026-11-09 and no longer applies.',
    );
    const { report } = await json({ mode: 'mixed', cwd });
    expect(report.exceptions.expired).toEqual([
      { rule: 'input-schema-not-object', tool: 'broken', line: 2, expires: '2026-11-09' },
    ]);
    expect(report.suppressed).toEqual([]);
  });

  it('CLI · mcp lint · an entry that matched nothing is named stale (AC-6)', async () => {
    const cwd = write('ignore:\n  - rule: desc-short\n    tool: gone_tool\n    reason: "Old."\n');
    const run = await lint({ mode: 'clean', cwd });
    expect(run.code).toBe(0);
    expect(run.out).toContain(
      'stale: plune-mcp-ignore.yaml:2: the exception for desc-short on gone_tool matched no finding.',
    );
    const { report } = await json({ mode: 'clean', cwd });
    expect(report.exceptions.stale).toEqual([{ rule: 'desc-short', tool: 'gone_tool', line: 2 }]);
  });

  it('CLI · mcp lint · --ignore-file that does not exist exits 2; a malformed file exits 2 with its line', async () => {
    const missing = await lint({ mode: 'clean', flags: { ignoreFile: 'nope.yaml' } });
    expect(missing.code).toBe(2);
    expect(missing.err).toContain('nope.yaml');
    const cwd = write('ignore:\n  - rule: desc-short\n    reason: "x"\n    expires: next week\n');
    const bad = await lint({ mode: 'clean', cwd });
    expect(bad.code).toBe(2);
    expect(bad.err).toContain('plune-mcp-ignore.yaml:2');
    expect(bad.err).toContain('expires');
  });
});

describe('CLI · mcp lint · --call', () => {
  it('CLI · mcp lint · only read-only, non-destructive tools are called; each result rule finds its case (AC-7)', async () => {
    const log = join(tmp(), 'calls.log');
    const { code, report } = await json({
      mode: 'calls',
      flags: { call: true, env: [`FIXTURE_CALL_LOG=${log}`] },
    });
    const called = readFileSync(log, 'utf8').trim().split('\n').sort();
    expect(called).toEqual(['read_bad_struct', 'read_big', 'read_dup', 'read_error', 'read_ok']);
    expect(report.calls?.skipped).toEqual([
      { tool: 'write_note', reason: 'not-read-only' },
      { tool: 'read_wipe', reason: 'destructive' },
    ]);
    const callFindings = report.findings
      .filter((f) => f.rule.startsWith('call-'))
      .map((f) => `${f.rule} ${f.target.tool}`);
    expect(callFindings.sort()).toEqual([
      'call-error-no-text read_error',
      'call-output-schema-mismatch read_bad_struct',
      'call-result-large read_big',
      'call-structured-duplicates-text read_dup',
    ]);
    expect(report.calls?.called.find((c) => c.tool === 'read_ok')).toEqual({
      tool: 'read_ok',
      state: 'passed',
    });
    expect(report.calls?.called.find((c) => c.tool === 'read_big')).toEqual({
      tool: 'read_big',
      state: 'failed',
    });
    expect(code).toBe(1);
  });

  it('CLI · mcp lint · without --call nothing is called; --call-limit bounds the calls', async () => {
    const log = join(tmp(), 'calls.log');
    await lint({ mode: 'calls', flags: { env: [`FIXTURE_CALL_LOG=${log}`] } });
    expect(existsSync(log)).toBe(false);
    const { report } = await json({
      mode: 'calls',
      flags: { call: true, callLimit: '2', env: [`FIXTURE_CALL_LOG=${log}`] },
    });
    expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual(['read_ok', 'read_big']);
    expect(
      report.calls?.skipped.filter((s) => s.reason === 'call-limit').map((s) => s.tool),
    ).toEqual(['read_error', 'read_dup', 'read_bad_struct']);
  });

  it('CLI · mcp lint · the human report says what was called and what was skipped and why', async () => {
    const run = await lint({ mode: 'calls', flags: { call: true } });
    expect(run.out).toMatch(/^ {2}called +read_ok +passed$/m);
    expect(run.out).toMatch(/^ {2}skipped +write_note +not-read-only$/m);
    expect(run.out).toMatch(/^ {2}skipped +read_wipe +destructive$/m);
  });

  it('CLI · mcp lint · a call that times out is could-not-run, and no call done exits 3 (AC-8)', async () => {
    const { code, report } = await json({
      mode: 'hang',
      flags: { call: true, callTimeout: '300ms' },
    });
    expect(report.calls?.called).toEqual([
      {
        tool: 'read_slow',
        state: 'could-not-run',
        reason: 'no answer within --call-timeout (300ms)',
      },
    ]);
    expect(report.findings).toEqual([]);
    expect(code).toBe(3);
  });

  it('CLI · mcp lint · --call with no tool safe to call exits 3', async () => {
    const run = await lint({ mode: 'heuristic', flags: { call: true } });
    expect(run.code).toBe(3);
    expect(run.out).toContain('Nothing measured: --call found no tool it may call.');
    expect(run.out).toMatch(/^ {2}skipped +notes_get +required-arguments$/m);
  });
});

describe('CLI · mcp lint · output', () => {
  it('CLI · mcp lint · --format json is one JSON document, the same bytes on a second run (AC-9)', async () => {
    const first = await lint({ mode: 'mixed', flags: { format: 'json' } });
    const second = await lint({ mode: 'mixed', flags: { format: 'json' } });
    expect(first.out).toBe(second.out);
    expect(first.out.endsWith('}\n')).toBe(true);
    const report = JSON.parse(first.out) as McpReport;
    expect(report).toMatchObject({
      schemaVersion: 1,
      command: 'lint',
      server: { name: 'lint-mixed', version: '1.2.3' },
      transport: 'stdio',
      toolCount: 3,
      failOn: 'error',
      counts: { error: 1, warn: 1, info: 1, suppressed: 0 },
      calls: null,
      exitCode: 1,
    });
    expect(Object.keys(report.findings[0]!)).toEqual([
      'rule',
      'class',
      'level',
      'state',
      'target',
      'message',
      'expected',
      'actual',
      'fix',
      'specRef',
    ]);
    expect(first.out).not.toMatch(/"(ts|time|date|at)"/);
  });

  it('CLI · mcp lint · server text with control characters cannot start a line or carry them (AC-11)', async () => {
    for (const format of ['human', 'json']) {
      const run = await lint({ mode: 'control', flags: { format, showInfo: true } });
      expect(run.out).toContain('x?::error::boom');
      for (const line of run.out.split('\n')) {
        expect(line.startsWith('::')).toBe(false);
        expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
      }
    }
  });

  it('CLI · mcp lint · --list-rules prints every rule of the module and connects to nothing (AC-15)', async () => {
    const platform = await serve(recorder());
    const run = await lint({
      flags: { listRules: true, format: 'json', url: `${platform.origin}/mcp` },
    });
    expect(run.code).toBe(0);
    const catalog = JSON.parse(run.out) as {
      schemaVersion: number;
      rules: { id: string; description: string }[];
    };
    expect(catalog.schemaVersion).toBe(1);
    expect(catalog.rules.map((r) => r.id)).toEqual([...LINT_RULES, ...CALL_RULES].map((r) => r.id));
    expect(catalog.rules.every((r) => r.description.length > 0)).toBe(true);
    expect(platform.requests).toEqual([]);
    const human = await lint({ flags: { listRules: true } });
    expect(human.code).toBe(0);
    expect(human.out).toMatch(/^input-schema-not-object +deterministic +error +/m);
  });

  it('CLI · mcp lint · needs no Plune login and never calls the platform (AC-16)', async () => {
    vi.stubEnv('PLUNE_TOKEN', '');
    const home = tmp();
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    const platform = await serve(recorder());
    vi.stubEnv('PLUNE_API_URL', platform.origin);
    const open = await lint({ mode: 'mixed', flags: { format: 'json' } });
    vi.stubEnv('PLUNE_API_URL', 'http://127.0.0.1:9');
    const closed = await lint({ mode: 'mixed', flags: { format: 'json' } });
    expect(closed).toEqual(open);
    expect(open.code).toBe(1);
    expect(platform.requests).toEqual([]);
  });

  it('CLI · mcp lint · plune mcp lint is wired: flags reach the command and its code becomes the exit code', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const before = process.exitCode;
    try {
      await createProgram().parseAsync(['mcp', 'lint', '--list-rules', '--format', 'json'], {
        from: 'user',
      });
      expect(process.exitCode).toBe(0);
      const printed = write.mock.calls.map((c) => String(c[0])).join('');
      expect((JSON.parse(printed) as { rules: unknown[] }).rules).toHaveLength(
        LINT_RULES.length + CALL_RULES.length,
      );
      await createProgram().parseAsync(
        ['mcp', 'lint', '--format', 'json', '--', process.execPath, FIXTURE, 'empty'],
        { from: 'user' },
      );
      expect(process.exitCode).toBe(3);
    } finally {
      write.mockRestore();
      process.exitCode = before;
    }
  });

  it('CLI · mcp lint · no heuristic rule reports at error, so the default --fail-on error never fails on advice', () => {
    const heuristic = [...LINT_RULES, ...CALL_RULES].filter((r) => r.class === 'heuristic');
    expect(heuristic.length).toBeGreaterThan(0);
    expect(heuristic.filter((r) => r.level === 'error').map((r) => r.id)).toEqual([]);
  });

  it('CLI · mcp lint · THIRD_PARTY_NOTICES is at the root and in the package files (AC-12)', () => {
    const root = new URL('../../../', import.meta.url);
    const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')) as {
      files: string[];
    };
    expect(pkg.files).toContain('THIRD_PARTY_NOTICES');
    expect(existsSync(new URL('THIRD_PARTY_NOTICES', root))).toBe(true);
  });
});
