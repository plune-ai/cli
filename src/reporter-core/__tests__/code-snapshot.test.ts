import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { callTextAt, maskCredentials, SNAPSHOT_MAX_BYTES } from '../code-snapshot.js';
import { startRun } from '../session.js';
import type { PendingResult, ReporterConfig } from '../types.js';

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

describe('callTextAt — the text of the one test() call a result points at', () => {
  it('takes the call from its name to its own closing parenthesis, nothing around it', () => {
    const src = [
      "import { test } from '@playwright/test';",
      '',
      "test('adds an item', async ({ page }) => {",
      "  await page.goto('/');",
      '});',
      '',
    ].join('\n');
    expect(callTextAt(src, 3)).toBe(
      "test('adds an item', async ({ page }) => {\n  await page.goto('/');\n})",
    );
  });

  it('is not fooled by brackets inside strings, templates, comments and regular expressions', () => {
    const src = [
      "test.describe('cart', () => {",
      "  test.skip('totals (with tax)', async () => {",
      '    // a stray ) in a comment',
      '    /* and ( here */',
      '    const re = /\\)+[)]/;',
      '    const t = `a ) ${fn(")")} b`;',
      '    expect("(").toBe(\'(\');',
      '  });',
      '});',
    ].join('\n');
    const text = callTextAt(src, 2);
    expect(text?.startsWith("test.skip('totals (with tax)'")).toBe(true);
    expect(text?.endsWith('  })')).toBe(true);
  });

  it('takes it( as well, and turns CRLF into LF', () => {
    expect(callTextAt("it('works', () => {\r\n  x();\r\n});\r\n", 1)).toBe(
      "it('works', () => {\n  x();\n})",
    );
  });

  it('gives nothing for a line with no test call, an unbalanced call or a text over the limit', () => {
    expect(callTextAt("const a = 1;\ntest('x', () => {});", 1)).toBeUndefined();
    expect(callTextAt("test('x', () => {", 1)).toBeUndefined();
    expect(callTextAt("test('x', () => {});", 9)).toBeUndefined();
    const big = `test('x', () => {\n${'  a();\n'.repeat(SNAPSHOT_MAX_BYTES / 4)}});`;
    expect(callTextAt(big, 1)).toBeUndefined();
  });
});

describe('maskCredentials — what is never sent as written', () => {
  it('masks a value by where it sits: a credential name, a credential call, a fill of a credential field', () => {
    const out = maskCredentials(
      [
        "const password = 'hunter2';",
        'login({ user: \'jd\', apiKey: "abc" });',
        "await setToken('t0k');",
        "await page.fill('#password', 'pw1');",
        "await page.getByLabel('Password', { exact: true }).fill('pw2');",
        "await page.goto('https://jd:s3cret@example.com/x');",
      ].join('\n'),
    );
    expect(out).toBe(
      [
        "const password = '‹password›';",
        'login({ user: \'jd\', apiKey: "‹apikey›" });',
        "await setToken('‹settoken›');",
        "await page.fill('#password', '‹password›');",
        "await page.getByLabel('Password', { exact: true }).fill('‹password›');",
        "await page.goto('https://‹credential›@example.com/x');",
      ].join('\n'),
    );
  });

  it('masks a value by its form wherever it is, and leaves ordinary code alone', () => {
    const key = `sk-${'a'.repeat(24)}`;
    const gh = `ghp_${'b'.repeat(36)}`;
    const out = maskCredentials(`call('${key}', "${gh}", 'Bearer ${'c'.repeat(24)}');`);
    expect(out).not.toContain(key);
    expect(out).not.toContain(gh);
    expect(out).not.toContain('c'.repeat(24));
    const plain = "if (token === 'x') await page.fill('#email', 'user@plune.ai');";
    expect(maskCredentials(plain)).toBe(plain);
  });
});

describe('maskCredentials — more places and forms (review of plune-ai/cli#307)', () => {
  const cases: [string, string, string][] = [
    [
      'getByRole name',
      "await page.getByRole('textbox', { name: 'Your Password' }).fill('pw3');",
      'pw3',
    ],
    ['type into a password field', "await page.locator('#password').type('pw4');", 'pw4'],
    [
      'pressSequentially into a password field',
      "await page.getByLabel('Password').pressSequentially('pw5');",
      'pw5',
    ],
    ['type with the field in the call', "await page.type('#pwd', 'pw6');", 'pw6'],
    ['pass', "const pass = 'pw7';", 'pw7'],
    ['pwd', "login({ pwd: 'pw8' });", 'pw8'],
    ['auth', "const auth = 'au1';", 'au1'],
    ['credential', "use({ credential: 'cr1' });", 'cr1'],
    ['passphrase', "const passphrase = 'pp1';", 'pp1'],
    ['privateKey', "sign({ privateKey: 'pk1' });", 'pk1'],
    ['credential argument', "await loginWithCredentials('cr2');", 'cr2'],
    [
      'Authorization header line',
      'const raw = `GET / HTTP/1.1\nAuthorization: secretvalue1\n`;',
      'secretvalue1',
    ],
    ['cookie header line', 'const raw = `cookie: sid=abc123def\n`;', 'abc123def'],
    ['session header line', 'const raw = `x-session-id: s3ss10n\n`;', 's3ss10n'],
    ['Basic', "const h = 'Basic dXNlcjpwYXNz';", 'dXNlcjpwYXNz'],
    ['Token', "const h = 'Token abcdef123456';", 'abcdef123456'],
    ['PLUNE_ variable', 'const env = "PLUNE_TOKEN=plv4lu3";', 'plv4lu3'],
    ['URL query', "await page.goto('https://x.test/cb?code=1&access_token=qt1');", 'qt1'],
    ['URL query in a template', 'await page.goto(`${base}/reset?password=qt2&x=1`);', 'qt2'],
    ['URL query key', "await fetch('https://x.test/?apikey=qt3');", 'qt3'],
    ['sk_live_', `call('sk_live_${'a'.repeat(24)}');`, 'a'.repeat(24)],
    ['sk_test_', `call('sk_test_${'b'.repeat(24)}');`, 'b'.repeat(24)],
    ['npm_', `call('npm_${'c'.repeat(36)}');`, 'c'.repeat(36)],
    ['AIza', `call('AIza${'d'.repeat(35)}');`, 'd'.repeat(35)],
    ['plune_', `call('plune_tok_${'e'.repeat(24)}');`, 'e'.repeat(24)],
  ];
  for (const [what, code, secret] of cases) {
    it(`masks ${what}`, () => {
      const out = maskCredentials(code);
      expect(out, out).not.toContain(secret);
      expect(out).toMatch(/‹[^›]+›/);
      expect(out.slice(0, 6)).toBe(code.slice(0, 6));
    });
  }

  it('two test calls on one line: the column picks one, without it neither', () => {
    const src = "test('a', () => {}); test('b', () => { x(); });";
    expect(callTextAt(src, 1)).toBeUndefined();
    expect(callTextAt(src, 1, 1)).toBe("test('a', () => {})");
    expect(callTextAt(src, 1, 22)).toBe("test('b', () => { x(); })");
  });
});

describe('maskCredentials — second review of plune-ai/cli#307', () => {
  it('masks the value of a cookie object whose name says credential', () => {
    const code =
      "await ctx.addCookies([{ name: 'session', value: 's3cr3tv4lue', domain: 'x.test' }]);";
    expect(maskCredentials(code)).toBe(
      "await ctx.addCookies([{ name: 'session', value: '‹session›', domain: 'x.test' }]);",
    );
  });

  it('leaves Basic and Token alone before an ordinary word', () => {
    const code = "test('Basic checkout works', async () => { expect(x).toBe('Token expired'); });";
    expect(maskCredentials(code)).toBe(code);
    expect(maskCredentials("const h = 'Token abcdef123456';")).toBe(
      "const h = 'Token ‹credential›';",
    );
  });

  it('does not touch a variable given to a session-like key, nor the comma after it', () => {
    const code = 'const opts = {\n  sessionId: sid,\n  cookie: jar.get(),\n};';
    expect(maskCredentials(code)).toBe(code);
  });
});

// --- the run sends the snapshot of each automated case it matched --------------------------------

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plune-snapshot-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

interface Case {
  id: string;
  type: 'automated' | 'manual';
  codeSnapshotHash?: string;
}

interface PlatformOver {
  patchStatus?: number;
  /** The status the n-th PATCH (from 1) of case `id` is answered with; undefined is 200. */
  patchStatusFor?: (id: string) => number | undefined;
  runId?: string;
}

function platform(cases: Case[], over: PlatformOver = {}) {
  const runId = over.runId ?? 'r-1';
  const patches: { id: string; body: Record<string, unknown> }[] = [];
  const results: Record<string, unknown>[] = [];
  const reply = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    const body =
      typeof init?.body === 'string' && init.body !== ''
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : {};
    const method = init?.method ?? 'GET';
    if (u.pathname === '/v1/test-cases/resolve') {
      const keys = body['keys'] as { value: string }[];
      return reply(200, {
        results: keys.map((k) => ({ key: k, testCaseId: k.value, matchedKind: null })),
      });
    }
    if (u.pathname === '/v1/runs') return reply(201, { run: { id: runId }, joined: false });
    if (u.pathname === `/v1/runs/${runId}/results`) {
      const list = body['results'] as Record<string, unknown>[];
      results.push(...list);
      return reply(200, {
        items: [],
        counts: { accepted: list.length, duplicate: 0, conflict: 0, rejected: 0 },
      });
    }
    if (u.pathname === `/v1/runs/${runId}/events`) return reply(200, { run: { id: runId } });
    if (u.pathname === '/v1/test-cases' && method === 'GET') {
      const typed = u.searchParams.getAll('type');
      const rows = cases.filter((c) => typed.length === 0 || typed.includes(c.type));
      return reply(200, { testCases: rows, nextCursor: null });
    }
    const one = /^\/v1\/test-cases\/([^/]+)$/.exec(u.pathname);
    if (one !== null && method === 'PATCH') {
      patches.push({ id: one[1]!, body });
      const status = over.patchStatus ?? over.patchStatusFor?.(one[1]!);
      return status !== undefined ? reply(status, { error: 'no' }) : reply(200, { id: one[1] });
    }
    return reply(500, { error: `unexpected ${method} ${u.pathname}` });
  }) as typeof fetch;
  return { fetchImpl, patches, results };
}

function config(fetchImpl: typeof fetch, log: string[]): ReporterConfig {
  return {
    apiUrl: 'https://api.test',
    token: 'tok',
    fallbackPath: path.join(dir, 'pending.jsonl'),
    fetchImpl,
    log: (l) => log.push(l),
  };
}

const TEST_TEXT =
  "test('logs in', async ({ page }) => {\n  await page.fill('#password', 'pw1');\n})";
const MASKED =
  "test('logs in', async ({ page }) => {\n  await page.fill('#password', '‹password›');\n})";

function spec(): string {
  const file = path.join(dir, 'login.spec.ts');
  fs.writeFileSync(file, `import { test } from '@playwright/test';\n\n${TEST_TEXT};\n`);
  return file;
}

const result = (
  caseKey: string,
  file: string,
  over: Partial<PendingResult> = {},
): PendingResult => ({
  resultKey: `rk-${caseKey}`,
  keys: [{ kind: 'path-title', value: caseKey }],
  source: 'playwright',
  rawStatus: 'passed',
  codeAt: { file, line: 3 },
  ...over,
});

async function run(cases: Case[], results: PendingResult[], over: PlatformOver = {}) {
  const p = platform(cases, over);
  const log: string[] = [];
  const session = await startRun(config(p.fetchImpl, log));
  for (const r of results) await session.add(r);
  await session.finish();
  return { ...p, log };
}

describe('startRun — the code snapshot of a matched automated case', () => {
  it('sends the masked text to a case that has none, and never inside a result', async () => {
    const out = await run([{ id: 'tc-1', type: 'automated' }], [result('tc-1', spec())]);
    expect(out.patches).toEqual([{ id: 'tc-1', body: { codeSnapshot: MASKED } }]);
    expect(out.results).toHaveLength(1);
    expect(JSON.stringify(out.results)).not.toContain('codeAt');
    expect(JSON.stringify(out.results)).not.toContain('codeSnapshot');
    expect(out.log.join('\n')).toContain('1 code snapshot(s) updated');
  });

  it('sends nothing when the case already holds the same text', async () => {
    const out = await run(
      [{ id: 'tc-1', type: 'automated', codeSnapshotHash: sha(MASKED) }],
      [result('tc-1', spec())],
    );
    expect(out.patches).toEqual([]);
  });

  it('replaces a snapshot the test has moved away from', async () => {
    const out = await run(
      [{ id: 'tc-1', type: 'automated', codeSnapshotHash: sha('old text') }],
      [result('tc-1', spec())],
    );
    expect(out.patches).toEqual([{ id: 'tc-1', body: { codeSnapshot: MASKED } }]);
  });

  it('leaves a case alone that is not automated, and a test whose text could not be read', async () => {
    const out = await run(
      [
        { id: 'tc-1', type: 'manual' },
        { id: 'tc-2', type: 'automated' },
      ],
      [result('tc-1', spec()), result('tc-2', path.join(dir, 'gone.spec.ts'))],
    );
    expect(out.patches).toEqual([]);
    expect(out.results).toHaveLength(2);
  });

  it('a refused update costs the run nothing but a line', async () => {
    const out = await run([{ id: 'tc-1', type: 'automated' }], [result('tc-1', spec())], {
      patchStatus: 403,
    });
    expect(out.patches).toHaveLength(1);
    expect(out.results).toHaveLength(1);
    expect(out.log.join('\n')).toMatch(/could not update the code snapshot/);
  });
});

describe('startRun — the snapshot updates one run makes', () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => `tc-${i}`);

  it('makes at most 100, and another run reaches other cases', async () => {
    const ids = many(150);
    const file = spec();
    const cases = ids.map((id) => ({ id, type: 'automated' as const }));
    const first = await run(
      cases,
      ids.map((id) => result(id, file)),
      { runId: 'r-1' },
    );
    const second = await run(
      cases,
      ids.map((id) => result(id, file)),
      { runId: 'r-2' },
    );
    expect(first.patches).toHaveLength(100);
    expect(second.patches).toHaveLength(100);
    const a = new Set(first.patches.map((p) => p.id));
    expect(second.patches.some((p) => !a.has(p.id))).toBe(true);
    expect(first.log.join('\n')).toContain(
      '100 code snapshot(s) updated, 50 left for the next run',
    );
  });

  it('skips a case the platform refuses and goes on with the rest', async () => {
    const ids = many(4);
    const file = spec();
    const bad: Record<string, number> = { 'tc-0': 400, 'tc-1': 404, 'tc-2': 409 };
    const out = await run(
      ids.map((id) => ({ id, type: 'automated' as const })),
      ids.map((id) => result(id, file)),
      { patchStatusFor: (id) => bad[id] },
    );
    expect(out.patches).toHaveLength(4);
    expect(out.log.join('\n')).toContain('1 code snapshot(s) updated');
    expect(out.log.join('\n')).toContain('3 not updated');
  });

  it('stops at a refused token or a limit', async () => {
    for (const status of [401, 403, 429]) {
      const ids = many(3);
      const file = spec();
      const out = await run(
        ids.map((id) => ({ id, type: 'automated' as const })),
        ids.map((id) => result(id, file)),
        { patchStatus: status },
      );
      expect(out.patches, String(status)).toHaveLength(1);
    }
  });
});
