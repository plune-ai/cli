import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readPlaywrightJson, looksLikePlaywrightJson, JsonReportError } from '../playwright-json.js';

/**
 * The same test, imported here and reported by the adapter, has to be ONE test in Plune.
 *
 * That is the whole risk of this file. The reporter in `packages/playwright` derives the identity
 * from a `TestCase`; this derives it from a JSON report of the same run. Two derivations that
 * disagree by a character produce two cases for one test, quietly, forever — and nobody notices
 * until a project has both.
 *
 * The fixture below therefore describes the SAME test the adapter's own suite fakes
 * (`packages/playwright/src/__tests__/reporter.test.ts`), and the four strings pinned here are the
 * four strings pinned there. Change a derivation on either side and that side goes red with the
 * expected string in the failure — which is the only warning this coupling can give.
 */
const SAME_TEST_AS_THE_ADAPTER_FAKES = JSON.stringify({
  config: {},
  suites: [
    {
      title: 'tests/cart.spec.ts',
      file: 'tests/cart.spec.ts',
      line: 0,
      column: 0,
      specs: [],
      suites: [
        {
          title: 'cart',
          file: 'tests/cart.spec.ts',
          specs: [
            {
              title: 'rejects a negative quantity',
              ok: false,
              file: 'tests/cart.spec.ts',
              line: 12,
              column: 3,
              tests: [
                {
                  id: 'tid-1',
                  expectedStatus: 'passed',
                  annotations: [],
                  projectName: 'chromium',
                  results: [
                    {
                      workerIndex: 0,
                      status: 'failed',
                      duration: 30,
                      retry: 0,
                      startTime: '2026-09-09T10:00:00.000Z',
                      // The shape Playwright writes: `formatError` of the error — the message, the
                      // code frame and the stack's `at` lines in one text — and where it was thrown.
                      errors: [
                        {
                          message: 'Error: expected 1 to be 0\n\n    at cart.spec.ts:12:3',
                          location: { file: '/repo/tests/cart.spec.ts', line: 12, column: 3 },
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
  errors: [],
});

describe('reading a Playwright JSON report', () => {
  it('derives the identity the reporter derives, to the character', () => {
    const [result] = readPlaywrightJson(SAME_TEST_AS_THE_ADAPTER_FAKES, 'report.json').results;

    expect(result?.keys).toEqual([
      { kind: 'playwright-id', value: 'tid-1' },
      { kind: 'path-title', value: 'tests/cart.spec.ts#cart#rejects a negative quantity' },
    ]);
    expect(result?.title).toBe('cart › rejects a negative quantity');
    expect(result?.specRef).toBe('tests/cart.spec.ts:12');
    expect(result?.resultKey).toBe('tid-1#0');
  });

  it('carries the runner’s own word for the status, unmapped', () => {
    const [result] = readPlaywrightJson(SAME_TEST_AS_THE_ADAPTER_FAKES, 'report.json').results;

    expect(result?.source).toBe('playwright');
    expect(result?.rawStatus).toBe('failed');
    expect(result?.errorContext).toContain('at cart.spec.ts:12:3');
  });

  it('records when and how long, from the report', () => {
    const [result] = readPlaywrightJson(SAME_TEST_AS_THE_ADAPTER_FAKES, 'report.json').results;

    expect(result?.execution).toEqual({
      startedAt: '2026-09-09T10:00:00.000Z',
      finishedAt: '2026-09-09T10:00:00.030Z',
      durationMs: 30,
      retry: 0,
      worker: '0',
    });
  });

  it('keeps every attempt of a flaky test as its own result', () => {
    // Collapsing retries would hide the thing that makes a test flaky, and the platform's
    // `(run_id, result_key)` index is what stops them colliding — so the keys must differ.
    const flaky = JSON.stringify({
      suites: [
        {
          title: 'a.spec.ts',
          file: 'a.spec.ts',
          specs: [
            {
              title: 'flakes',
              file: 'a.spec.ts',
              line: 3,
              tests: [
                {
                  id: 'tid-9',
                  results: [
                    { status: 'failed', retry: 0, duration: 1 },
                    { status: 'passed', retry: 1, duration: 1 },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    const results = readPlaywrightJson(flaky, 'r.json').results;

    expect(results.map((r) => r.rawStatus)).toEqual(['failed', 'passed']);
    expect(results.map((r) => r.resultKey)).toEqual(['tid-9#0', 'tid-9#1']);
  });

  it('reads the case a test states outright, annotation before token', () => {
    // Same order as the adapter (ADR 0023): an annotation is the most deliberate thing an author
    // writes, and the `@P` token is the same statement made where it shows in the report.
    const stated = (over: Record<string, unknown>): string =>
      JSON.stringify({
        suites: [
          {
            title: 'a.spec.ts',
            file: 'a.spec.ts',
            specs: [
              {
                title: 'adds an item @Ptc-77',
                file: 'a.spec.ts',
                line: 1,
                tests: [{ id: 't', results: [{ status: 'passed' }], ...over }],
              },
            ],
          },
        ],
      });

    expect(readPlaywrightJson(stated({}), 'r.json').results[0]?.testCaseId).toBe('tc-77');
    expect(
      readPlaywrightJson(
        stated({ annotations: [{ type: 'PluneId', description: 'tc-annotated' }] }),
        'r.json',
      ).results[0]?.testCaseId,
    ).toBe('tc-annotated');
  });

  it('passes `test.fail()` and `test.skip()` through, and says nothing about an ordinary test', () => {
    const withExpected = (expectedStatus: string): string =>
      JSON.stringify({
        suites: [
          {
            title: 'a.spec.ts',
            file: 'a.spec.ts',
            specs: [
              { title: 't', file: 'a.spec.ts', line: 1, tests: [{ id: 'x', expectedStatus, results: [{ status: 'failed' }] }] },
            ],
          },
        ],
      });

    expect(readPlaywrightJson(withExpected('failed'), 'r.json').results[0]?.expectedStatus).toBe('failed');
    expect(readPlaywrightJson(withExpected('passed'), 'r.json').results[0]?.expectedStatus).toBeUndefined();
  });

  describe('when the file is not what it claims', () => {
    it('names the file and the reason rather than throwing a parser’s error', () => {
      expect(() => readPlaywrightJson('{not json', 'ci/report.json')).toThrow(JsonReportError);
      expect(() => readPlaywrightJson('{not json', 'ci/report.json')).toThrow(/ci\/report\.json — not JSON/);
    });

    it('refuses valid JSON that is some other tool’s report', () => {
      // A Jest JSON report is valid JSON with no `suites` — importing it as Playwright's would
      // produce zero results and look like a suite that ran nothing.
      expect(() => readPlaywrightJson('{"testResults":[]}', 'jest.json')).toThrow(/no "suites" array/);
    });
  });

  it('recognises its own shape and not the other format', () => {
    expect(looksLikePlaywrightJson('{"config":{},"suites":[]}')).toBe(true);
    expect(looksLikePlaywrightJson('<testsuites/>')).toBe(false);
  });

  it('recognises a report whose config runs long before its suites', () => {
    // Playwright writes `config` first — argv, every project, every reporter's options, the CI
    // metadata; a pinned 1.63 run of the adapter's e2e fixture put "suites" at byte 7 632 (#790 T18).
    const config = { argv: ['node', 'playwright', 'test'], projects: [{ name: 'x'.repeat(8_000) }] };
    expect(looksLikePlaywrightJson(JSON.stringify({ config, suites: [] }, null, 2))).toBe(true);
    expect(looksLikePlaywrightJson(JSON.stringify({ config, testResults: [] }, null, 2))).toBe(false);
    expect(looksLikePlaywrightJson('[{"suites":[]}]')).toBe(false);
  });
});

/**
 * #790 T16 — the import road reduces each attempt of the report to the normalized attempt the core
 * reads, so it says what failed, where and in which CI run exactly as the reporter does. The report is
 * the shape Playwright 1.63 wrote in a trial: `errors[i]` is `formatError` of each error, `steps` are
 * already only the declared ones, `config.metadata.ci.buildHref` is the CI run.
 */
describe('a failed attempt in the report carries its failure detail (#790)', () => {
  let root = '';
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plune-json-')));
    fs.mkdirSync(path.join(root, '.git'));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const BUILD = 'https://github.com/acme/shop/actions/runs/42';
  const at = (...parts: string[]) => path.join(root, ...parts);
  const WAITING = () => [
    { message: 'Test timeout of 1500ms exceeded.' },
    {
      message: [
        'Error: apiRequestContext.get: Request context disposed.',
        '',
        `    at readTotal (${at('e2e', 'helpers.ts')}:14:17)`,
        `    at ${at('e2e', 'shop.spec.ts')}:12:13`,
      ].join('\n'),
      location: { file: at('e2e', 'helpers.ts'), line: 14, column: 17 },
    },
  ];
  const report = (over: { rootDir?: string; buildHref?: string; errors?: unknown[] } = {}) =>
    JSON.stringify({
      config: { rootDir: over.rootDir ?? root, metadata: { ci: { buildHref: over.buildHref ?? BUILD, commitHash: 'abc' } } },
      suites: [
        {
          title: 'e2e/shop.spec.ts',
          file: 'e2e/shop.spec.ts',
          specs: [
            {
              title: 'pays for the basket',
              file: 'e2e/shop.spec.ts',
              line: 11,
              tests: [
                {
                  id: 't-1',
                  expectedStatus: 'passed',
                  results: [
                    {
                      status: 'timedOut',
                      retry: 0,
                      errors: over.errors ?? WAITING(),
                      steps: [
                        { title: 'Open the basket', duration: 2 },
                        { title: 'Pay', duration: 3, error: { message: 'x' }, steps: [{ title: 'Check the totals', duration: 1, error: { message: 'x' } }] },
                      ],
                      attachments: [
                        { name: 'screenshot', contentType: 'image/png', path: at('test-results', 'a', 'test-failed-1.png') },
                        { name: 'note', contentType: 'text/plain', body: 'aGk=' },
                      ],
                    },
                    { status: 'passed', retry: 1, errors: [], steps: [], attachments: [] },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

  it('says what failed, down which steps, where from the repository root, what was kept and in which CI run', () => {
    const [failed] = readPlaywrightJson(report(), 'report.json').results;
    expect(failed?.failure).toEqual({
      headline: 'Error: apiRequestContext.get: Request context disposed.',
      steps: ['Pay', 'Check the totals'],
      location: { file: 'e2e/shop.spec.ts', line: 12, column: 13 },
      artifacts: [{ name: 'screenshot', contentType: 'image/png' }],
      ciUrl: BUILD,
    });
  });

  it('writes every error in order, from the repository root', () => {
    const [failed] = readPlaywrightJson(report(), 'report.json').results;
    const text = failed?.errorContext ?? '';
    expect(text.indexOf('Test timeout of 1500ms exceeded.')).toBe(0);
    expect(text).toContain('Error: apiRequestContext.get: Request context disposed.');
    expect(text).toMatch(/at e2e[\\/]shop\.spec\.ts:12:13/);
    expect(text).not.toContain(root);
  });

  it('gives the attempt that passed no failure detail (AC-02b)', () => {
    const [, passed] = readPlaywrightJson(report(), 'report.json').results;
    expect(passed).not.toHaveProperty('failure');
    expect(passed).not.toHaveProperty('errorContext');
  });

  it('hands the CI run up for the run itself, and only an http(s) one (AC-04, AC-07b)', () => {
    expect(readPlaywrightJson(report(), 'report.json').ciUrl).toBe(BUILD);
    const refused = readPlaywrightJson(report({ buildHref: 'javascript:alert(1)' }), 'report.json');
    expect(refused.ciUrl).toBeUndefined();
    expect(refused.results[0]?.failure).not.toHaveProperty('ciUrl');
  });

  // plune#927. The commit and branch the run opens with travel as the CI run does: the report's own
  // word, whichever machine imports it. What is handed up is Playwright's `metadata.ci` as written.
  it('hands up the runner’s own CI record too, for the commit and branch the run opens with (plune#927)', () => {
    expect(readPlaywrightJson(report(), 'report.json').ci).toEqual({
      buildHref: BUILD,
      commitHash: 'abc',
    });
    // A report written on a laptop has none, and hands up nothing rather than an empty record.
    expect(readPlaywrightJson('{"config":{},"suites":[]}', 'report.json')).not.toHaveProperty('ci');
  });

  it('places a failure thrown outside the test’s own file where it was thrown', () => {
    const errors = [{ message: `Error: no test account\n    at Object.account (${at('e2e', 'helpers.ts')}:20:11)`, location: { file: at('e2e', 'helpers.ts'), line: 20, column: 11 } }];
    const [failed] = readPlaywrightJson(report({ errors }), 'report.json').results;
    expect(failed?.failure?.location).toEqual({ file: 'e2e/helpers.ts', line: 20, column: 11 });
  });

  /**
   * #790 T18. The trial run the adapter's tests replay as reporter events
   * (`packages/playwright/src/__tests__/fixtures/trial-790`), read here as its JSON report; both roads
   * answer to the one `expected.json` beside it, since neither can import the other's code.
   */
  it('reads the recorded run as the reporter reported it: failure, text, code frame and all (AC-06)', () => {
    const recorded = new URL('../../../packages/playwright/src/__tests__/fixtures/trial-790/', import.meta.url);
    fs.mkdirSync(at('tests'));
    const source = fs.readFileSync(new URL('report.json', recorded), 'utf8').replaceAll('/repo', root.replaceAll('\\', '/'));
    const expected = JSON.parse(fs.readFileSync(new URL('expected.json', recorded), 'utf8')) as Record<string, { failure?: unknown; errorContext?: string }>;
    const { results, ciUrl, ci } = readPlaywrightJson(source, 'report.json');
    expect(results.map((r) => r.title)).toEqual(Object.keys(expected));
    for (const r of results) expect({ failure: r.failure, errorContext: r.errorContext }, r.title).toEqual(expected[r.title]);
    expect(ciUrl).toBe(BUILD);
    // The commit the recording's runner wrote (plune#927) — what a real 1.63 gives under GitHub: no branch.
    expect(ci).toEqual({
      commitHref: 'https://github.com/acme/shop/commit/0123456789abcdef0123456789abcdef01234567',
      commitHash: '0123456789abcdef0123456789abcdef01234567',
      buildHref: BUILD,
    });
    // Not a baseline two roads could meet by both saying nothing: each code frame is there, its line marked.
    expect(expected['times out while a helper waits']?.errorContext).toContain('> 14 |   await request.get(url);');
    expect(expected['several soft assertions']?.errorContext).toContain("> 24 |       expect.soft('EUR', 'the currency').toBe('USD');");
  });

  it('from another machine keeps the detail but names no place — not even inside a repository here', () => {
    const [failed] = readPlaywrightJson(report({ rootDir: at('gone') }), 'report.json').results;
    expect(failed?.failure?.headline).toBe('Error: apiRequestContext.get: Request context disposed.');
    expect(failed?.failure).not.toHaveProperty('location');
  });
});

/**
 * plune-ai/plune#913 and #928. A Playwright JSON report names what each attempt kept: a file by its `path`,
 * or — what `testInfo.attach(name, { body })` leaves — the bytes themselves, as base64 in `body`. Both go to
 * the core as the files of the result; a body is decoded only where the platform would take it, since
 * a report full of screenshots kept as bodies is megabytes of base64 nothing will read.
 */
describe('the files a report keeps (plune#913, plune#928)', () => {
  const report = (attachments: unknown[]): string =>
    JSON.stringify({
      config: {},
      suites: [
        {
          title: 'a.spec.ts',
          file: 'a.spec.ts',
          specs: [{ title: 't', file: 'a.spec.ts', line: 1, tests: [{ id: 'id-1', results: [{ status: 'passed', retry: 0, attachments }] }] }],
        },
      ],
    });
  const filesOfReport = (attachments: unknown[]) => readPlaywrightJson(report(attachments), 'report.json').results[0]?.files;
  const b64 = (text: string | Buffer): string => Buffer.from(text).toString('base64');

  it('hands over what was kept as a file, whatever its type, as it always has', () => {
    const kept = [
      { name: 'screenshot', contentType: 'image/png', path: '/repo/test-results/a/test-finished-1.png' },
      { name: 'trace', contentType: 'application/zip', path: '/repo/test-results/a/trace.zip' },
      { name: 'api-response', contentType: 'application/json', path: '/repo/test-results/a/attachments/api-response-1a2b.json' },
    ];

    expect(filesOfReport(kept)).toEqual(kept);
  });

  it('decodes a JSON or a text kept as a body into the bytes it held', () => {
    const json = '{"items":[1,2,3],"ok":true}';
    const log = 'GET /cart 200 привіт 日本語 😀\n';
    const files = filesOfReport([
      { name: 'api-response', contentType: 'application/json', body: b64(json) },
      { name: 'console.log', contentType: 'text/plain', body: b64(log) },
      { name: 'Report', contentType: 'TEXT/PLAIN; charset=UTF-8', body: b64('x') },
    ]);

    expect(files?.map((f) => ({ name: f.name, contentType: f.contentType, text: f.body?.toString('utf8') }))).toEqual([
      { name: 'api-response', contentType: 'application/json', text: json },
      { name: 'console.log', contentType: 'text/plain', text: log },
      { name: 'Report', contentType: 'TEXT/PLAIN; charset=UTF-8', text: 'x' },
    ]);
    expect(Buffer.isBuffer(files?.[0]?.body)).toBe(true);
    expect(files?.[0]).not.toHaveProperty('path');
  });

  it('keeps the bytes of a text as they are — a Latin-1 one too, which is for the core to refuse, not for this to repair', () => {
    const latin1 = Buffer.from('café', 'latin1');

    expect(filesOfReport([{ name: 'legacy', contentType: 'text/plain', body: b64(latin1) }])?.[0]?.body).toEqual(latin1);
  });

  it('does not decode a body that is not a text: an image, a trace, markdown, an unnamed type', () => {
    const files = filesOfReport([
      { name: 'screenshot', contentType: 'image/png', body: b64('png') },
      { name: 'trace', contentType: 'application/zip', body: b64('PK') },
      { name: 'error-context', contentType: 'text/markdown', body: b64('# x') },
      { name: 'plune', contentType: 'application/plune.metadata+json', body: b64('{"id":"tc-1"}') },
      { name: 'untyped', body: b64('x') },
    ]);

    expect(files).toBeUndefined();
  });

  it('decodes only the bodies it will hand over — a screenshot kept as a body is megabytes nothing here reads', () => {
    const source = report([
      { name: 'screenshot', contentType: 'image/png', body: b64('png') },
      { name: 'trace', contentType: 'application/zip', body: b64('PK') },
      { name: 'log', contentType: 'text/plain', body: b64('x') },
    ]);
    const from = vi.spyOn(Buffer, 'from');
    try {
      readPlaywrightJson(source, 'report.json');

      expect(from.mock.calls.filter(([, encoding]) => encoding === 'base64').map(([text]) => text)).toEqual([b64('x')]);
    } finally {
      from.mockRestore();
    }
  });

  it('hands over nothing for an attachment that holds neither a file nor a body, and ignores a body that is no string', () => {
    const files = filesOfReport([
      { name: 'note', contentType: 'text/plain' },
      { name: 'odd', contentType: 'text/plain', body: 42 },
      { name: 'kept', contentType: 'text/plain', body: b64('x') },
    ]);

    expect(files?.map((f) => f.name)).toEqual(['kept']);
  });

  it('keeps the two kinds in the order the report lists them', () => {
    const files = filesOfReport([
      { name: 'a', contentType: 'text/plain', body: b64('a') },
      { name: 'b', contentType: 'image/png', path: '/repo/b.png' },
      { name: 'c', contentType: 'application/json', body: b64('{}') },
    ]);

    expect(files?.map((f) => f.name)).toEqual(['a', 'b', 'c']);
  });

  it('adds no text kept as a body to the failure’s artifacts — the CI run does not hold one', () => {
    const failed = JSON.stringify({
      config: {},
      suites: [
        {
          title: 'a.spec.ts',
          file: 'a.spec.ts',
          specs: [
            {
              title: 't',
              file: 'a.spec.ts',
              line: 1,
              tests: [
                {
                  id: 'id-1',
                  results: [
                    {
                      status: 'failed',
                      retry: 0,
                      errors: [{ message: 'Error: boom' }],
                      attachments: [
                        { name: 'api-response', contentType: 'application/json', body: b64('{}') },
                        { name: 'server.log', contentType: 'text/plain', path: '/repo/test-results/a/server.log' },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    expect(readPlaywrightJson(failed, 'report.json').results[0]?.failure?.artifacts).toEqual([
      { name: 'server.log', contentType: 'text/plain' },
    ]);
  });
});
