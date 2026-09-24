import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { failureOf, repoRootOf } from '../failure-detail.js';
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
