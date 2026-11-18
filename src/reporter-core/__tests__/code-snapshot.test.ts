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

function platform(cases: Case[], over: { patchStatus?: number } = {}) {
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
    if (u.pathname === '/v1/runs') return reply(201, { run: { id: 'r-1' }, joined: false });
    if (u.pathname === '/v1/runs/r-1/results') {
      const list = body['results'] as Record<string, unknown>[];
      results.push(...list);
      return reply(200, {
        items: [],
        counts: { accepted: list.length, duplicate: 0, conflict: 0, rejected: 0 },
      });
    }
    if (u.pathname === '/v1/runs/r-1/events') return reply(200, { run: { id: 'r-1' } });
    if (u.pathname === '/v1/test-cases' && method === 'GET') {
      const typed = u.searchParams.getAll('type');
      const rows = cases.filter((c) => typed.length === 0 || typed.includes(c.type));
      return reply(200, { testCases: rows, nextCursor: null });
    }
    const one = /^\/v1\/test-cases\/([^/]+)$/.exec(u.pathname);
    if (one !== null && method === 'PATCH') {
      patches.push({ id: one[1]!, body });
      return over.patchStatus !== undefined
        ? reply(over.patchStatus, { error: 'no' })
        : reply(200, { id: one[1] });
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

async function run(cases: Case[], results: PendingResult[], over: { patchStatus?: number } = {}) {
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
