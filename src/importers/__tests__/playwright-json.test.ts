import { describe, it, expect } from 'vitest';
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
                      errors: [{ message: 'expected 1 to be 0', stack: 'at cart.spec.ts:12:3' }],
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
    const [result] = readPlaywrightJson(SAME_TEST_AS_THE_ADAPTER_FAKES, 'report.json');

    expect(result?.keys).toEqual([
      { kind: 'playwright-id', value: 'tid-1' },
      { kind: 'path-title', value: 'tests/cart.spec.ts#cart#rejects a negative quantity' },
    ]);
    expect(result?.title).toBe('cart › rejects a negative quantity');
    expect(result?.specRef).toBe('tests/cart.spec.ts:12');
    expect(result?.resultKey).toBe('tid-1#0');
  });

  it('carries the runner’s own word for the status, unmapped', () => {
    const [result] = readPlaywrightJson(SAME_TEST_AS_THE_ADAPTER_FAKES, 'report.json');

    expect(result?.source).toBe('playwright');
    expect(result?.rawStatus).toBe('failed');
    expect(result?.errorContext).toContain('at cart.spec.ts:12:3');
  });

  it('records when and how long, from the report', () => {
    const [result] = readPlaywrightJson(SAME_TEST_AS_THE_ADAPTER_FAKES, 'report.json');

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
    const results = readPlaywrightJson(flaky, 'r.json');

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

    expect(readPlaywrightJson(stated({}), 'r.json')[0]?.testCaseId).toBe('tc-77');
    expect(
      readPlaywrightJson(
        stated({ annotations: [{ type: 'PluneId', description: 'tc-annotated' }] }),
        'r.json',
      )[0]?.testCaseId,
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

    expect(readPlaywrightJson(withExpected('failed'), 'r.json')[0]?.expectedStatus).toBe('failed');
    expect(readPlaywrightJson(withExpected('passed'), 'r.json')[0]?.expectedStatus).toBeUndefined();
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
});
