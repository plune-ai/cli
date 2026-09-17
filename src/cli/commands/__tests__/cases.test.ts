import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_CASES_FILE,
  DirtyFileError,
  formatReport,
  handlePull,
  handlePush,
  reportCasesFailure,
  type PushReport,
} from '../cases.js';
import {
  NotLoggedInError,
  SyncFileError,
  SyncHttpError,
  SyncNetworkError,
  TokenRejectedError,
} from '../sync.js';

const TOKEN = 'plune_secret_do_not_leak';
const DOC = '<!-- test -->\n## empty cart says so @cart\n';

/** A fetch stub that records each call and answers with one canned Response. */
function stubFetch(
  status: number,
  body: string,
  headers: Record<string, string> = { 'content-type': 'application/json' },
): { fn: typeof fetch; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(body, { status, headers });
  }) as typeof fetch;
  return { fn, calls };
}

function report(over: Partial<PushReport> = {}): PushReport {
  return {
    dryRun: false,
    created: [],
    updated: [],
    unchanged: [],
    refused: [],
    suites: { created: [], updated: [] },
    warnings: [],
    ...over,
  };
}

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'plune-cases-'));
});

const markdown = { 'content-type': 'text/markdown; charset=utf-8', 'x-plune-cases': '3' };

describe('handlePull (D9)', () => {
  it('writes the document to plune/cases.md, with the bearer token and never in the output', async () => {
    const { fn, calls } = stubFetch(200, DOC, markdown);
    const result = await handlePull({
      cwd: tmp,
      apiUrl: 'https://api.test',
      loadToken: () => TOKEN,
      fetchImpl: fn,
    });
    expect(result).toEqual({ file: join(tmp, DEFAULT_CASES_FILE), cases: 3 });
    expect(readFileSync(result.file, 'utf8')).toBe(DOC);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.test/v1/test-cases/markdown');
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe(
      `Bearer ${TOKEN}`,
    );
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it('pulls one suite through /v1/suites/:id/markdown into the file given', async () => {
    const { fn, calls } = stubFetch(200, DOC, markdown);
    const result = await handlePull({
      cwd: tmp,
      file: 'docs/web.md',
      suiteId: 'a b',
      apiUrl: 'https://api.test',
      loadToken: () => TOKEN,
      fetchImpl: fn,
    });
    expect(calls[0]?.url).toBe('https://api.test/v1/suites/a%20b/markdown');
    expect(result.file).toBe(join(tmp, 'docs', 'web.md'));
    expect(existsSync(result.file)).toBe(true);
  });

  it('refuses to overwrite a file with uncommitted changes unless --force (no request made)', async () => {
    mkdirSync(join(tmp, 'plune'), { recursive: true });
    writeFileSync(join(tmp, 'plune', 'cases.md'), 'edited by hand');
    const { fn, calls } = stubFetch(200, DOC, markdown);
    const deps = {
      cwd: tmp,
      apiUrl: 'https://api.test',
      loadToken: () => TOKEN,
      fetchImpl: fn,
      isDirty: () => true,
    };
    await expect(handlePull(deps)).rejects.toBeInstanceOf(DirtyFileError);
    expect(calls).toHaveLength(0);
    expect(readFileSync(join(tmp, 'plune', 'cases.md'), 'utf8')).toBe('edited by hand');
    await handlePull({ ...deps, force: true });
    expect(readFileSync(join(tmp, 'plune', 'cases.md'), 'utf8')).toBe(DOC);
  });

  it('a file git does not know is not dirty: absent file → no guard, clean file → written', async () => {
    const { fn } = stubFetch(200, DOC, markdown);
    let asked = 0;
    const isDirty = () => {
      asked += 1;
      return false;
    };
    await handlePull({
      cwd: tmp,
      apiUrl: 'https://api.test',
      loadToken: () => TOKEN,
      fetchImpl: fn,
      isDirty,
    });
    expect(asked).toBe(0); // nothing to overwrite yet
    await handlePull({
      cwd: tmp,
      apiUrl: 'https://api.test',
      loadToken: () => TOKEN,
      fetchImpl: fn,
      isDirty,
    });
    expect(asked).toBe(1);
  });

  it('rejects with NotLoggedInError when no token is stored (no request made)', async () => {
    const { fn, calls } = stubFetch(200, DOC, markdown);
    await expect(
      handlePull({ cwd: tmp, loadToken: () => null, fetchImpl: fn }),
    ).rejects.toBeInstanceOf(NotLoggedInError);
    expect(calls).toHaveLength(0);
  });

  it('maps 401 → TokenRejectedError, other errors → SyncHttpError with the detail, a dead host → SyncNetworkError', async () => {
    const base = { cwd: tmp, apiUrl: 'https://api.test', loadToken: () => TOKEN };
    await expect(
      handlePull({ ...base, fetchImpl: stubFetch(401, '{}').fn }),
    ).rejects.toBeInstanceOf(TokenRejectedError);
    const err = await handlePull({
      ...base,
      fetchImpl: stubFetch(404, JSON.stringify({ error: 'suite not found' })).fn,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SyncHttpError);
    expect((err as Error).message).toContain('suite not found');
    const dead = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const net = await handlePull({ ...base, fetchImpl: dead }).catch((e: unknown) => e);
    expect(net).toBeInstanceOf(SyncNetworkError);
    expect((net as Error).message).not.toContain(TOKEN);
    expect(existsSync(join(tmp, DEFAULT_CASES_FILE))).toBe(false);
  });
});

describe('handlePush (D9)', () => {
  it('posts the file as text/markdown and returns the report as the server gave it', async () => {
    mkdirSync(join(tmp, 'plune'), { recursive: true });
    writeFileSync(join(tmp, 'plune', 'cases.md'), DOC);
    const answer = report({ created: [{ title: 'empty cart says so @cart', line: 1 }] });
    const { fn, calls } = stubFetch(200, JSON.stringify(answer));
    const got = await handlePush({
      cwd: tmp,
      apiUrl: 'https://api.test/',
      loadToken: () => TOKEN,
      fetchImpl: fn,
    });
    expect(got).toEqual(answer);
    expect(calls[0]?.url).toBe('https://api.test/v1/test-cases/markdown');
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.init.body).toBe(DOC);
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['content-type']).toBe('text/markdown');
    expect(headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('--dry-run asks the server for a dry run and passes the file given', async () => {
    writeFileSync(join(tmp, 'web.md'), DOC);
    const { fn, calls } = stubFetch(200, JSON.stringify(report({ dryRun: true })));
    const got = await handlePush({
      cwd: tmp,
      file: 'web.md',
      dryRun: true,
      apiUrl: 'https://api.test',
      loadToken: () => TOKEN,
      fetchImpl: fn,
    });
    expect(got.dryRun).toBe(true);
    expect(calls[0]?.url).toBe('https://api.test/v1/test-cases/markdown?dryRun=true');
  });

  it('rejects with SyncFileError when the document is missing or empty (no request made)', async () => {
    const { fn, calls } = stubFetch(200, JSON.stringify(report()));
    const base = { cwd: tmp, apiUrl: 'https://api.test', loadToken: () => TOKEN, fetchImpl: fn };
    await expect(handlePush(base)).rejects.toBeInstanceOf(SyncFileError);
    writeFileSync(join(tmp, 'empty.md'), '\n\n');
    await expect(handlePush({ ...base, file: 'empty.md' })).rejects.toBeInstanceOf(SyncFileError);
    expect(calls).toHaveLength(0);
  });

  it('maps 401 → TokenRejectedError and 415 → SyncHttpError', async () => {
    writeFileSync(join(tmp, 'web.md'), DOC);
    const base = { cwd: tmp, file: 'web.md', apiUrl: 'https://api.test', loadToken: () => TOKEN };
    await expect(
      handlePush({ ...base, fetchImpl: stubFetch(401, '{}').fn }),
    ).rejects.toBeInstanceOf(TokenRejectedError);
    await expect(
      handlePush({
        ...base,
        fetchImpl: stubFetch(415, JSON.stringify({ error: 'text/markdown expected' })).fn,
      }),
    ).rejects.toThrow('text/markdown expected');
  });
});

describe('formatReport / reportCasesFailure (D9)', () => {
  it('prints the counts, then each refusal and warning with its line; a dry run says so', () => {
    const out = formatReport(
      report({
        dryRun: true,
        created: [{ title: 'a', line: 1 }],
        updated: [{ id: 'x', title: 'b', line: 5 }],
        unchanged: [{ id: 'y', title: 'c', line: 9 }],
        refused: [{ title: 'nobody', line: 40, error: "unknown id '0000'" }],
        suites: { created: [{ path: 'apps > web', line: 1 }], updated: [] },
        warnings: [
          { line: 1, message: "created folder 'apps > web'" },
          { message: 'state: is only read back' },
        ],
      }),
    );
    expect(out).toBe(
      [
        'Dry run — nothing written. 1 to create · 1 to update · 1 unchanged · 1 refused · 1 suite(s) to create',
        "  refused  line 40  nobody — unknown id '0000'",
        "  warning  line 1  created folder 'apps > web'",
        '  warning  state: is only read back',
        '',
      ].join('\n'),
    );
    expect(formatReport(report({ updated: [{ id: 'x', title: 'b', line: 5 }] }))).toBe(
      'Pushed. 0 created · 1 updated · 0 unchanged · 0 refused\n',
    );
  });

  it('maps the dirty guard to 3, auth/file errors to 2, network/http to 1, unknown to null', () => {
    const seen: string[] = [];
    const write = (s: string) => {
      seen.push(s);
    };
    expect(reportCasesFailure(new DirtyFileError('plune/cases.md'), write)).toBe(3);
    expect(reportCasesFailure(new NotLoggedInError(), write)).toBe(2);
    expect(reportCasesFailure(new TokenRejectedError(), write)).toBe(2);
    expect(reportCasesFailure(new SyncFileError('gone'), write)).toBe(2);
    expect(reportCasesFailure(new SyncNetworkError('https://api.test'), write)).toBe(1);
    expect(reportCasesFailure(new SyncHttpError(500, 'boom'), write)).toBe(1);
    expect(reportCasesFailure(new Error('?'), write)).toBeNull();
    expect(seen).toHaveLength(6);
    expect(seen[0]).toContain('--force');
  });
});
