// The report formats of `plune mcp lint`, `check` and `diff` (src/mcp-testing/report/): the flags, the JSON documents,
// GitHub annotations, Markdown and JUnit XML, against the fixture servers of ./fixtures as real processes and against
// runs built by hand where a server cannot send the input (a raw new line reaches no renderer from a server).

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import { handleMcpCheck, type McpCheckFlags } from '../../cli/commands/mcp-check.js';
import { handleMcpDiff, type McpDiffFlags } from '../../cli/commands/mcp-diff.js';
import { handleMcpLint, type McpLintFlags } from '../../cli/commands/mcp-lint.js';
import { handleMcpSnapshot } from '../../cli/commands/mcp-snapshot.js';
import { readJUnit } from '../../importers/junit.js';
import { parseXml } from '../../importers/xml.js';
import { noCommands } from '../report/human.js';
import {
  ANNOTATION_LIMITS,
  MARKDOWN_ROWS,
  render,
  writeReport,
  type McpRun,
  type ReportCheck,
} from '../report/index.js';
import { markdownCell } from '../snapshot/index.js';
import { LEGACY_STDERR } from './fixtures/lint-server.mjs';
import type { McpCheckReport, McpReport } from '../result.js';
import { generateReports, REPORT_FIXTURES } from './fixtures/reports/generate.js';

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const LINT = [process.execPath, fixture('lint-server.mjs')];
const CHECK = [process.execPath, fixture('check-server.mjs')];
const SNAPSHOT = [process.execPath, fixture('snapshot-server.mjs')];
const RAW = [process.execPath, fixture('raw-stdio.mjs')];
const REPORTS = fixture('reports');
const GOLDEN = join(REPORTS, 'golden-v1');

const tmp = () => mkdtempSync(join(tmpdir(), 'plune-report-'));

const servers: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

/**
 * A Streamable HTTP server that repeats the Authorization header it was sent: in a tool's description and in the
 * error a call of that tool gets.
 */
async function echoServer(): Promise<string> {
  const http: HttpServer = createServer((req, res) => {
    const said = String(req.headers['authorization'] ?? '');
    const server = new Server({ name: 'echo', version: '1.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: [
        {
          name: 'read_echo',
          description: `Reads with ${said}. Do not use it to write.`,
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          annotations: { readOnlyHint: true, destructiveHint: false },
        },
      ],
    }));
    server.setRequestHandler(CallToolRequestSchema, () => {
      throw new McpError(-32603, `refused ${said}`);
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    void server.connect(transport).then(() => transport.handleRequest(req, res));
  });
  await new Promise<void>((done) => http.listen(0, '127.0.0.1', done));
  servers.push({
    close: () =>
      new Promise<void>((done) => {
        http.closeAllConnections();
        http.close(() => done());
      }),
  });
  return `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`;
}

let generated: Promise<{ dir: string; codes: Record<string, number> }> | undefined;
/** The JUnit fixtures written again by the commands as they are now, once for this file. */
const fresh = () =>
  (generated ??= (async () => {
    const dir = tmp();
    return { dir, codes: await generateReports(dir) };
  })());

interface Run {
  code: number;
  out: string;
  err: string;
}

const sink = () => {
  const s = { out: '', err: '' };
  return {
    s,
    io: (env: NodeJS.ProcessEnv, cwd: string) => ({
      out: (t: string) => (s.out += t),
      err: (t: string) => (s.err += t),
      env,
      cwd,
      clientVersion: '9.9.9',
      today: '2026-11-10',
    }),
  };
};

/** `base` and `mode` start the server; an empty `base` starts nothing (a server at --url). */
const command = (base: string[], mode: string) => (base.length === 0 ? [] : [...base, mode]);

async function lint(
  mode: string,
  flags: McpLintFlags = {},
  env: NodeJS.ProcessEnv = {},
  cwd = tmp(),
  base = LINT,
): Promise<Run> {
  const { s, io } = sink();
  const code = await handleMcpLint({ timeout: '20s', ...flags }, command(base, mode), io(env, cwd));
  return { code, ...s };
}

async function check(
  mode: string,
  flags: McpCheckFlags = {},
  env: NodeJS.ProcessEnv = {},
  base = CHECK,
): Promise<Run> {
  const { s, io } = sink();
  const code = await handleMcpCheck(
    { timeout: '20s', ...flags },
    command(base, mode),
    io(env, tmp()),
  );
  return { code, ...s };
}

/** A snapshot of the fixture in `full` mode, then `diff` of it against the fixture live in `mode`. */
async function diff(
  mode: string,
  flags: McpDiffFlags = {},
  cwd = tmp(),
  env: NodeJS.ProcessEnv = {},
  base = SNAPSHOT,
): Promise<Run> {
  if (!existsSync(join(cwd, 'base.json'))) {
    const taken = sink();
    await handleMcpSnapshot(
      { timeout: '20s', out: 'base.json' },
      [...SNAPSHOT, 'full'],
      taken.io({}, cwd),
    );
    expect(existsSync(join(cwd, 'base.json')), taken.s.err).toBe(true);
  }
  const { s, io } = sink();
  const code = await handleMcpDiff(
    { timeout: '20s', ...flags },
    { baseline: 'base.json', server: command(base, mode) },
    io(env, cwd),
  );
  return { code, ...s };
}

/** Two snapshots that hold nothing: nothing to compare, exit 3. */
async function emptyDiff(flags: McpDiffFlags): Promise<Run> {
  const cwd = tmp();
  const empty = {
    kind: 'plune-mcp-snapshot',
    schemaVersion: 2,
    transport: 'stdio',
    server: null,
    instructions: null,
    capabilities: {},
    tools: null,
    resources: null,
    resourceTemplates: null,
    prompts: null,
  };
  writeFileSync(join(cwd, 'e.json'), JSON.stringify(empty));
  const { s, io } = sink();
  const code = await handleMcpDiff(
    { ...flags },
    { baseline: 'e.json', current: 'e.json', server: [] },
    io({}, cwd),
  );
  return { code, ...s };
}

/** `classname#name` → the status word our reader gives. */
const statuses = (xml: string) =>
  Object.fromEntries(readJUnit(xml, 'r.xml').map((r) => [r.keys[0]?.value, r.rawStatus]));

const XML_FORBIDDEN =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

const make = (over: Partial<ReportCheck>): ReportCheck => ({
  id: 'c',
  title: 'a check',
  target: '',
  state: 'passed',
  class: 'deterministic',
  level: 'error',
  message: 'seen',
  expected: 'e',
  actual: 'a',
  fix: 'f',
  specRef: '',
  durationMs: null,
  ...over,
});
const runOf = (checks: ReportCheck[], cases = [...new Set(checks.map((c) => c.id))]): McpRun => ({
  command: 'lint',
  document: { exitCode: 1 } as McpReport,
  cases: cases.map((id) => ({ id, title: id })),
  checks,
  nothing: '',
  showInfo: true,
});

describe('CLI · mcp report · flags', () => {
  const commands: [string, (flags: Record<string, unknown>) => Promise<Run>][] = [
    ['lint', (f) => lint('clean', f as McpLintFlags)],
    ['check', (f) => check('healthy', f as McpCheckFlags)],
    ['diff', (f) => diff('full', f as McpDiffFlags)],
  ];

  it.each([
    [{ format: 'xml' }, '--format must be one of human, json, github, markdown (got "xml").'],
    [{ reporter: 'xunit', out: 'r.xml' }, '--reporter must be one of junit-xml (got "xunit").'],
    [{ out: 'html=r.html' }, '--out must be one of json, junit-xml, markdown (got "html").'],
    [{ out: ['json=a.json', 'markdown='] }, '--out markdown=: the file name is missing.'],
    [{ reporter: 'junit-xml' }, '--reporter junit-xml writes a file: give it --out <path>.'],
  ])(
    'CLI · mcp report · %o is exit 2 with the same words on lint, check and diff (AC-1)',
    async (flags, words) => {
      for (const [name, run] of commands) {
        const r = await run(flags);
        expect([r.code, r.err, r.out]).toEqual([2, `plune mcp ${name}: ${words}\n`, '']);
      }
    },
  );

  it('CLI · mcp report · lint, check and diff take every --format, --reporter junit-xml and three --out in one run (AC-1)', async () => {
    for (const [name, run] of commands) {
      for (const format of ['human', 'json', 'github', 'markdown']) {
        const dir = tmp();
        const out = [
          `json=${join(dir, 'r.json')}`,
          `junit-xml=${join(dir, 'r.xml')}`,
          `markdown=${join(dir, 'r.md')}`,
        ];
        const r = await run({ format, out });
        expect(r.code, `${name} ${format}: ${r.err}`).toBe(0);
        expect(r.out).not.toBe('');
        expect(readdirSync(dir).sort()).toEqual(['r.json', 'r.md', 'r.xml']);
        expect(readFileSync(join(dir, 'r.md'), 'utf8')).toMatch(
          new RegExp(`^<!-- plune-mcp-${name} -->\n`),
        );
      }
      const dir = tmp();
      const r = await run({ reporter: 'junit-xml', out: join(dir, 'bare.xml') });
      expect(r.code).toBe(0);
      expect(
        readJUnit(readFileSync(join(dir, 'bare.xml'), 'utf8'), 'bare.xml').length,
      ).toBeGreaterThan(0);
    }
  }, 60_000);

  it('CLI · mcp report · three --out under --smoke and --call connect once: every tool is called once (AC-1)', async () => {
    const dir = tmp();
    const out = (n: string) => [
      `json=${join(dir, `${n}.json`)}`,
      `junit-xml=${join(dir, `${n}.xml`)}`,
      `markdown=${join(dir, `${n}.md`)}`,
    ];
    const checkLog = join(dir, 'check.log');
    await check('smoke', { smoke: true, out: out('check'), env: [`FIXTURE_CALL_LOG=${checkLog}`] });
    const lintLog = join(dir, 'lint.log');
    await lint('calls', { call: true, out: out('lint'), env: [`FIXTURE_CALL_LOG=${lintLog}`] });
    for (const log of [checkLog, lintLog]) {
      const called = readFileSync(log, 'utf8').trim().split('\n');
      expect(called.length).toBeGreaterThan(1);
      expect(new Set(called).size).toBe(called.length);
    }
    expect(
      readdirSync(dir)
        .filter((f) => !f.endsWith('.log'))
        .sort(),
    ).toEqual(['check.json', 'check.md', 'check.xml', 'lint.json', 'lint.md', 'lint.xml']);
  }, 30_000);
});

describe('CLI · mcp report · json', () => {
  /** Timing is the one field two runs differ in; zero in the golden document. */
  const steady = (text: string) => {
    const doc = JSON.parse(text) as Record<string, unknown>;
    if (doc['kind'] === 'mcp-check-report') {
      const t = (doc as unknown as McpCheckReport).timing;
      doc['timing'] = {
        totalMs: 0,
        checks: t.checks.map((c) => ({ ...c, ms: 0 })),
        calls: t.calls.map((c) => ({ ...c, ms: 0 })),
      };
    }
    return doc;
  };

  it('CLI · mcp report · each command prints one document with kind and an integer schemaVersion, the golden document of version 1 (AC-2)', async () => {
    const runs = {
      lint: await lint('mixed', { format: 'json' }),
      check: await check('smoke', { format: 'json', smoke: true }),
      diff: await diff('empty', { format: 'json' }),
    };
    for (const [name, r] of Object.entries(runs)) {
      const doc = steady(r.out);
      expect(Object.keys(doc).slice(0, 3)).toEqual(['kind', 'schemaVersion', 'command']);
      expect(doc['kind']).toBe(`mcp-${name}-report`);
      expect(Number.isInteger(doc['schemaVersion'])).toBe(true);
      const golden = join(GOLDEN, `${name}.json`);
      if (process.env['PLUNE_UPDATE_GOLDEN'] === '1')
        writeFileSync(golden, `${JSON.stringify(doc, null, 2)}\n`);
      // Every field of version 1, and nothing renamed: removing or renaming a field turns this red.
      expect(doc).toEqual(JSON.parse(readFileSync(golden, 'utf8')));
    }
  }, 30_000);

  it('CLI · mcp report · the rule catalog names its kind too', async () => {
    const { s, io } = sink();
    await handleMcpLint({ listRules: true, format: 'json' }, [], io({}, tmp()));
    expect(JSON.parse(s.out)).toMatchObject({ kind: 'mcp-lint-rules', schemaVersion: 1 });
  });
});

describe('CLI · mcp report · junit-xml', () => {
  it('CLI · mcp report · every state reads back through readJUnit as the table says (AC-3, AC-4)', () => {
    const run = runOf([
      make({ id: 'passed', state: 'passed' }),
      make({ id: 'failed', state: 'failed' }),
      make({ id: 'could-not-run', state: 'could-not-run' }),
      make({ id: 'could-not-run-heuristic', state: 'could-not-run', class: 'heuristic' }),
      make({ id: 'not-applicable', state: 'not-applicable' }),
      make({ id: 'pending', state: 'pending' }),
      make({ id: 'advice', state: 'failed', class: 'heuristic', level: 'warn', advisory: true }),
      make({ id: 'heuristic-at-fail-on', state: 'failed', class: 'heuristic', level: 'warn' }),
      make({ id: 'below-fail-on', state: 'failed', level: 'info', advisory: true }),
      make({ id: 'worst-wins', state: 'failed' }),
      make({ id: 'worst-wins', state: 'could-not-run' }),
    ]);
    const xml = render(run, 'junit-xml');
    expect(statuses(xml)).toEqual({
      'mcp.lint#passed': 'pass',
      'mcp.lint#failed': 'failure',
      'mcp.lint#could-not-run': 'error',
      'mcp.lint#could-not-run-heuristic': 'error',
      'mcp.lint#not-applicable': 'skipped',
      'mcp.lint#pending': 'skipped',
      'mcp.lint#advice': 'skipped',
      'mcp.lint#heuristic-at-fail-on': 'failure',
      'mcp.lint#below-fail-on': 'skipped',
      'mcp.lint#worst-wins': 'error',
    });
    expect(xml).toContain('<error type="could-not-run" message="could-not-run: seen">');
    expect(xml).toContain('<skipped type="not-applicable" message="not-applicable: seen">');
    expect(xml).toContain('<skipped type="pending" message="pending: seen">');
    expect(xml).toContain('<skipped type="advisory" message="advisory: seen">');
  });

  it('CLI · mcp report · could-not-run is an error on every command, never a pass or skipped (AC-4)', async () => {
    const { dir } = await fresh();
    const read = (file: string) => statuses(readFileSync(join(dir, file), 'utf8'));
    const hang = read('lint-hang.xml');
    for (const id of [
      'call-result-large',
      'call-error-no-text',
      'call-structured-duplicates-text',
      'call-output-schema-mismatch',
    ])
      expect(hang[`mcp.lint#${id}`]).toBe('error');
    expect(read('check-hang.xml')).toMatchObject({
      'mcp.check#tools-list': 'error',
      'mcp.check#ping': 'pass',
    });
    expect(read('lint-empty.xml')).toEqual({ 'mcp.lint#run': 'error' });
  }, 120_000);

  it('CLI · mcp report · the fixtures read as their runs said: failures, skips and passes by case (AC-3)', async () => {
    const { dir } = await fresh();
    const read = (file: string) => statuses(readFileSync(join(dir, file), 'utf8'));
    expect(read('lint-mixed.xml')).toMatchObject({
      'mcp.lint#tools-list': 'pass',
      'mcp.lint#input-schema-not-object': 'failure',
      // A warning and an info finding are below the default --fail-on error: advice.
      'mcp.lint#desc-missing': 'skipped',
      'mcp.lint#annotations-missing': 'skipped',
      'mcp.lint#call-result-large': 'skipped',
    });
    expect(
      Object.values(read('lint-clean.xml')).filter((s) => s !== 'pass' && s !== 'skipped'),
    ).toEqual([]);
    expect(read('check-broken.xml')).toMatchObject({
      'mcp.check#resources-list': 'failure',
      'mcp.check#smoke': 'skipped',
    });
    expect(read('check-smoke.xml')).toMatchObject({
      'mcp.check#smoke': 'failure',
      'mcp.check#prompts-list': 'skipped',
    });
    expect(read('diff-breaking.xml')).toEqual({
      'mcp.diff#breaking-changes': 'failure',
      // The default --fail-on breaking: every change listed again, as advice.
      'mcp.diff#contract-changes': 'skipped',
      'mcp.diff#unclassified-changes': 'pass',
      'mcp.diff#security-signals': 'pass',
    });
    expect(Object.values(read('diff-same.xml'))).toEqual(['pass', 'pass', 'pass', 'pass']);
    expect(read('conformance-bad.xml')).toMatchObject({
      'mcp.conformance.protocol#life-ping-empty-result': 'failure',
      // A failed SHOULD is advice; a check for the other era does not apply; no --fixture is an input not given.
      'mcp.conformance.protocol#tools-name-format': 'skipped',
      'mcp.conformance.protocol#tools-list-order-stable': 'skipped',
      'mcp.conformance.protocol#tools-structured-conformant': 'error',
    });
    expect(read('conformance-silent.xml')).toMatchObject({
      'mcp.conformance.protocol#life-initialize-result': 'pass',
      'mcp.conformance.protocol#life-ping-empty-result': 'error',
    });
  }, 120_000);

  it('CLI · mcp report · the set of classname#name is the same whatever the server found, its name or its times (AC-5)', async () => {
    const { dir } = await fresh();
    const keys = (file: string) =>
      Object.keys(statuses(readFileSync(join(dir, file), 'utf8'))).sort();
    for (const group of [
      ['lint-clean.xml', 'lint-mixed.xml', 'lint-heuristic.xml', 'lint-hang.xml'],
      ['check-healthy.xml', 'check-broken.xml', 'check-hang.xml', 'check-smoke.xml'],
      ['diff-breaking.xml', 'diff-same.xml'],
      ['conformance-bad.xml', 'conformance-silent.xml'],
    ]) {
      const first = keys(group[0] ?? '');
      expect(first.length).toBeGreaterThan(2);
      for (const file of group.slice(1)) expect(keys(file), file).toEqual(first);
    }
  }, 120_000);

  it('CLI · mcp report · a run with nothing measured is one case "run" that could not run, exit 3 (AC-6)', async () => {
    const dir = tmp();
    for (const [code, file] of [
      [
        (await lint('empty', { reporter: 'junit-xml', out: join(dir, 'lint.xml') })).code,
        'lint.xml',
      ],
      [(await emptyDiff({ reporter: 'junit-xml', out: join(dir, 'diff.xml') })).code, 'diff.xml'],
    ] as const) {
      expect(code).toBe(3);
      const results = readJUnit(readFileSync(join(dir, file), 'utf8'), file);
      expect(results.map((r) => [r.keys[0]?.value, r.rawStatus])).toEqual([
        [`mcp.${file.slice(0, -4)}#run`, 'error'],
      ]);
      expect(results[0]?.errorContext).toContain('could-not-run');
    }
  });

  it('CLI · mcp report · characters XML 1.0 does not allow are removed, the rest escaped: the file parses (AC-7)', () => {
    const name = 'x\u0000y\u001b<a&b"c\uffff\ud800>\udfff';
    const xml = render(
      runOf([make({ id: name, state: 'failed', target: name, message: name })]),
      'junit-xml',
    );
    expect(xml).not.toMatch(XML_FORBIDDEN);
    expect(() => parseXml(xml, 'r.xml')).not.toThrow();
    expect(readJUnit(xml, 'r.xml')[0]?.keys[0]?.value).toBe('mcp.lint#xy<a&b"c>');
  });

  it('CLI · mcp report · the fixtures are what the commands write today: generating again gives the same bytes (AC-10)', async () => {
    const { dir, codes } = await fresh();
    expect(codes).toMatchObject({
      'lint-clean.xml': 0,
      'lint-mixed.xml': 1,
      'lint-hang.xml': 3,
      'lint-empty.xml': 3,
      'check-hang.xml': 3,
      'diff-breaking.xml': 1,
      'conformance-bad.xml': 1,
      'conformance-silent.xml': 3,
    });
    for (const f of REPORT_FIXTURES)
      expect(readFileSync(join(dir, f.file), 'utf8'), f.file).toBe(
        readFileSync(join(REPORTS, f.file), 'utf8'),
      );
    expect(readFileSync(join(REPORTS, 'README.md'), 'utf8')).toContain(
      'node node_modules/tsx/dist/cli.mjs src/mcp-testing/__tests__/fixtures/reports/generate.ts',
    );
  }, 120_000);
});

describe('CLI · mcp report · a rule that could not run', () => {
  it('CLI · mcp report · a pairwise rule past its tool limit, with no target, is an error in its own case and a warning annotation', async () => {
    const dir = tmp();
    const run = await lint('many', {
      format: 'github',
      out: [
        `junit-xml=${join(dir, 'r.xml')}`,
        `markdown=${join(dir, 'r.md')}`,
        `json=${join(dir, 'r.json')}`,
      ],
    });
    const report = JSON.parse(readFileSync(join(dir, 'r.json'), 'utf8')) as McpReport;
    const unrun = report.findings.filter((f) => f.state === 'could-not-run');
    expect(unrun.map((f) => [f.rule, f.target.tool])).toEqual([
      ['tools-similar', ''],
      ['desc-no-when-not', ''],
    ]);
    const xml = readFileSync(join(dir, 'r.xml'), 'utf8');
    expect(statuses(xml)).toMatchObject({
      'mcp.lint#tools-similar': 'error',
      'mcp.lint#desc-no-when-not': 'error',
      'mcp.lint#list-size': 'skipped',
    });
    expect(xml).toMatch(
      /<error type="could-not-run" message="could-not-run: too many tools to compare pairwise/,
    );
    for (const rule of ['tools-similar', 'desc-no-when-not'])
      expect(run.out).toMatch(
        new RegExp(`^::warning title=could not run%3A ${rule}::too many tools`, 'm'),
      );
    expect(readFileSync(join(dir, 'r.md'), 'utf8')).toMatch(
      /^\| could-not-run \| warn \| tools-similar \| {2}\| /m,
    );
  }, 60_000);
});

describe('CLI · mcp report · github', () => {
  const annotations = (out: string) => out.split('\n').filter((l) => l.startsWith('::'));

  it('CLI · mcp report · the message and the properties are escaped as the runner reads them: one line per annotation (AC-9)', () => {
    const out = render(
      runOf([
        make({
          id: 'rule:a,b',
          target: 'tool',
          state: 'failed',
          message: '50% done\r\n::error::second',
        }),
      ]),
      'github',
    );
    const lines = annotations(out);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      /^::error title=rule%3Aa%2Cb tool::tool: 50%25 done%0D%0A::error::second%0Aexpected: e%0Aactual: a%0Afix: f$/,
    );
  });

  it('CLI · mcp report · past the limit per step: the first ten of each kind, then one line with the rest (AC-9)', () => {
    const out = render(
      runOf([
        ...Array.from({ length: 25 }, (_, i) => make({ id: `e${i}`, state: 'failed' })),
        ...Array.from({ length: 3 }, (_, i) =>
          make({ id: `w${i}`, state: 'failed', level: 'warn' }),
        ),
        make({ id: 'n', state: 'failed', level: 'info' }),
        make({ id: 'p', state: 'passed' }),
      ]),
      'github',
    );
    expect(ANNOTATION_LIMITS).toEqual({ error: 10, warning: 10, notice: 10 });
    const lines = annotations(out);
    expect(lines.filter((l) => l.startsWith('::error '))).toHaveLength(10);
    expect(lines.filter((l) => l.startsWith('::warning '))).toHaveLength(3);
    expect(lines.filter((l) => l.startsWith('::notice '))).toHaveLength(1);
    expect(out).toContain(
      '\n15 more in the report: GitHub keeps 10 error and 10 warning annotations per step.\n',
    );
  });

  it('CLI · mcp report · check --format github against a broken server: an error annotation, exit 1', async () => {
    const r = await check('resources-error', { format: 'github' });
    expect(r.code).toBe(1);
    expect(annotations(r.out)).toEqual([
      expect.stringMatching(
        /^::error title=resources-list::resources\/list answered with a JSON-RPC error/,
      ),
    ]);
  });
});

describe('CLI · mcp report · safety', () => {
  it('CLI · mcp report · a hostile tool name breaks no format: the XML parses, github has one line per annotation, human has no control character (AC-7)', async () => {
    const dir = tmp();
    const outs = {
      out: [
        `junit-xml=${join(dir, 'r.xml')}`,
        `markdown=${join(dir, 'r.md')}`,
        `json=${join(dir, 'r.json')}`,
      ],
    };
    const xmlRun = await lint('xml', { ...outs, showInfo: true });
    const xml = readFileSync(join(dir, 'r.xml'), 'utf8');
    expect(xml).not.toMatch(XML_FORBIDDEN);
    expect(() => parseXml(xml, 'r.xml')).not.toThrow();
    expect(xml).toContain('x?y?&lt;a&amp;b"c::error::x?::error::y');
    const report = JSON.parse(readFileSync(join(dir, 'r.json'), 'utf8')) as McpReport;
    expect(report.findings.length).toBeGreaterThan(0);

    const github = await lint('xml', { format: 'github', showInfo: true });
    const commandLines = github.out.split('\n').filter((l) => l.trimStart().startsWith('::'));
    expect(commandLines).toHaveLength(report.findings.length);
    for (const l of commandLines) expect(l).toMatch(/^::(error|warning|notice) title=[^:]*::/);

    for (const text of [
      xmlRun.out,
      (await lint('xml', { format: 'markdown', showInfo: true })).out,
      (await lint('xml', { format: 'json' })).out,
      readFileSync(join(dir, 'r.md'), 'utf8'),
    ]) {
      expect(text).not.toMatch(CONTROL);
      for (const line of text.split('\n')) expect(line.trimStart().startsWith('::')).toBe(false);
    }
  }, 30_000);

  it('CLI · mcp report · a secret from --env is in no format and no --out file, byte for byte (AC-8)', async () => {
    const token = 'report-secret-token-4321';
    const dir = tmp();
    const outs = (n: string) => [
      `json=${join(dir, `${n}.json`)}`,
      `junit-xml=${join(dir, `${n}.xml`)}`,
      `markdown=${join(dir, `${n}.md`)}`,
    ];
    const printed: string[] = [];
    for (const format of ['human', 'json', 'github', 'markdown']) {
      const l = await lint('secret', {
        format,
        call: true,
        showInfo: true,
        out: outs(`lint-${format}`),
        env: [`API_TOKEN=${token}`],
      });
      printed.push(l.out, l.err);
      const c = await check('stderr-token', {
        format,
        smoke: true,
        out: outs(`check-${format}`),
        env: [`API_TOKEN=${token}`],
      });
      printed.push(c.out, c.err);
    }
    const diffDir = tmp();
    for (const format of ['human', 'json', 'github', 'markdown']) {
      const d = await diff(
        'argv',
        { format, out: outs(`diff-${format}`), env: [`API_KEY=${token}`] },
        diffDir,
      );
      printed.push(d.out, d.err);
    }
    const files = readdirSync(dir);
    expect(files).toHaveLength(36);
    for (const text of [...printed, ...files.map((f) => readFileSync(join(dir, f), 'utf8'))])
      expect(text).not.toContain(token);
    // The secret was there to leak: masked where the servers sent it.
    expect(printed.join('')).toContain('read_***');
  }, 60_000);

  it('CLI · mcp report · no XML or JUnit package was added (AC-12)', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
    ) as Record<string, Record<string, string> | undefined>;
    const names = Object.keys({
      ...pkg['dependencies'],
      ...pkg['devDependencies'],
      ...pkg['optionalDependencies'],
    });
    expect(names.filter((n) => /xml|junit/i.test(n))).toEqual([]);
  });
});

describe('CLI · mcp report · workflow commands', () => {
  const NEL = String.fromCharCode(0x85);

  it('CLI · mcp report · noCommands also trims NEL, as the runner does, before it looks for ::', () => {
    expect(noCommands(` ${NEL}::error::x\n\t::warning::y`)).toBe(
      ` ${NEL}?::error::x\n\t?::warning::y`,
    );
  });

  it('CLI · mcp report · the older ##[ form is neutralized anywhere: every format, every --out file and stderr; json parses back to the same text', async () => {
    const leaks: string[] = [];
    for (const [name, run] of [
      ['lint', (format: string, out: string[]) => lint('legacy', { format, out, showInfo: true })],
      ['check', (format: string, out: string[]) => check('legacy', { format, out }, {}, LINT)],
    ] as const) {
      for (const format of ['human', 'json', 'github', 'markdown']) {
        const dir = tmp();
        const out = ['json', 'junit-xml', 'markdown'].map((f) => `${f}=${join(dir, `r.${f}`)}`);
        const r = await run(format, out);
        expect(r.code, `${name} ${format}: ${r.err}`).not.toBe(2);
        leaks.push(
          r.out,
          r.err,
          ...readdirSync(dir).map((f) => readFileSync(join(dir, f), 'utf8')),
        );
        if (format === 'json') {
          const doc = JSON.parse(r.out) as Record<string, unknown>;
          const file = JSON.parse(readFileSync(join(dir, 'r.json'), 'utf8')) as Record<
            string,
            unknown
          >;
          expect(file).toEqual(doc);
          if (name === 'lint') {
            const report = doc as unknown as McpReport;
            expect(report.server?.name).toBe('srv ##[set-output name=x;]y');
            expect(report.findings.map((f) => f.target.tool)).toContain('a##[set-output name=x;]y');
          } else expect((doc as unknown as McpCheckReport).stderrTail).toContain(LEGACY_STDERR);
        }
      }
    }
    const crash = await lint('legacy-crash');
    expect(crash.code).toBe(2);
    expect(crash.err).toContain('warming up ##?[stop-commands]t');
    leaks.push(crash.out, crash.err);
    for (const text of leaks) expect(text).not.toContain('##[');
  }, 60_000);
});

describe('CLI · mcp report · outputs', () => {
  it('CLI · mcp report · 140 000 findings: every --out is written, the markdown table is cut with a count of the rest', async () => {
    const dir = tmp();
    const out = ['json=r.json', 'markdown=r.md', 'junit-xml=r.xml'];
    const r = await lint('bare', { format: 'markdown', out }, {}, dir, RAW);
    expect([r.code, r.err]).toEqual([3, '']);
    expect(readdirSync(dir).sort()).toEqual(['r.json', 'r.md', 'r.xml']);
    const report = JSON.parse(readFileSync(join(dir, 'r.json'), 'utf8')) as McpReport;
    const rows = r.out.split('\n').filter((l) => /^\| (failed|could-not-run|pending) /.test(l));
    expect(rows).toHaveLength(MARKDOWN_ROWS);
    const shown = report.findings.filter((f) => f.level !== 'info' || f.state === 'could-not-run');
    expect(r.out).toContain(`… and ${shown.length - MARKDOWN_ROWS} more in the full report.`);
    expect(readFileSync(join(dir, 'r.md'), 'utf8')).toBe(r.out);
    expect(() => readJUnit(readFileSync(join(dir, 'r.xml'), 'utf8'), 'r.xml')).not.toThrow();
  }, 120_000);

  it('CLI · mcp report · two --out naming one file, or a folder, are exit 2 before the server is started, and nothing is written', async () => {
    const dir = tmp();
    mkdirSync(join(dir, 'adir'));
    const log = join(dir, 'started.log');
    const never = [
      process.execPath,
      '-e',
      `require('fs').writeFileSync(${JSON.stringify(log)}, 'x')`,
    ];
    const cases: [string[], string][] = [
      [
        ['json=r.out', 'junit-xml=r.out'],
        '--out junit-xml=r.out: the same file as --out json=r.out.',
      ],
      [['json=a.json', 'junit-xml=adir'], '--out junit-xml=adir: a folder, not a file.'],
      [['json=nope/x.json'], '--out json=nope/x.json: the folder nope does not exist.'],
    ];
    if (process.platform === 'win32')
      cases.push([
        ['json=r.out', 'markdown=R.OUT'],
        '--out markdown=R.OUT: the same file as --out json=r.out.',
      ]);
    for (const [out, words] of cases) {
      const { s, io } = sink();
      const code = await handleMcpLint({ timeout: '20s', out }, never, io({}, dir));
      expect([code, s.err]).toEqual([2, `plune mcp lint: ${words}\n`]);
    }
    expect(readdirSync(dir)).toEqual(['adir']);
  });

  it('CLI · mcp report · a report that cannot be built writes no file and says so', () => {
    const dir = tmp();
    const document = { exitCode: 0 } as Record<string, unknown>;
    document['self'] = document;
    const run = { ...runOf([make({})]), document: document as unknown as McpReport };
    const outputs = {
      format: 'human' as const,
      files: [
        { format: 'markdown' as const, path: 'a.md' },
        { format: 'json' as const, path: 'b.json' },
      ],
    };
    expect(() => writeReport(run, outputs, { out: () => {}, err: () => {}, cwd: dir })).toThrow(
      /^could not build the json report \(.+\); no file was written\.$/,
    );
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe('CLI · mcp report · the exit code and the JUnit file agree', () => {
  /** 1 exactly when a case failed; 3 when none failed and one could not run; 0 when neither. */
  const agree = (code: number, file: string, what: string) => {
    const states = Object.values(statuses(readFileSync(file, 'utf8')));
    expect(code, `${what}: ${states.join(' ')}`).toBe(
      states.includes('failure') ? 1 : states.includes('error') ? 3 : 0,
    );
    expect([0, 1, 3]).toContain(code);
  };

  it.each(['error', 'warn', 'info', 'never'])(
    'CLI · mcp report · lint --fail-on %s, on every fixture',
    async (failOn) => {
      for (const [mode, flags] of [
        ['clean', {}],
        ['mixed', {}],
        ['heuristic', {}],
        ['hang', { call: true, callTimeout: '300ms' }],
        ['calls', { call: true }],
        ['deep', {}],
        ['empty', {}],
      ] as const) {
        const dir = tmp();
        const r = await lint(mode, { ...flags, failOn, out: ['junit-xml=r.xml'] }, {}, dir);
        agree(r.code, join(dir, 'r.xml'), `lint ${mode} --fail-on ${failOn}`);
      }
    },
    60_000,
  );

  it('CLI · mcp report · check, on every fixture', async () => {
    for (const [mode, flags] of [
      ['healthy', {}],
      ['resources-error', {}],
      ['hang-tools', { checkTimeout: '300ms' }],
      ['smoke', { smoke: true }],
      ['tools-only', { smoke: true }],
    ] as const) {
      const dir = tmp();
      const r = await check(mode, { ...flags, out: [`junit-xml=${join(dir, 'r.xml')}`] });
      agree(r.code, join(dir, 'r.xml'), `check ${mode}`);
    }
  }, 60_000);

  it.each(['breaking', 'any', 'none'])(
    'CLI · mcp report · diff --fail-on %s, on every fixture',
    async (failOn) => {
      const cwd = tmp();
      for (const mode of ['full', 'empty', 'argv']) {
        const r = await diff(mode, { failOn, out: ['junit-xml=r.xml'] }, cwd);
        agree(r.code, join(cwd, 'r.xml'), `diff ${mode} --fail-on ${failOn}`);
      }
      const nothing = await emptyDiff({ failOn, out: [`junit-xml=${join(cwd, 'e.xml')}`] });
      agree(nothing.code, join(cwd, 'e.xml'), `diff of two empty snapshots --fail-on ${failOn}`);
    },
    60_000,
  );

  it('CLI · mcp report · diff --fail-on any fails the contract-changes case on any change, only then', async () => {
    const cwd = tmp();
    const read = () => statuses(readFileSync(join(cwd, 'r.xml'), 'utf8'));
    expect((await diff('argv', { failOn: 'any', out: ['junit-xml=r.xml'] }, cwd)).code).toBe(1);
    expect(read()).toMatchObject({
      'mcp.diff#contract-changes': 'failure',
      'mcp.diff#breaking-changes': 'pass',
    });
    expect((await diff('argv', { failOn: 'breaking', out: ['junit-xml=r.xml'] }, cwd)).code).toBe(
      0,
    );
    expect(read()).toMatchObject({ 'mcp.diff#contract-changes': 'skipped' });
    expect((await diff('full', { failOn: 'any', out: ['junit-xml=r.xml'] }, cwd)).code).toBe(0);
    expect(read()).toMatchObject({ 'mcp.diff#contract-changes': 'pass' });
  }, 60_000);
});

describe('CLI · mcp report · markdown cells', () => {
  it('CLI · mcp report · server text in a table cell mentions nobody and links nothing', () => {
    const cell = markdownCell('@team see [x](https://e.example) ![i](https://e.example/i.png) #12');
    // What is left once the character references are taken out holds none of them.
    expect(cell.replace(/&#?[0-9a-z]+;/g, '')).not.toMatch(/[@[\]!#]/);
    expect(cell).toContain('&#64;team see &#91;x&#93;(https://e.example) &#33;&#91;i&#93;');
    expect(cell).toContain('&#35;12');
  });
});

describe('CLI · mcp report · a secret in a header', () => {
  it('CLI · mcp report · a header value the server repeats in a description and an error is in no format and no --out file (AC-8)', async () => {
    const secret = 'Bearer header-secret-value-7788';
    const url = await echoServer();
    const dir = tmp();
    const printed: string[] = [];
    const flags = { url, headerEnv: ['Authorization=MCP_AUTH'] };
    const env = { MCP_AUTH: secret };
    for (const format of ['human', 'json', 'github', 'markdown']) {
      const out = (n: string) =>
        ['json', 'junit-xml', 'markdown'].map((f) => `${f}=${join(dir, `${n}-${format}.${f}`)}`);
      const runs = [
        await lint(
          '',
          { ...flags, call: true, showInfo: true, format, out: out('lint') },
          env,
          dir,
          [],
        ),
        await check('', { ...flags, smoke: true, format, out: out('check') }, env, []),
        await diff('', { ...flags, format, out: out('diff') }, dir, env, []),
      ];
      for (const r of runs) {
        expect(r.code, r.err).not.toBe(2);
        printed.push(r.out, r.err);
      }
    }
    const files = readdirSync(dir).filter((f) => f !== 'base.json');
    expect(files).toHaveLength(36);
    for (const text of [...printed, ...files.map((f) => readFileSync(join(dir, f), 'utf8'))]) {
      expect(text).not.toContain('header-secret-value-7788');
    }
    expect(printed.join('')).toContain('***');
  }, 60_000);
});
