import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { errorContextOf, failureOf, repoRootOf } from '../failure-detail.js';
import type { FailedAttempt } from '../types.js';

/**
 * #790 T13 — the failure detail from one normalized attempt. The texts are the ones Playwright 1.63
 * wrote for a trial run (`formatError`: the message, the code frame, the stack's `at` lines), with
 * the machine's paths put under `/repo` and `D:\repo`.
 */

const ESC = '\u001b';
const TEST_FILE = '/repo/e2e/shop.spec.ts';

const TIMEOUT = `${ESC}[31mTest timeout of 1500ms exceeded.${ESC}[39m`;
const WAITING = [
  'Error: apiRequestContext.get: Request context disposed.',
  'Call log:',
  `${ESC}[2m  - → GET http://127.0.0.1:53737/total${ESC}[22m`,
  '',
  '',
  '   at helpers.ts:14',
  '',
  '  13 | export async function readTotal(request: APIRequestContext, url: string): Promise<void> {',
  '> 14 |   await request.get(url);',
  '     |                 ^',
  '  15 | }',
  '    at readTotal (/repo/e2e/helpers.ts:14:17)',
  '    at /repo/e2e/shop.spec.ts:12:13',
  '    at /repo/e2e/shop.spec.ts:11:5',
].join('\n');
const SOFT = (label: string, line: number, column: number) =>
  [
    `Error: ${label}`,
    '',
    `${ESC}[2mexpect(${ESC}[22m${ESC}[31mreceived${ESC}[39m${ESC}[2m).${ESC}[22mtoBe${ESC}[2m(${ESC}[22m${ESC}[32mexpected${ESC}[39m${ESC}[2m) // Object.is equality${ESC}[22m`,
    '',
    `> ${line} |       expect.soft(1, '${label}').toBe(2);`,
    `    at /repo/e2e/shop.spec.ts:${line}:${column}`,
    '    at /repo/e2e/shop.spec.ts:22:5',
  ].join('\n');
const FIXTURE = [
  'Error: no test account in this environment',
  '',
  '   at helpers.ts:20',
  '',
  "> 20 |     throw new Error('no test account in this environment');",
  '    at Object.account (/repo/e2e/helpers.ts:20:11)',
].join('\n');

const attempt = (over: Partial<FailedAttempt> = {}): FailedAttempt => ({
  status: 'failed',
  errors: [{ text: SOFT('the first total', 23, 41), location: { file: '/repo/e2e/shop.spec.ts', line: 23, column: 41 } }],
  steps: [],
  attachments: [],
  testFile: TEST_FILE,
  repoRoot: '/repo',
  ...over,
});

describe('failureOf — the headline (AC-01, AC-01c)', () => {
  it('is the first non-empty line of the first error, without colour codes', () => {
    const failure = failureOf(attempt({ errors: [{ text: `\n  ${ESC}[31mError: boom${ESC}[39m\nmore` }] }));
    expect(failure?.headline).toBe('Error: boom');
  });

  it('on a test timeout is the waiting action’s, and the place is the test line that called the helper (AC-01c, AC-02)', () => {
    const failure = failureOf(
      attempt({
        status: 'timedOut',
        errors: [{ text: TIMEOUT }, { text: WAITING, location: { file: '/repo/e2e/helpers.ts', line: 14, column: 17 } }],
      }),
    );
    expect(failure?.headline).toBe('Error: apiRequestContext.get: Request context disposed.');
    expect(failure?.location).toEqual({ file: 'e2e/shop.spec.ts', line: 12, column: 13 });
  });

  it('on a test timeout with no error after it is the timeout itself', () => {
    expect(failureOf(attempt({ status: 'timedOut', errors: [{ text: TIMEOUT }] }))?.headline).toBe('Test timeout of 1500ms exceeded.');
  });

  it('is not cut — the platform bounds it after its own cleaning (ADR-0001)', () => {
    const long = `Error: ${'x'.repeat(5000)}`;
    expect(failureOf(attempt({ errors: [{ text: long }] }))?.headline).toBe(long);
  });
});

describe('failureOf — the chain of declared steps (AC-02, AC-02c, AC-03)', () => {
  it('runs from the outermost declared step to the one that failed', () => {
    const failure = failureOf(
      attempt({
        steps: [
          { title: 'Open the basket', failed: false, steps: [] },
          { title: 'Pay', failed: true, steps: [{ title: 'Check the totals', failed: true, steps: [] }] },
        ],
      }),
    );
    expect(failure?.steps).toEqual(['Pay', 'Check the totals']);
  });

  it('follows the first failed step where two failed side by side', () => {
    const failure = failureOf(
      attempt({
        steps: [{ title: 'Pay', failed: true, steps: [{ title: 'Card', failed: true, steps: [] }, { title: 'Receipt', failed: true, steps: [] }] }],
      }),
    );
    expect(failure?.steps).toEqual(['Pay', 'Card']);
  });

  it('is absent for a test with no declared steps (AC-03)', () => {
    expect(failureOf(attempt())).not.toHaveProperty('steps');
  });

  it('is absent when the failure came from a fixture in another file, and the place is where it was thrown (AC-02c)', () => {
    const failure = failureOf(
      attempt({
        errors: [{ text: FIXTURE, location: { file: '/repo/e2e/helpers.ts', line: 20, column: 11 } }],
        steps: [{ title: 'Pay', failed: false, steps: [] }],
      }),
    );
    expect(failure).not.toHaveProperty('steps');
    expect(failure?.location).toEqual({ file: 'e2e/helpers.ts', line: 20, column: 11 });
  });
});

describe('failureOf — the place (AC-02, AC-05, AC-07)', () => {
  it('is the first frame in the test file itself', () => {
    expect(failureOf(attempt())?.location).toEqual({ file: 'e2e/shop.spec.ts', line: 23, column: 41 });
  });

  it('is posix and from the repository root on a Windows machine (AC-05)', () => {
    const failure = failureOf(
      attempt({
        errors: [{ text: 'Error: boom\n    at D:\\repo\\e2e\\shop.spec.ts:12:13' }],
        testFile: 'D:\\repo\\e2e\\shop.spec.ts',
        repoRoot: 'd:\\repo',
      }),
    );
    expect(failure?.location).toEqual({ file: 'e2e/shop.spec.ts', line: 12, column: 13 });
  });

  it('reads a frame written as a file URL', () => {
    const failure = failureOf(attempt({ errors: [{ text: 'Error: boom\n    at file:///repo/e2e/shop.spec.ts:7:3' }] }));
    expect(failure?.location).toEqual({ file: 'e2e/shop.spec.ts', line: 7, column: 3 });
  });

  it('is absent for a file outside the repository — the rest of the detail still goes (AC-07)', () => {
    const failure = failureOf(
      attempt({
        errors: [{ text: 'Error: boom', location: { file: '/home/ci-user/lib/x.ts', line: 3 } }],
        attachments: [{ name: 'screenshot', contentType: 'image/png', path: '/repo/test-results/a/test-failed-1.png' }],
      }),
    );
    expect(failure).not.toHaveProperty('location');
    expect(failure?.headline).toBe('Error: boom');
    expect(failure?.artifacts).toEqual([{ name: 'screenshot', contentType: 'image/png' }]);
  });

  it('is absent on line 0, and a column below 1 is dropped (AC-07)', () => {
    expect(failureOf(attempt({ errors: [{ text: 'Error: boom', location: { file: TEST_FILE, line: 0 } }] }))).not.toHaveProperty('location');
    expect(failureOf(attempt({ errors: [{ text: 'Error: boom', location: { file: TEST_FILE, line: 4, column: 0 } }] }))?.location).toEqual({ file: 'e2e/shop.spec.ts', line: 4 });
  });

  it('is absent when the repository root is unknown — a report from another machine', () => {
    expect(failureOf(attempt({ repoRoot: undefined }))).not.toHaveProperty('location');
  });

  it('is absent for a path the platform would refuse, rather than costing the batch', () => {
    const failure = failureOf(attempt({ errors: [{ text: 'Error: boom', location: { file: '/repo/~tmp/x.spec.ts', line: 2 } }] }));
    expect(failure).not.toHaveProperty('location');
  });
});

describe('failureOf — what the runner kept, and the CI run (AC-04, AC-05)', () => {
  it('names the files the attempt kept, without the internal ones, the metadata or bodies with no file', () => {
    const failure = failureOf(
      attempt({
        attachments: [
          { name: 'screenshot', contentType: 'image/png', path: '/repo/test-results/a/test-failed-1.png' },
          { name: '_internal', contentType: 'text/plain', path: '/repo/test-results/a/x.txt' },
          { name: 'plune', contentType: 'application/plune.metadata+json', path: '/repo/test-results/a/m.json' },
          { name: 'note', contentType: 'text/plain' },
          { name: '', path: '/repo/test-results/a/unnamed.bin' },
          { name: 'trace', path: '/repo/test-results/a/trace.zip' },
        ],
      }),
    );
    expect(failure?.artifacts).toEqual([{ name: 'screenshot', contentType: 'image/png' }, { name: 'trace' }]);
  });

  it('keeps an http(s) build link, and nothing else is a link (AC-04, AC-05)', () => {
    expect(failureOf(attempt({ buildHref: 'https://github.com/acme/shop/actions/runs/42' }))?.ciUrl).toBe('https://github.com/acme/shop/actions/runs/42');
    for (const href of ['file:///home/ci-user/report', 'javascript:alert(1)', 'https://', 'not a link']) {
      expect(failureOf(attempt({ buildHref: href }))).not.toHaveProperty('ciUrl');
    }
  });

  it('is nothing at all when there is nothing to say', () => {
    expect(failureOf(attempt({ errors: [], repoRoot: undefined }))).toBeUndefined();
  });
});

describe('repoRootOf — the nearest .git above the runner’s root dir', () => {
  let dir = '';
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('finds a .git folder, and a .git file as a worktree has', () => {
    dir = mkdtempSync(join(tmpdir(), 'plune-root-'));
    mkdirSync(join(dir, 'repo', '.git'), { recursive: true });
    mkdirSync(join(dir, 'repo', 'e2e', 'tests'), { recursive: true });
    expect(repoRootOf(join(dir, 'repo', 'e2e', 'tests'))).toBe(join(dir, 'repo'));
    mkdirSync(join(dir, 'wt', 'e2e'), { recursive: true });
    writeFileSync(join(dir, 'wt', '.git'), 'gitdir: /elsewhere\n');
    expect(repoRootOf(join(dir, 'wt', 'e2e'))).toBe(join(dir, 'wt'));
  });

  it('is undefined when no .git is above', () => {
    dir = mkdtempSync(join(tmpdir(), 'plune-root-'));
    expect(repoRootOf(join(dir, 'nowhere'), dir)).toBeUndefined();
  });
});

describe('errorContextOf — the text of every error (AC-01, AC-01c, AC-05, AC-15)', () => {
  const HOME = '/home/ci-user';
  const LIMIT = 512 * 1024;
  const MARKER = /^…\[omitted (\d+) lines\]…$/;

  it('holds every error of the attempt in order, with no escape character left', () => {
    const text = errorContextOf(
      attempt({ errors: [{ text: SOFT('the first total', 23, 41) }, { text: SOFT('the second total', 24, 41) }, { text: `${ESC}[31mstray${ESC}` }] }),
      HOME,
    );
    const first = text.indexOf('Error: the first total');
    expect(first).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('Error: the second total')).toBeGreaterThan(first);
    expect(text).toContain('    at e2e/shop.spec.ts:22:5\n\nError: the second total');
    expect(text).toContain('expect(received).toBe(expected) // Object.is equality');
    expect(text).toContain('stray');
    expect(text).not.toContain(ESC);
  });

  it('is empty when no error has a text', () => {
    expect(errorContextOf(attempt({ errors: [{ text: '' }, { text: 'Error: boom' }, { text: '' }] }), HOME)).toBe('Error: boom');
    expect(errorContextOf(attempt({ errors: [{ text: '' }, { text: '' }] }), HOME)).toBe('');
  });

  it('writes the repository as relative paths and the home folder as ~ (AC-05)', () => {
    const text = errorContextOf(
      attempt({
        errors: [
          {
            text: [
              'Error: boom',
              '    at /home/ci-user/shop/e2e/shop.spec.ts:12:13',
              '    at /home/ci-user/.cache/ms-playwright/x.js:1:1',
              '    at file:///home/ci-user/shop/e2e/helpers.ts:3:5',
              '    at /home/ci-user/shop2/other.ts:9:9',
            ].join('\n'),
          },
        ],
        testFile: '/home/ci-user/shop/e2e/shop.spec.ts',
        repoRoot: '/home/ci-user/shop',
      }),
      HOME,
    );
    expect(text).toBe(
      ['Error: boom', '    at e2e/shop.spec.ts:12:13', '    at ~/.cache/ms-playwright/x.js:1:1', '    at e2e/helpers.ts:3:5', '    at ~/shop2/other.ts:9:9'].join('\n'),
    );
    expect(errorContextOf(attempt({ errors: [{ text: 'at /home/ci-user/.cache/x.js:1:1' }] }), '/home/ci-user/')).toBe('at ~/.cache/x.js:1:1');
  });

  it('with a root rewrites only this machine’s folders — a sibling, or a path that is the test’s own data, stays', () => {
    const text = errorContextOf(
      attempt({
        errors: [{ text: ['at /srv/ci/repo/c.ts:3:3', 'at /srv/ci/repo2/a.ts:1:1', 'at /srv/ci-cache/b.ts:2:2', 'Expected: "/home/bob/report.txt"'].join('\n') }],
        repoRoot: '/srv/ci/repo',
      }),
      '/srv/ci',
    );
    expect(text).toBe(['at c.ts:3:3', 'at ~/repo2/a.ts:1:1', 'at /srv/ci-cache/b.ts:2:2', 'Expected: "/home/bob/report.txt"'].join('\n'));
  });

  it('takes a root or a home at / or a bare drive for no folder — it would match every path', () => {
    expect(errorContextOf(attempt({ repoRoot: '/', errors: [{ text: 'at /opt/x.js:2:2' }] }), '/')).toBe('at /opt/x.js:2:2');
    expect(errorContextOf(attempt({ repoRoot: 'C:\\', errors: [{ text: 'at C:\\opt\\x.js:2:2' }] }), 'C:\\')).toBe('at C:\\opt\\x.js:2:2');
  });

  it('on Windows as well, whatever case the drive letter was written in (AC-05)', () => {
    const text = errorContextOf(
      attempt({
        errors: [{ text: 'Error: boom\n    at D:\\repo\\e2e\\shop.spec.ts:12:13\n    at file:///D:/repo/e2e/helpers.ts:3:5\n    at C:\\Users\\alice\\AppData\\x.js:1:1' }],
        testFile: 'D:\\repo\\e2e\\shop.spec.ts',
        repoRoot: 'd:\\repo',
      }),
      'C:\\Users\\alice',
    );
    expect(text).toBe('Error: boom\n    at e2e\\shop.spec.ts:12:13\n    at e2e/helpers.ts:3:5\n    at ~\\AppData\\x.js:1:1');
  });

  it('with no repository root writes any home folder as ~ — the report may come from another machine (AC-05)', () => {
    const text = errorContextOf(
      attempt({
        repoRoot: undefined,
        errors: [
          {
            text: [
              'at /home/bob/shop/a.ts:1:1',
              'at /Users/carol/shop/b.ts:2:2',
              'at C:\\Users\\dave\\shop\\c.ts:3:3',
              'at file:///C:/Users/erin/shop/d.ts:4:4',
              'cannot open /home/frank',
              '/home/gina/.npm/_logs/debug.log',
              'at /work/src/Users/list.ts:5:5',
            ].join('\n'),
          },
        ],
      }),
      HOME,
    );
    expect(text).toBe(
      [
        'at ~/shop/a.ts:1:1',
        'at ~/shop/b.ts:2:2',
        'at ~\\shop\\c.ts:3:3',
        'at ~/shop/d.ts:4:4',
        'cannot open ~',
        '~/.npm/_logs/debug.log',
        'at /work/src/Users/list.ts:5:5',
      ].join('\n'),
    );
  });

  it('cuts a 20 MB text to whole lines from the head and the tail, and says how many it left out (AC-15)', () => {
    const lines = Array.from({ length: 280_000 }, (_, i) => `  - locator resolved to <p data-testid="total">$42.00</p>, unexpected value "$42.00" (${i})`);
    const text = errorContextOf(attempt({ errors: [{ text: lines.join('\n') }] }), HOME);

    expect(Buffer.byteLength(lines.join('\n'))).toBeGreaterThan(20 * 1024 * 1024);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(LIMIT);
    const out = text.split('\n');
    const at = out.findIndex((line) => MARKER.test(line));
    expect(at).toBeGreaterThan(0);
    expect(out.filter((line) => MARKER.test(line))).toHaveLength(1);
    const kept = out.length - 1;
    expect(at).toBeGreaterThan(1000);
    expect(kept - at).toBeGreaterThan(1000);
    expect(kept + Number(MARKER.exec(out[at]!)![1])).toBe(lines.length);
    expect(out.slice(0, at)).toEqual(lines.slice(0, at));
    expect(out.slice(at + 1)).toEqual(lines.slice(lines.length - (kept - at)));
    expect(Buffer.byteLength(text)).toBeGreaterThan(LIMIT - 1024);
  });

  it('measures the limit in UTF-8 bytes, not in characters', () => {
    const lines = Array.from({ length: 3_000 }, () => 'ї'.repeat(99));
    const text = errorContextOf(attempt({ errors: [{ text: lines.join('\n') }] }), HOME);
    expect(lines.join('\n').length).toBeLessThan(LIMIT);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(LIMIT);
    expect(text).toMatch(/…\[omitted \d+ lines\]…/);
  });

  it('counts the marker itself into the limit', () => {
    const lines = Array.from({ length: 1_000 }, () => 'a'.repeat(1_023));
    expect(Buffer.byteLength(errorContextOf(attempt({ errors: [{ text: lines.join('\n') }] }), HOME))).toBeLessThanOrEqual(LIMIT);
  });

  it('replaces a single line over the limit with the marker whole — no part of it shows (AC-15)', () => {
    const value = `authorization: Bearer ${'s3cr3t'.repeat(100_000)}`;
    const text = errorContextOf(attempt({ errors: [{ text: `Error: bad header\n${value}\n    at /repo/e2e/shop.spec.ts:4:2` }] }), HOME);
    expect(text).toBe('Error: bad header\n…[omitted 1 lines]…\n    at e2e/shop.spec.ts:4:2');
  });

  it('leaves a text at the limit whole', () => {
    const body = 'x'.repeat(LIMIT - 'Error: '.length);
    expect(errorContextOf(attempt({ errors: [{ text: `Error: ${body}` }] }), HOME)).toBe(`Error: ${body}`);
  });
});
