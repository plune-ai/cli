import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FullConfig, FullResult, Suite, TestCase, TestResult } from '@playwright/test/reporter';
import type { PendingResult } from '@plune-ai/cli/reporter-core';

const added: PendingResult[] = [];
const expectedLists: unknown[] = [];
const calls: string[] = [];
let startThrows = false;

vi.mock('@plune-ai/cli/reporter-core', async () => {
  const actual = await vi.importActual<typeof import('@plune-ai/cli/reporter-core')>(
    '@plune-ai/cli/reporter-core',
  );
  return {
    // `resultKey` and `readEnv` are pure; stubbing them would test the stub.
    resultKey: actual.resultKey,
    readEnv: actual.readEnv,
    startRun: vi.fn(async (_cfg: unknown, expected: unknown) => {
      if (startThrows) throw new Error('platform exploded');
      expectedLists.push(expected);
      return {
        runId: 'r-1',
        joined: false,
        stats: {},
        add: async (r: PendingResult) => void added.push(r),
        flush: async () => undefined,
        finish: async () => void calls.push('finish'),
        leaveOpen: async () => void calls.push('leaveOpen'),
      };
    }),
  };
});

const { default: PluneReporter } = await import('../index.js');

beforeEach(() => {
  added.length = 0;
  expectedLists.length = 0;
  calls.length = 0;
  startThrows = false;
});

const fileSuite = { type: 'file', title: 'tests/cart.spec.ts', parent: undefined };
const describeSuite = { type: 'describe', title: 'cart', parent: fileSuite };

function fakeTest(over: Partial<Record<string, unknown>> = {}): TestCase {
  return {
    id: 'tid-1',
    title: 'rejects a negative quantity',
    annotations: [],
    expectedStatus: 'passed',
    parent: describeSuite,
    ...over,
  } as unknown as TestCase;
}

function fakeResult(over: Partial<Record<string, unknown>> = {}): TestResult {
  return {
    status: 'passed',
    retry: 0,
    duration: 1500,
    startTime: new Date('2026-09-08T10:00:00.000Z'),
    workerIndex: 3,
    errors: [],
    ...over,
  } as unknown as TestResult;
}

const suiteOf = (...tests: TestCase[]): Suite => ({ allTests: () => tests }) as unknown as Suite;
const configWith = (shard: unknown): FullConfig => ({ shard }) as unknown as FullConfig;

async function run(
  reporter: InstanceType<typeof PluneReporter>,
  tests: TestCase[],
  results: TestResult[],
  shard: unknown = null,
): Promise<void> {
  reporter.onConfigure(configWith(shard));
  reporter.onBegin(suiteOf(...tests));
  tests.forEach((t, i) => reporter.onTestEnd(t, results[i] as TestResult));
  await reporter.onEnd({} as FullResult);
}

describe('what the adapter tells the core about a test', () => {
  it('offers the stable id first and the readable path second', async () => {
    await run(new PluneReporter(), [fakeTest()], [fakeResult()]);

    expect(added[0]?.keys).toEqual([
      { kind: 'playwright-id', value: 'tid-1' },
      { kind: 'path-title', value: 'tests/cart.spec.ts#cart#rejects a negative quantity' },
    ]);
  });

  it('builds the path from the suite tree, not from a guess at the title path', async () => {
    const nested = {
      type: 'describe',
      title: 'when empty',
      parent: describeSuite,
    };
    await run(new PluneReporter(), [fakeTest({ parent: nested })], [fakeResult()]);

    expect(added[0]?.keys[1]?.value).toBe(
      'tests/cart.spec.ts#cart#when empty#rejects a negative quantity',
    );
  });

  it('hands the whole test list over at the start, so the lookup is one request', async () => {
    const tests = [fakeTest({ id: 'a' }), fakeTest({ id: 'b' })];
    await run(new PluneReporter(), tests, [fakeResult(), fakeResult()]);

    expect((expectedLists[0] as unknown[])).toHaveLength(2);
  });
});

describe('what the adapter refuses to decide', () => {
  // The platform maps `timedOut` per project. A reporter that translated it here would freeze that
  // decision at release time and put a different answer on a different surface.
  it('passes the runner word through and sets no status', async () => {
    await run(new PluneReporter(), [fakeTest()], [fakeResult({ status: 'timedOut' })]);

    expect(added[0]?.rawStatus).toBe('timedOut');
    expect('status' in (added[0] as object)).toBe(false);
    expect(added[0]?.source).toBe('playwright');
  });

  it('says nothing about an expectation when a pass was expected', async () => {
    await run(new PluneReporter(), [fakeTest()], [fakeResult()]);

    expect(added[0]?.expectedStatus).toBeUndefined();
  });

  it('carries test.fail() through as-is — the two vocabularies spell it the same', async () => {
    await run(new PluneReporter(), [fakeTest({ expectedStatus: 'failed' })], [fakeResult()]);

    expect(added[0]?.expectedStatus).toBe('failed');
  });
});

describe('identity and timing', () => {
  it('lets a PluneId annotation name the case outright', async () => {
    const test = fakeTest({ annotations: [{ type: 'PluneId', description: 'tc-99' }] });
    await run(new PluneReporter(), [test], [fakeResult()]);

    expect(added[0]?.testCaseId).toBe('tc-99');
  });

  it('gives each retry of one test its own key', async () => {
    const test = fakeTest();
    const reporter = new PluneReporter();
    reporter.onConfigure(configWith(null));
    reporter.onBegin(suiteOf(test));
    reporter.onTestEnd(test, fakeResult({ retry: 0 }));
    reporter.onTestEnd(test, fakeResult({ retry: 1 }));
    await reporter.onEnd({} as FullResult);

    expect(added[0]?.resultKey).not.toBe(added[1]?.resultKey);
  });

  it('reports when the test ended, not just how long it took', async () => {
    await run(new PluneReporter(), [fakeTest()], [fakeResult()]);

    expect(added[0]?.execution).toEqual({
      startedAt: '2026-09-08T10:00:00.000Z',
      finishedAt: '2026-09-08T10:00:01.500Z',
      durationMs: 1500,
      retry: 0,
      worker: '3',
    });
  });

  it('sends the stacks a failure produced, and nothing when it produced none', async () => {
    await run(
      new PluneReporter(),
      [fakeTest(), fakeTest({ id: 'b' })],
      [fakeResult({ errors: [{ stack: 'Error: boom\n  at cart.spec.ts:12' }] }), fakeResult()],
    );

    expect(added[0]?.errorContext).toContain('at cart.spec.ts:12');
    expect(added[1]?.errorContext).toBeUndefined();
  });
});

describe('who closes the run (AC-03)', () => {
  it('closes it when this process ran everything', async () => {
    await run(new PluneReporter(), [fakeTest()], [fakeResult()], null);

    expect(calls).toEqual(['finish']);
  });

  // A shard cannot know the others are done. Closing here would mark a run finished while three
  // quarters of it was still running — the exact reading AC-08 exists to prevent.
  it('leaves it open when this process is one shard of several', async () => {
    await run(new PluneReporter(), [fakeTest()], [fakeResult()], { current: 2, total: 4 });

    expect(calls).toEqual(['leaveOpen']);
  });

  // Playwright cannot see a `merge-reports` step or a second suite reporting into the same run, so
  // the job says so instead.
  it('leaves it open when the job says another process will close it', async () => {
    process.env['PLUNE_PROCEED'] = '1';
    try {
      await run(new PluneReporter(), [fakeTest()], [fakeResult()], null);
    } finally {
      delete process.env['PLUNE_PROCEED'];
    }

    expect(calls).toEqual(['leaveOpen']);
  });
});

describe('the reporter never fails the run', () => {
  it('swallows a core that could not start, and says so once', async () => {
    startThrows = true;
    const written: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });

    await expect(run(new PluneReporter(), [fakeTest()], [fakeResult()])).resolves.toBeUndefined();
    spy.mockRestore();

    expect(written.filter((l) => l.includes('reporting stopped'))).toHaveLength(1);
  });

  it('does nothing at all if it was never begun', async () => {
    const reporter = new PluneReporter();
    await expect(reporter.onEnd({} as FullResult)).resolves.toBeUndefined();
    expect(calls).toEqual([]);
  });
});

describe('it stays out of the terminal', () => {
  it('leaves stdio to the runner reporter', () => {
    expect(new PluneReporter().printsToStdio()).toBe(false);
    expect(new PluneReporter().version()).toBe('v2');
  });
});
