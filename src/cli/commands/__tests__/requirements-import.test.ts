import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProgram } from '../../../cli.js';
import {
  buildImportBody,
  formatDiscover,
  formatReport,
  handleRequirementsImport,
  parseMap,
  reportRequirementsImportFailure,
  RequirementsImportError,
  type DiscoverResult,
  type ImportReport,
} from '../requirements-import.js';

const TOKEN = 'plune_secret_do_not_leak';
const MD = '# Billing SRS\n\n## 3. Functional requirements\n\n| ID | Requirement | Priority |\n|----|---|---|\n| REQ-1 | Sign in | Critical |\n';

const DISCOVER: DiscoverResult = {
  frontmatter: { keys: ['title'], title: 'Billing SRS' },
  sections: [
    { index: 0, heading: 'Billing SRS', level: 1, line: 1, bulletCount: 0, subheadingCount: 1 },
    { index: 1, heading: '3. Functional requirements', level: 2, line: 3, bulletCount: 4, subheadingCount: 0 },
  ],
  tables: [
    { index: 0, line: 5, heading: '3. Functional requirements', headers: ['ID', 'Requirement', 'Priority'], rowCount: 2, firstRows: [], looksLikeRequirements: true },
    { index: 1, line: 20, heading: null, headers: ['A', 'B'], rowCount: 1, firstRows: [], looksLikeRequirements: false },
  ],
  truncated: false,
};

const REPORT: ImportReport = {
  dryRun: true,
  applied: false,
  mode: 'table',
  summary: { create: 1, update: 1, unchanged: 1, skip: 1 },
  items: [
    { line: 7, action: 'create', key: 'REQ-1', title: 'Sign in', reason: 'new' },
    { line: 8, action: 'update', key: 'REQ-2', title: 'Export', reason: 'matched by key', changes: ['priority'] },
    { line: 9, action: 'unchanged', key: 'REQ-3', title: 'Same', reason: 'matched by key' },
    { line: 10, action: 'skip', key: null, title: 'Broken', reason: 'ragged row: 2 cells, the table has 3', notes: ['unknown category'] },
  ],
  values: { priority: [{ value: 'Critical', count: 1, mappedTo: 'Must-have' }, { value: 'Odd', count: 2, mappedTo: null }], category: [] },
  notImported: {
    frontmatterKeys: ['version'],
    tables: [{ index: 1, heading: 'Glossary', headers: ['Term', 'Meaning'], rowCount: 4 }],
    sections: [{ index: 2, heading: 'Risks', level: 3, bulletCount: 2 }],
  },
};

interface Call { method: string; path: string; body: Record<string, unknown> | undefined; auth: string | null }
type Handler = (body: Record<string, unknown> | undefined) => [number, unknown, Record<string, string>?];

/** The fake platform: routes by `METHOD path`, records every request. An unknown route answers a bare 404, as an older platform would. */
function platform(routes: Record<string, Handler>) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: u.pathname, body, auth: new Headers(init?.headers).get('authorization') });
    const h = routes[`${method} ${u.pathname}`];
    if (h === undefined) return new Response('404 Not Found', { status: 404 });
    const [status, json, headers] = h(body);
    return new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json', ...headers } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

/** The same fake on a real socket, for the program, which talks through node:http like production. */
async function serve(routes: Record<string, Handler>): Promise<{ url: string; calls: Call[]; server: Server }> {
  const calls: Call[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString('utf8')));
    req.on('end', () => {
      const body = raw === '' ? undefined : JSON.parse(raw);
      calls.push({ method: req.method ?? '', path: req.url ?? '', body, auth: req.headers.authorization ?? null });
      const h = routes[`${req.method} ${req.url}`];
      if (h === undefined) return void res.writeHead(404).end('404 Not Found');
      const [status, json] = h(body);
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(json));
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, calls, server };
}

const P = '/v1/projects/p1/requirements/import';
const projects: Handler = () => [200, { projects: [{ id: 'p1', name: 'default' }] }];

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'plune-reqimp-'));
  file = join(dir, 'srs.md');
  writeFileSync(file, MD);
});

const run = (fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) =>
  handleRequirementsImport({ file, apiUrl: 'https://api.test', loadToken: () => TOKEN, fetchImpl, ...extra });
const fails = async (p: Promise<unknown>): Promise<RequirementsImportError> => {
  const err = await p.then(() => undefined, (e: unknown) => e);
  expect(err).toBeInstanceOf(RequirementsImportError);
  return err as RequirementsImportError;
};

describe('flags → body', () => {
  it('no flag at all is the discover step', () => {
    expect(buildImportBody({})).toBeNull();
    expect(buildImportBody({ yes: false, json: true, project: 'p' })).toBeNull();
  });

  it('table flags map to the body keys of the endpoint', () => {
    expect(
      buildImportBody({
        table: '2', keyColumn: 'ID', textColumn: 'Requirement', descriptionColumn: 'D', priorityColumn: 'Priority', categoryColumn: 'Cat',
        typeColumn: 'T', statusColumn: 'S', criteriaColumn: 'AC', mapPriority: 'Critical=Must-have, High=Should-have', mapCategory: 'Quality=non-functional', type: 'feature',
      }),
    ).toEqual({
      mode: 'table', table: 2, keyColumn: 'ID', textColumn: 'Requirement', descriptionColumn: 'D', priorityColumn: 'Priority', categoryColumn: 'Cat',
      typeColumn: 'T', statusColumn: 'S', acceptanceCriteriaColumn: 'AC', priorityMap: { Critical: 'Must-have', High: 'Should-have' },
      categoryMap: { Quality: 'non-functional' }, defaultType: 'feature',
    });
  });

  it('sections flags map to the body keys; a number stays a number, a heading a string', () => {
    expect(buildImportBody({ sections: 'Requirements', unit: 'bullets', keyPrefix: 'REQ-', priorityFrom: 'subheading', type: 'user_story' })).toEqual({
      mode: 'sections', section: 'Requirements', unit: 'bullets', keyPrefix: 'REQ-', priorityFrom: 'subheading', defaultType: 'user_story',
    });
    expect(buildImportBody({ sections: '3' })).toEqual({ mode: 'sections', section: 3 });
  });

  it.each([
    [{ table: '0', sections: 'X', titleColumn: 'T' }, /--table or --sections, not both/],
    [{ table: '0', titleColumn: 'T', textColumn: 'R' }, /--title-column or --text-column, not both/],
    [{ table: '0', keyColumn: 'ID' }, /needs --title-column/],
    [{ table: 'one', titleColumn: 'T' }, /number of the table/],
    [{ table: '0', titleColumn: 'T', unit: 'bullets' }, /--unit is for --sections/],
    [{ sections: 'X', keyColumn: 'ID' }, /--key-column is for --table/],
    [{ sections: 'X', mapCategory: 'a=b' }, /--map-category is for --table/],
    [{ keyColumn: 'ID' }, /need --table <n>/],
    [{ mapPriority: 'a=b' }, /need --table <n>/],
    [{ sections: 'X', unit: 'rows' }, /--unit must be bullets or subheadings/],
    [{ sections: 'X', priorityFrom: 'heading' }, /--priority-from must be subheading/],
    [{ sections: 'X', type: 'bug' }, /--type must be user_story or feature or epic/],
    [{ sections: '  ' }, /--sections needs/],
  ] as const)('refuses %j locally', (flags, message) => {
    let err: unknown;
    try {
      buildImportBody(flags);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(RequirementsImportError);
    expect((err as RequirementsImportError).message).toMatch(message);
    expect((err as RequirementsImportError).exitCode).toBe(2);
  });

  it('parses value maps and refuses a pair without "="', () => {
    expect(parseMap('--map-priority', 'a=b,c = d')).toEqual({ a: 'b', c: 'd' });
    expect(() => parseMap('--map-priority', 'a')).toThrow(/not Value=Value/);
    expect(() => parseMap('--map-priority', '=b')).toThrow(/not Value=Value/);
    expect(() => parseMap('--map-priority', ' , ')).toThrow(/empty/);
  });
});

describe('the discover step', () => {
  it('posts only the markdown, to the project found from the token, and prints both shapes with the marker', async () => {
    const fake = platform({ 'GET /v1/projects': projects, [`POST ${P}/discover`]: () => [200, DISCOVER] });
    const res = await run(fake.fetchImpl);
    expect(res.step).toBe('discover');
    const post = fake.calls.find((c) => c.method === 'POST')!;
    expect(post.body).toEqual({ markdown: MD });
    expect(post.auth).toBe(`Bearer ${TOKEN}`);

    const text = formatDiscover('srs.md', DISCOVER);
    expect(text).toContain('srs.md: 2 tables, 2 sections');
    expect(text).toContain('Frontmatter keys: title');
    expect(text).toContain('#0  line 5  "3. Functional requirements"  ID | Requirement | Priority  2 rows   <- looks like requirements');
    expect(text).toContain('#1  line 20  (no heading)  A | B  1 row');
    expect(text.split('\n').find((l) => l.includes('#1  line 20'))).not.toContain('looks like');
    expect(text).toContain('#1  line 3  ## 3. Functional requirements  4 bullets, 0 sub-headings');
    expect(text).toContain('#0  line 1  # Billing SRS  0 bullets, 1 sub-heading');
    expect(text).toContain('plune requirements import srs.md --table <n> --key-column <header> --title-column <header>');
    expect(text).toContain('plune requirements import srs.md --sections <heading|n>');
  });

  it('--project skips the lookup', async () => {
    const fake = platform({ [`POST ${P}/discover`]: () => [200, DISCOVER] });
    await run(fake.fetchImpl, { project: 'p1' });
    expect(fake.calls.map((c) => `${c.method} ${c.path}`)).toEqual([`POST ${P}/discover`]);
  });

  it('asks for --project when the account has several, and names them', async () => {
    const fake = platform({ 'GET /v1/projects': () => [200, { projects: [{ id: 'a', name: 'One' }, { id: 'b', name: 'Two' }] }] });
    const err = await fails(run(fake.fetchImpl));
    expect(err.message).toMatch(/2 projects \(a \(One\), b \(Two\)\).*--project <id>/);
    expect(err.exitCode).toBe(2);
    expect(fake.calls).toHaveLength(1);
  });
});

describe('the import step', () => {
  const mapping = { table: '0', keyColumn: 'ID', textColumn: 'Requirement', priorityColumn: 'Priority', mapPriority: 'Critical=Must-have' };

  it('is a dry run unless --yes: sends dryRun:true and the mapping, and prints the report', async () => {
    const fake = platform({ 'GET /v1/projects': projects, [`POST ${P}`]: () => [200, REPORT] });
    const res = await run(fake.fetchImpl, mapping);
    expect(res.step).toBe('import');
    const body = fake.calls.find((c) => c.path === P)!.body;
    expect(body).toEqual({
      markdown: MD, dryRun: true, mode: 'table', table: 0, keyColumn: 'ID', textColumn: 'Requirement', priorityColumn: 'Priority',
      priorityMap: { Critical: 'Must-have' },
    });
    expect(fake.calls.some((c) => c.body?.['dryRun'] === false)).toBe(false);

    const text = formatReport(REPORT);
    expect(text.split('\n')[0]).toBe('create 1 · update 1 · unchanged 1 · skip 1');
    expect(text).toContain('create (1)\n  line 7  REQ-1  Sign in  - new');
    expect(text).toContain('update (1)\n  line 8  REQ-2  Export  - matched by key; changes: priority');
    expect(text).toContain('skip (1)\n  line 10  -  Broken  - ragged row: 2 cells, the table has 3; note: unknown category');
    expect(text).toContain('unchanged (1)');
    expect(text).toContain('Priority values\n  Critical  x1  -> Must-have\n  Odd  x2  -> (no mapping: kept as written)');
    expect(text).toContain('Not imported\n  table #1 "Glossary" (Term | Meaning; 4 rows)\n  section #2 "Risks" (2 bullets)\n  frontmatter keys: version');
    expect(text.trimEnd().split('\n').pop()).toBe('dry run — nothing was written; add --yes to apply');
  });

  it('--yes sends dryRun:false and says it was applied', async () => {
    const applied: ImportReport = { ...REPORT, dryRun: false, applied: true };
    const fake = platform({ 'GET /v1/projects': projects, [`POST ${P}`]: () => [200, applied] });
    const res = await run(fake.fetchImpl, { ...mapping, yes: true });
    expect(fake.calls.find((c) => c.path === P)!.body?.['dryRun']).toBe(false);
    const text = formatReport((res as { report: ImportReport }).report);
    expect(text).toContain('applied — 1 requirement created, 1 updated.');
    expect(text).not.toContain('add --yes');
  });

  it('sections mode posts the section and unit', async () => {
    const fake = platform({ 'GET /v1/projects': projects, [`POST ${P}`]: () => [200, { ...REPORT, mode: 'sections' }] });
    await run(fake.fetchImpl, { sections: 'Requirements', unit: 'bullets' });
    expect(fake.calls.find((c) => c.path === P)!.body).toEqual({ markdown: MD, dryRun: true, mode: 'sections', section: 'Requirements', unit: 'bullets' });
  });

  it('caps a long group and points at --json', () => {
    const items = Array.from({ length: 60 }, (_, i) => ({ line: i + 1, action: 'unchanged' as const, key: `R-${i}`, title: 't', reason: 'matched by key' }));
    const text = formatReport({ ...REPORT, items, summary: { create: 0, update: 0, unchanged: 60, skip: 0 } });
    expect(text).toContain('... and 10 more (--json lists every row)');
  });
});

describe('refused before any request', () => {
  it('a file over 1 MiB', async () => {
    writeFileSync(file, 'x'.repeat(1_048_577));
    const fake = platform({});
    const err = await fails(run(fake.fetchImpl));
    expect(err.message).toMatch(/1048577 bytes; the platform reads at most 1048576 bytes \(1 MiB\)\. Nothing was sent/);
    expect(err.exitCode).toBe(2);
    expect(fake.calls).toHaveLength(0);
  });

  it('a missing, empty or non-UTF-8 file, and a bad flag combination', async () => {
    const fake = platform({});
    expect((await fails(run(fake.fetchImpl, { file: join(dir, 'nope.md') }))).message).toMatch(/File not found/);
    writeFileSync(file, '  \n');
    expect((await fails(run(fake.fetchImpl))).message).toMatch(/is empty/);
    writeFileSync(file, Buffer.from([0xff, 0xfe, 0x41, 0xc3, 0x28]));
    expect((await fails(run(fake.fetchImpl))).message).toMatch(/not valid UTF-8/);
    writeFileSync(file, MD);
    expect((await fails(run(fake.fetchImpl, { table: '0', sections: 'X' }))).message).toMatch(/not both/);
    expect(fake.calls).toHaveLength(0);
  });

  it('no token', async () => {
    const fake = platform({});
    const err = await fails(run(fake.fetchImpl, { loadToken: () => null }));
    expect(err.message).toMatch(/Not logged in/);
    expect(fake.calls).toHaveLength(0);
  });
});

describe('what the platform answers', () => {
  const sections = { sections: 'Requirements' };
  const answer = (status: number, json: unknown, headers?: Record<string, string>) =>
    platform({ 'GET /v1/projects': projects, [`POST ${P}`]: () => [status, json, headers] });

  it('404 from a platform without the routes is one clear message', async () => {
    const fake = platform({ 'GET /v1/projects': projects }); // the routes are not there: a bare 404
    const err = await fails(run(fake.fetchImpl, sections));
    expect(err.message).toMatch(/^This platform does not support requirements import yet\./);
    expect(err.exitCode).toBe(1);
    const json404 = answer(404, { error: 'not found' });
    expect((await fails(run(json404.fetchImpl, sections))).message).toMatch(/does not support requirements import yet/);
    const disc = platform({ 'GET /v1/projects': projects });
    expect((await fails(run(disc.fetchImpl))).message).toMatch(/does not support requirements import yet/);
  });

  it("404 naming the project is about the project (a token of another project), not the platform", async () => {
    const err = await fails(run(answer(404, { error: "project 'p1' not found" }).fetchImpl, sections));
    expect(err.message).toMatch(/Project p1 was not found for this token.*--project/);
    expect(err.message).not.toMatch(/does not support/);
  });

  it.each([
    [401, { error: 'bad' }, /token was rejected/, 2],
    [403, { error: 'read-only member' }, /refused: read-only member\. Importing needs an owner or a member/, 1],
    [409, { error: "requirement key 'REQ-1' is taken" }, /taken by another change while the import ran\. Nothing was written; run it again \(requirement key 'REQ-1' is taken\)/, 1],
    [413, { error: 'at most 2000 requirements' }, /too large \(at most 2000 requirements\)\. Nothing was written/, 1],
    [400, { error: "unknown column 'Foo'; the headers are ID, Requirement" }, /refused the mapping \(unknown column 'Foo'; the headers are ID, Requirement\)/, 1],
  ] as const)('%i is a message and an exit code, not a stack', async (status, json, message, exitCode) => {
    const err = await fails(run(answer(status, json).fetchImpl, sections));
    expect(err.message).toMatch(message);
    expect(err.exitCode).toBe(exitCode);
  });

  it('a quota 429 is read by its body and not retried', async () => {
    const fake = answer(429, { error: 'too many', quota: { kind: 'imports', used: 5, limit: 5 } }, { 'retry-after': '1' });
    const err = await fails(run(fake.fetchImpl, sections));
    expect(err.message).toMatch(/quota exceeded \(imports: 5 of 5 used\)/);
    expect(fake.calls.filter((c) => c.path === P)).toHaveLength(1);
  });

  it('an unreachable platform', async () => {
    const down = (async () => {
      throw new Error(`connect ECONNREFUSED ${TOKEN}`);
    }) as unknown as typeof fetch;
    const err = await fails(handleRequirementsImport({ file, apiUrl: 'https://api.test', loadToken: () => TOKEN, fetchImpl: down, project: 'p1'}));
    expect(err.exitCode).toBe(1);
  }, 20_000);

  it('the token never reaches a message, even when the far side echoes it', async () => {
    const err = await fails(run(answer(400, { error: `bad Authorization: Bearer ${TOKEN}` }).fetchImpl, sections));
    expect(err.message).not.toContain(TOKEN);
    expect(err.message).toContain('***');
  });

  it('maps a failure to a stderr line and the exit code; others are not ours', () => {
    const lines: string[] = [];
    expect(reportRequirementsImportFailure(new RequirementsImportError('x', 2), (s) => lines.push(s))).toBe(2);
    expect(lines).toEqual(['x\n']);
    expect(reportRequirementsImportFailure(new Error('boom'), (s) => lines.push(s))).toBeNull();
  });
});

describe('through the program (stdout, stderr, exit code)', () => {
  let out: string;
  let errOut: string;
  let live: Server | undefined;
  beforeEach(() => {
    out = '';
    errOut = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((s: string | Uint8Array) => ((out += String(s)), true));
    vi.spyOn(process.stderr, 'write').mockImplementation((s: string | Uint8Array) => ((errOut += String(s)), true));
    process.exitCode = undefined;
    vi.stubEnv('PLUNE_TOKEN', TOKEN);
    vi.stubEnv('PLUNE_PROJECT', 'p1');
  });
  afterEach(() => {
    live?.close();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    process.exitCode = undefined;
  });
  const start = async (routes: Record<string, Handler>) => {
    const s = await serve(routes);
    live = s.server;
    vi.stubEnv('PLUNE_API_URL', s.url);
    return s.calls;
  };
  const cli = (...args: string[]) => createProgram().parseAsync(['node', 'plune', 'requirements', 'import', ...args]);

  it('discover → exit 0 with the hint; --json prints the raw answer', async () => {
    await start({ [`POST ${P}/discover`]: () => [200, DISCOVER] });
    await cli(file);
    expect(out).toContain('looks like requirements');
    expect(process.exitCode).toBeUndefined();
    out = '';
    await cli(file, '--json');
    expect(JSON.parse(out)).toEqual(DISCOVER);
  });

  it('a dry run with a skip exits 0; --yes sends dryRun:false; --json is the raw report', async () => {
    const calls = await start({ [`POST ${P}`]: (b) => [200, { ...REPORT, dryRun: b?.['dryRun'], applied: !b?.['dryRun'] }] });
    await cli(file, '--table', '0', '--text-column', 'Requirement', '--key-column', 'ID', '--map-priority', 'Critical=Must-have');
    expect(out).toContain('skip 1');
    expect(out).toContain('add --yes to apply');
    expect(process.exitCode).toBeUndefined();
    expect(calls[0]!.body?.['dryRun']).toBe(true);
    out = '';
    await cli(file, '--sections', 'Requirements', '--yes', '--json');
    expect(calls[1]!.body).toMatchObject({ dryRun: false, mode: 'sections', section: 'Requirements' });
    expect((JSON.parse(out) as ImportReport).applied).toBe(true);
    expect(out).not.toContain(TOKEN);
  });

  it('refusals exit non-zero on stderr and print no token', async () => {
    const calls = await start({});
    await cli(file, '--table', '0', '--sections', 'X');
    expect(errOut).toMatch(/not both/);
    expect(process.exitCode).toBe(2);
    expect(calls).toHaveLength(0);
    errOut = '';
    process.exitCode = undefined;
    await cli(file, '--sections', 'X');
    expect(errOut).toMatch(/does not support requirements import yet/);
    expect(process.exitCode).toBe(1);
    expect(out + errOut).not.toContain(TOKEN);
  });
});

describe('several tables in one run', () => {
  it('each --table spec becomes an entry of `tables`; shared maps stay top-level', () => {
    expect(
      buildImportBody({
        table: ['1:key=ID,text=Requirement,fixed-category=functional', '2: KEY = ID , title=Name, priority=Prio, criteria=Signal, fixed-type=user_story'],
        mapPriority: 'Must=High', mapCategory: 'Quality=non-functional', type: 'feature',
      }),
    ).toEqual({
      mode: 'table',
      priorityMap: { Must: 'High' },
      defaultType: 'feature',
      tables: [
        { table: 1, keyColumn: 'ID', textColumn: 'Requirement', fixedCategory: 'functional', categoryMap: { Quality: 'non-functional' } },
        { table: 2, keyColumn: 'ID', titleColumn: 'Name', priorityColumn: 'Prio', acceptanceCriteriaColumn: 'Signal', fixedType: 'user_story', categoryMap: { Quality: 'non-functional' } },
      ],
    });
  });

  it('a single spec with ":" is the new form; a bare number stays the old one', () => {
    expect(buildImportBody({ table: ['3:text=Req'] })).toEqual({ mode: 'table', tables: [{ table: 3, textColumn: 'Req' }] });
    expect(buildImportBody({ table: ['3'], textColumn: 'Req' })).toEqual({ mode: 'table', table: 3, textColumn: 'Req' });
  });

  it('refuses a mix of forms and bad specs before any request', () => {
    const bad = (f: Parameters<typeof buildImportBody>[0], re: RegExp) => expect(() => buildImportBody(f)).toThrow(re);
    bad({ table: ['1:text=A'], keyColumn: 'ID' }, /put the column inside each --table/);
    bad({ table: ['1:text=A', '2'] }, /not a table number|each table needs/);
    bad({ table: ['1:text=A', '1:text=B'] }, /given twice/);
    bad({ table: ['1:key=ID'] }, /needs title=<header> or text=<header>/);
    bad({ table: ['1:title=A,text=B'] }, /not both/);
    bad({ table: ['1:text=A,color=red'] }, /"color" is not a column name/);
    bad({ table: ['1:text=A,fixed-category=bogus'] }, /must be functional or non-functional or other/);
    bad({ table: ['1:text='] }, /has no value/);
    bad({ table: ['x:text=A'] }, /not a table number/);
    bad({ table: ['1:text=A'], sections: 'S' }, /not both/);
  });

  const tablesReport: ImportReport = {
    ...REPORT,
    summary: { create: 2, update: 0, unchanged: 0, skip: 2 },
    items: [
      { line: 7, action: 'create', key: 'FR-1', title: 'Sign in', reason: 'new', table: 1, tableHeading: 'Functional requirements' },
      { line: 20, action: 'create', key: 'NFR-1', title: 'Fast', reason: 'new', table: 2, tableHeading: null },
      { line: 8, action: 'skip', key: null, title: '[Behavior]', reason: 'template placeholder', table: 1, tableHeading: 'Functional requirements' },
      { line: 21, action: 'skip', key: 'FR-1', title: 'Again', reason: 'duplicate key: first on line 7, again on line 21', table: 2, tableHeading: null },
    ],
  };

  it('sends `tables`, never the top-level column fields, and the plan names the table of each row', async () => {
    const fake = platform({ 'GET /v1/projects': projects, [`POST ${P}`]: () => [200, tablesReport] });
    const res = await run(fake.fetchImpl, { table: ['1:key=ID,text=Requirement,fixed-category=functional', '2:key=ID,text=Requirement,fixed-category=non-functional'] });
    expect(fake.calls.find((c) => c.path === P)!.body).toEqual({
      markdown: MD, dryRun: true, mode: 'table',
      tables: [
        { table: 1, keyColumn: 'ID', textColumn: 'Requirement', fixedCategory: 'functional' },
        { table: 2, keyColumn: 'ID', textColumn: 'Requirement', fixedCategory: 'non-functional' },
      ],
    });
    expect(res.step).toBe('import');
    const text = formatReport(tablesReport);
    expect(text).toContain('table #1 "Functional requirements"  line 7  FR-1  Sign in  - new');
    expect(text).toContain('table #2  line 20  NFR-1  Fast  - new');
    expect(text).toContain('table #1 "Functional requirements"  line 8  -  [Behavior]  - template placeholder');
    expect(text).toContain('duplicate key: first on line 7, again on line 21');
    expect(text).not.toContain('empty template');
  });

  it('says so when the file is an empty template (and the rows without `table` print as before)', () => {
    const text = formatReport({ ...REPORT, summary: { create: 0, update: 0, unchanged: 0, skip: 2 }, emptyTemplate: true, message: 'this file is an empty template' });
    expect(text).toContain('this file is an empty template: every row is a placeholder, nothing to import.');
    expect(text).not.toMatch(/template\. this file/);
    expect(formatReport(REPORT)).toContain('create (1)\n  line 7  REQ-1');
  });

  it('through the program: repeated --table, empty template exits 0 and --json keeps the flag', async () => {
    let out = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((s: string | Uint8Array) => ((out += String(s)), true));
    process.exitCode = undefined;
    vi.stubEnv('PLUNE_TOKEN', TOKEN);
    vi.stubEnv('PLUNE_PROJECT', 'p1');
    const empty: ImportReport = { ...REPORT, summary: { create: 0, update: 0, unchanged: 0, skip: 1 }, items: [], emptyTemplate: true };
    const s = await serve({ [`POST ${P}`]: () => [200, empty] });
    vi.stubEnv('PLUNE_API_URL', s.url);
    try {
      const cli = (...args: string[]) => createProgram().parseAsync(['node', 'plune', 'requirements', 'import', file, ...args]);
      await cli('--table', '1:text=Requirement', '--table', '2:text=Requirement');
      expect(s.calls[0]!.body).toMatchObject({ tables: [{ table: 1 }, { table: 2 }], dryRun: true });
      expect(s.calls[0]!.body).not.toHaveProperty('table');
      expect(out).toContain('this file is an empty template');
      expect(process.exitCode).toBeUndefined();
      out = '';
      await cli('--table', '1:text=Requirement', '--table', '2:text=Requirement', '--json');
      expect((JSON.parse(out) as ImportReport).emptyTemplate).toBe(true);
    } finally {
      s.server.close();
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      process.exitCode = undefined;
    }
  });
});
