import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProgram } from '../../../cli.js';
import { RequirementsImportError, type DiscoverResult } from '../requirements-import.js';
import {
  buildLinksBody,
  formatLinks,
  formatLinksDiscover,
  handleRequirementsLinks,
  type LinksReport,
} from '../requirements-links.js';

const TOKEN = 'plune_secret_do_not_leak';
const MD = '| Req | Tests |\n|---|---|\n| REQ-1, REQ-2 | Sign in<br>e2e/a.spec.ts |\n| REQ-9 | Nope |\n';

const DISCOVER: DiscoverResult = {
  frontmatter: { keys: [], title: null },
  sections: [],
  tables: [{ index: 0, line: 1, heading: 'Matrix', headers: ['Req', 'Tests'], rowCount: 2, firstRows: [], looksLikeRequirements: false }],
  truncated: false,
};
const REPORT: LinksReport = {
  dryRun: true,
  applied: false,
  summary: { link: 1, unchanged: 1, unmatched: 1 },
  items: [
    { line: 3, action: 'link', key: 'REQ-1', test: 'Sign in', reason: 'new', requirementId: 'r1', caseId: 'c1' },
    { line: 3, action: 'unchanged', key: 'REQ-2', test: 'Sign in', reason: 'already linked' },
    { line: 4, action: 'unmatched', key: 'REQ-9', test: 'Nope', reason: "no requirement with key 'REQ-9'" },
  ],
};

type Handler = (body: Record<string, unknown> | undefined) => [number, unknown];
function platform(routes: Record<string, Handler>) {
  const calls: { method: string; path: string; body: Record<string, unknown> | undefined }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: u.pathname, body });
    const h = routes[`${method} ${u.pathname}`];
    if (h === undefined) return new Response('404 Not Found', { status: 404 });
    const [status, json] = h(body);
    return new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const P = '/v1/projects/p1/requirements/import';
const projects: Handler = () => [200, { projects: [{ id: 'p1' }] }];
const flags = { table: '0', requirementColumn: 'Req', testColumn: 'Tests' };

let file: string;
beforeEach(() => {
  file = join(mkdtempSync(join(tmpdir(), 'plune-links-')), 'matrix.md');
  writeFileSync(file, MD);
});
const run = (fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) =>
  handleRequirementsLinks({ file, apiUrl: 'https://api.test', loadToken: () => TOKEN, fetchImpl, ...extra });
const fails = async (p: Promise<unknown>): Promise<RequirementsImportError> => {
  const err = await p.then(() => undefined, (e: unknown) => e);
  expect(err).toBeInstanceOf(RequirementsImportError);
  return err as RequirementsImportError;
};

describe('flags → body', () => {
  it('no mapping flag is the discover step', () => {
    expect(buildLinksBody({})).toBeNull();
    expect(buildLinksBody({ yes: true, json: true, project: 'p' })).toBeNull();
  });
  it('maps to the body keys, separator only when given', () => {
    expect(buildLinksBody(flags)).toEqual({ table: 0, requirementColumn: 'Req', testColumn: 'Tests' });
    expect(buildLinksBody({ ...flags, separator: ';' })).toMatchObject({ requirementSeparator: ';' });
  });
  it.each([
    [{ requirementColumn: 'R' }, /need --table/],
    [{ table: 'x', requirementColumn: 'R', testColumn: 'T' }, /not "x"/],
    [{ table: '0', testColumn: 'T' }, /--requirement-column/],
    [{ table: '0', requirementColumn: 'R' }, /--test-column/],
    [{ ...flags, separator: '' }, /1 to 3/],
    [{ ...flags, separator: 'abcd' }, /1 to 3/],
  ])('refuses %j with exit 2', (f, msg) => {
    try {
      buildLinksBody(f);
      expect.unreachable();
    } catch (e) {
      expect((e as RequirementsImportError).exitCode).toBe(2);
      expect((e as Error).message).toMatch(msg);
    }
  });
});

describe('handleRequirementsLinks', () => {
  it('discovers the tables without mapping flags', async () => {
    const p = platform({ 'GET /v1/projects': projects, [`POST ${P}/discover`]: () => [200, DISCOVER] });
    const res = await run(p.fetchImpl);
    expect(res).toEqual({ step: 'discover', result: DISCOVER });
    expect(p.calls.at(-1)?.body).toEqual({ markdown: MD });
  });

  it('is a dry run by default and writes with yes', async () => {
    const p = platform({ 'GET /v1/projects': projects, [`POST ${P}/links`]: (b) => [200, { ...REPORT, dryRun: b?.['dryRun'] }] });
    await run(p.fetchImpl, flags);
    expect(p.calls.at(-1)?.body).toEqual({ markdown: MD, dryRun: true, table: 0, requirementColumn: 'Req', testColumn: 'Tests' });
    await run(p.fetchImpl, { ...flags, yes: true, separator: ';' });
    expect(p.calls.at(-1)?.body).toMatchObject({ dryRun: false, requirementSeparator: ';' });
  });

  it('sends nothing when the flags are wrong or the file is missing', async () => {
    const p = platform({});
    await fails(run(p.fetchImpl, { table: '0' }));
    await fails(run(p.fetchImpl, { ...flags, file: join(file, '..', 'none.md') }));
    expect(p.calls).toHaveLength(0);
  });

  it.each([
    [403, { error: 'read-only member' }, 1, /Importing needs an owner or a member/],
    [413, { error: 'too many rows' }, 1, /too large/],
    [400, { error: 'no column' }, 1, /refused the mapping \(.*no column/],
    [401, { error: 'x' }, 2, /rejected/],
  ])('HTTP %i is a message and exit %i, never a stack', async (status, body, code, msg) => {
    const p = platform({ 'GET /v1/projects': projects, [`POST ${P}/links`]: () => [status, body] });
    const err = await fails(run(p.fetchImpl, flags));
    expect(err.exitCode).toBe(code);
    expect(err.message).toMatch(msg);
    expect(err.message).not.toContain(TOKEN);
  });
});

describe('terminal', () => {
  it('lists unmatched first, with the reason, and says dry run', () => {
    const out = formatLinks(REPORT);
    expect(out.split('\n')[0]).toBe('link 1 · unchanged 1 · unmatched 1');
    expect(out.indexOf('unmatched (1)')).toBeLessThan(out.indexOf('link (1)'));
    expect(out).toContain("line 4  REQ-9  ->  Nope  - no requirement with key 'REQ-9'");
    expect(out).toContain('dry run — nothing was written; add --yes to apply');
  });
  it('says applied once written', () => {
    expect(formatLinks({ ...REPORT, dryRun: false, applied: true })).toContain('applied — 1 link created.');
  });
  it('the discover listing names the next command', () => {
    const out = formatLinksDiscover('m.md', DISCOVER);
    expect(out).toContain('#0  line 1  "Matrix"  Req | Tests  2 rows');
    expect(out).toContain('plune requirements links m.md --table <n> --requirement-column <header> --test-column <header>');
  });
});

describe('plune requirements links (the program)', () => {
  let out: string;
  let live: Server | undefined;
  beforeEach(() => {
    out = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((x: string | Uint8Array) => ((out += String(x)), true));
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
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
  const cli = async (...args: string[]) => {
    live = createServer((req, res) => {
      req.resume();
      req.on('end', () => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(REPORT)));
    });
    await new Promise<void>((ok) => live!.listen(0, '127.0.0.1', ok));
    vi.stubEnv('PLUNE_API_URL', `http://127.0.0.1:${(live.address() as { port: number }).port}`);
    await createProgram().parseAsync(['node', 'plune', 'requirements', 'links', file, ...args]);
  };
  const map = ['--table', '0', '--requirement-column', 'Req', '--test-column', 'Tests'];

  it('unmatched rows are an answer: exit 0, unless --fail-on-unmatched', async () => {
    await cli(...map);
    expect(out).toContain('unmatched (1)');
    expect(process.exitCode).toBeUndefined();
    live?.close();
    await cli(...map, '--fail-on-unmatched');
    expect(process.exitCode).toBe(1);
  });

  it('--json prints the raw report', async () => {
    await cli(...map, '--json');
    expect(JSON.parse(out)).toEqual(REPORT);
  });

  it('a flag mistake is exit 2', async () => {
    await cli('--table', '0');
    expect(process.exitCode).toBe(2);
  });
});
