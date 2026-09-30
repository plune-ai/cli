import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import type { FullConfig, FullResult, Suite, TestCase, TestResult } from '@playwright/test/reporter';
import type { PendingResult } from '@plune-ai/cli/reporter-core';

const added: PendingResult[] = [];
const expectedLists: unknown[] = [];
const startConfigs: Record<string, unknown>[] = [];
const rootsAsked: string[] = [];
const calls: string[] = [];
/** How many results the core had taken when the run was closed or left open. */
const addedAtClose: number[] = [];
/** A test's own `add` — how the core takes a result; the default only records it. */
let addImpl: ((r: PendingResult) => Promise<void>) | null = null;
let startThrows = false;

vi.mock('@plune-ai/cli/reporter-core', async () => {
  const actual = await vi.importActual<typeof import('@plune-ai/cli/reporter-core')>(
    '@plune-ai/cli/reporter-core',
  );
  return {
    // `resultKey`, `readEnv` and `ciCommit` are pure; stubbing them would test the stub.
    resultKey: actual.resultKey,
    readEnv: actual.readEnv,
    ciCommit: actual.ciCommit,
    // The same for what the failure detail is made of (#790): the adapter's part is the attempt.
    errorContextOf: actual.errorContextOf,
    failureOf: actual.failureOf,
    filesOf: actual.filesOf,
    webLink: actual.webLink,
    // The one that reads the disk. The recorded run's repository is `/repo`, not on this machine.
    repoRootOf: vi.fn((dir: string) => {
      rootsAsked.push(dir);
      return '/repo';
    }),
    startRun: vi.fn(async (cfg: Record<string, unknown>, expected: unknown) => {
      if (startThrows) throw new Error('platform exploded');
      startConfigs.push(cfg);
      expectedLists.push(expected);
      return {
        runId: 'r-1',
        joined: false,
        stats: {},
        add: async (r: PendingResult) => (addImpl === null ? void added.push(r) : addImpl(r)),
        flush: async () => undefined,
        finish: async () => {
          calls.push('finish');
          addedAtClose.push(added.length);
        },
        leaveOpen: async () => {
          calls.push('leaveOpen');
          addedAtClose.push(added.length);
        },
      };
    }),
  };
});

const { default: PluneReporter } = await import('../index.js');

beforeEach(() => {
  added.length = 0;
  expectedLists.length = 0;
  startConfigs.length = 0;
  rootsAsked.length = 0;
  calls.length = 0;
  addedAtClose.length = 0;
  addImpl = null;
  startThrows = false;
  // The run opens with the commit and branch of the CI it runs in (plune#927), so these tests are
  // not to know which CI that is: on GitHub Actions they would open every run with its own.
  for (const marker of ['GITHUB_ACTIONS', 'GITLAB_CI', 'JENKINS_URL']) vi.stubEnv(marker, '');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const fileSuite = { type: 'file', title: 'tests/cart.spec.ts', parent: undefined };
const describeSuite = { type: 'describe', title: 'cart', parent: fileSuite };

function fakeTest(over: Partial<Record<string, unknown>> = {}): TestCase {
  return {
    id: 'tid-1',
    title: 'rejects a negative quantity',
    annotations: [],
    expectedStatus: 'passed',
    // Playwright always sets it; the adapter reads the line for `specRef` (D14), so a fake without
    // one is a fake of a `TestCase` that cannot exist.
    location: { file: 'tests/cart.spec.ts', line: 12, column: 3 },
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
    attachments: [],
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
  /**
   * These four strings are pinned twice.
   *
   * `plune run import` derives the same identity for the same test out of a Playwright JSON report
   * (`src/importers/__tests__/playwright-json.test.ts`, which fakes THIS test). Two derivations
   * that disagree by a character give one test two cases in Plune — quietly, and forever. A
   * package boundary stops one test from running both, so each side pins the literal instead:
   * change a derivation here and this file goes red with the string the other side expects.
   */
  it('offers the stable id first and the readable path second', async () => {
    await run(new PluneReporter(), [fakeTest()], [fakeResult()]);

    expect(added[0]?.keys).toEqual([
      { kind: 'playwright-id', value: 'tid-1' },
      { kind: 'path-title', value: 'tests/cart.spec.ts#cart#rejects a negative quantity' },
    ]);
  });

  it('spells the file with forward slashes whatever the OS titled it with', async () => {
    // Playwright titles the file suite with `path.relative` — backslashes on Windows — and writes
    // the JSON report posix-style; a key that differed by the OS met its import only by id.
    const windowsFile = { type: 'file', title: 'tests\\cart.spec.ts', parent: undefined };
    const test = fakeTest({ parent: { type: 'describe', title: 'cart', parent: windowsFile } });
    await run(new PluneReporter(), [test], [fakeResult()]);

    expect(added[0]?.keys).toContainEqual({
      kind: 'path-title',
      value: 'tests/cart.spec.ts#cart#rejects a negative quantity',
    });
    expect(added[0]?.specRef).toBe('tests/cart.spec.ts:12');
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

  /**
   * The adapter's half of D14. The core offers an unresolved test to the review queue and needs two
   * things it cannot derive: a name a person can judge, and somewhere to open. Both are read ONLY on
   * that path — a test that found its case has a case with a title of its own.
   */
  it('names the test and where it lives, for the queue it might end up in', async () => {
    await run(new PluneReporter(), [fakeTest()], [fakeResult()]);

    // The `describe` path, not the bare title: two suites in one file routinely share a title, and
    // "rejects a negative quantity" alone is not something a reviewer can act on.
    expect(added[0]?.title).toBe('cart › rejects a negative quantity');
    // With the line. A reviewer's first move on an unknown test is to open it.
    expect(added[0]?.specRef).toBe('tests/cart.spec.ts:12');
  });

  /**
   * plune-ai/plune#913. The core uploads the screenshots among them once the result is stored, so a
   * person sees what a green test looked at, not only a red one. An image or a trace kept in memory is
   * no file, and an attachment with nothing in it (`attach(name)`) has nothing to hand over; only a text
   * is read from memory (#928, below).
   */
  it('hands the core every file the attempt kept, a passed one’s too', async () => {
    const attachments = [
      { name: 'screenshot', contentType: 'image/png', path: '/repo/test-results/cart/test-finished-1.png' },
      { name: 'trace', contentType: 'application/zip', path: '/repo/test-results/cart/trace.zip' },
      { name: 'shot', contentType: 'image/png', body: Buffer.from('png') },
      { name: 'blob', contentType: 'application/octet-stream', body: Buffer.from('x') },
      { name: 'nothing', contentType: 'text/plain' },
    ];
    await run(new PluneReporter(), [fakeTest()], [fakeResult({ status: 'passed', attachments })]);

    expect(added[0]?.files).toEqual([
      { name: 'screenshot', contentType: 'image/png', path: '/repo/test-results/cart/test-finished-1.png' },
      { name: 'trace', contentType: 'application/zip', path: '/repo/test-results/cart/trace.zip' },
    ]);
    expect(added[0]).not.toHaveProperty('failure');
  });

  /**
   * plune-ai/plune#928. What a test attaches as a `body` — `testInfo.attach('api-response', { body:
   * JSON.stringify(…), contentType: 'application/json' })` — is not a file: Playwright hands the reporter
   * the bytes, and this callback is the only place they are. The adapter passes them on as they are, for
   * the core to upload once the result is stored.
   */
  it('hands the core a JSON or a text a test attached as a body, with the bytes it holds', async () => {
    const json = Buffer.from(JSON.stringify({ ok: true, items: [1, 2] }));
    const log = Buffer.from('GET /cart 200 привіт\n');
    const attachments = [
      { name: 'api-response', contentType: 'application/json', body: json },
      { name: 'console.log', contentType: 'text/plain', body: log },
      { name: 'Report', contentType: 'Text/Plain; charset=UTF-8', body: Buffer.from('x') },
    ];
    await run(new PluneReporter(), [fakeTest()], [fakeResult({ status: 'passed', attachments })]);

    expect(added[0]?.files).toEqual([
      { name: 'api-response', contentType: 'application/json', body: json },
      { name: 'console.log', contentType: 'text/plain', body: log },
      { name: 'Report', contentType: 'Text/Plain; charset=UTF-8', body: Buffer.from('x') },
    ]);
    expect(Buffer.isBuffer(added[0]?.files?.[0]?.body)).toBe(true);
  });

  it('hands over a text kept as a file by its path as before, and the two kinds together in the order they were attached', async () => {
    const attachments = [
      { name: 'console.log', contentType: 'text/plain', body: Buffer.from('log') },
      { name: 'api-response', contentType: 'application/json', path: '/repo/test-results/cart/attachments/api-response-1a2b.json' },
      { name: 'screenshot', contentType: 'image/png', path: '/repo/test-results/cart/test-finished-1.png' },
    ];
    await run(new PluneReporter(), [fakeTest()], [fakeResult({ attachments })]);

    expect(added[0]?.files).toEqual([
      { name: 'console.log', contentType: 'text/plain', body: Buffer.from('log') },
      { name: 'api-response', contentType: 'application/json', path: '/repo/test-results/cart/attachments/api-response-1a2b.json' },
      { name: 'screenshot', contentType: 'image/png', path: '/repo/test-results/cart/test-finished-1.png' },
    ]);
  });

  // The run page says of `artifacts` that the rest of them "stay in the CI run" — true of a file the runner
  // kept, and not of a body, which no CI run holds. A text kept as a body is uploaded, not listed there.
  it('lists no text kept as a body among a failure’s artifacts — only the files, as before', async () => {
    const attachments = [
      { name: 'api-response', contentType: 'application/json', body: Buffer.from('{}') },
      { name: 'server.log', contentType: 'text/plain', path: '/repo/test-results/cart/attachments/server.log-1a2b.log' },
    ];
    await run(new PluneReporter(), [fakeTest()], [fakeResult({ status: 'failed', errors: [{ message: 'Error: boom' }], attachments })]);

    expect(added[0]?.failure?.artifacts).toEqual([{ name: 'server.log', contentType: 'text/plain' }]);
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

  // The id follows `@P` immediately. A space means the author wrote something else, and guessing
  // that the next word is a case id would attach results to whatever happened to be there.
  it('does not treat a word after a space as an id', async () => {
    await run(new PluneReporter(), [fakeTest({ title: 'adds an item @P tc-77' })], [fakeResult()]);

    expect(added[0]?.testCaseId).toBeUndefined();
  });

  it('reads a token in the title', async () => {
    await run(new PluneReporter(), [fakeTest({ title: 'adds an item @Ptc-77' })], [fakeResult()]);

    expect(added[0]?.testCaseId).toBe('tc-77');
  });

  it('reads a case id a fixture attached', async () => {
    const attached = fakeResult({
      attachments: [
        { name: 'plune', contentType: 'application/plune.metadata+json', body: Buffer.from('{"id":"tc-42"}') },
      ],
    });
    await run(new PluneReporter(), [fakeTest()], [attached]);

    expect(added[0]?.testCaseId).toBe('tc-42');
  });

  // A person editing a title should not be overruled by something generated.
  it('lets the annotation win over an attachment', async () => {
    const test = fakeTest({ annotations: [{ type: 'PluneId', description: 'tc-annotated' }] });
    const attached = fakeResult({
      attachments: [
        { name: 'plune', contentType: 'application/plune.metadata+json', body: Buffer.from('{"id":"tc-attached"}') },
      ],
    });
    await run(new PluneReporter(), [test], [attached]);

    expect(added[0]?.testCaseId).toBe('tc-annotated');
  });

  it('puts keys a fixture supplied ahead of the ones we guessed', async () => {
    const attached = fakeResult({
      attachments: [
        {
          name: 'plune',
          contentType: 'application/plune.metadata+json',
          body: Buffer.from('{"keys":[{"kind":"qase","value":"Q-9"}]}'),
        },
      ],
    });
    await run(new PluneReporter(), [fakeTest()], [attached]);

    expect(added[0]?.keys[0]).toEqual({ kind: 'qase', value: 'Q-9' });
    expect(added[0]?.keys).toHaveLength(3);
  });

  // A rung that cannot be read says nothing; it does not break the run.
  it('ignores an attachment it cannot parse', async () => {
    const attached = fakeResult({
      attachments: [
        { name: 'plune', contentType: 'application/plune.metadata+json', body: Buffer.from('not json') },
      ],
    });
    await run(new PluneReporter(), [fakeTest()], [attached]);

    expect(added[0]?.testCaseId).toBeUndefined();
    expect(added[0]?.keys).toHaveLength(2);
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

/**
 * #790 review F4. The core sends a batch from inside `add` once enough results are buffered, and a
 * batch takes as long as the platform does. A run closed while one is in flight freezes `notRun`
 * without it and refuses the batches behind it — the AC-15 run lost 40 of 100 that way.
 */
describe('every result reaches the core before the run closes (AC-15)', () => {
  it('waits for the batches the core is still sending, then closes the run', async () => {
    // The core's rhythm at batchSize 2: every second result sends both, and the platform takes its time.
    const buffered: PendingResult[] = [];
    addImpl = async (r) => {
      buffered.push(r);
      if (buffered.length < 2) return;
      const batch = buffered.splice(0);
      await new Promise((resolve) => setTimeout(resolve, 20));
      added.push(...batch);
    };
    const tests = ['a', 'b', 'c', 'd'].map((id) => fakeTest({ id }));

    await run(new PluneReporter(), tests, tests.map(() => fakeResult()));

    expect(addedAtClose).toEqual([4]);
  });

  it('says once that the core refused a result, and leaves no rejection unhandled', async () => {
    addImpl = async () => {
      throw new Error('the platform said no');
    };
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => void unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    const written: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    try {
      const tests = [fakeTest({ id: 'a' }), fakeTest({ id: 'b' })];
      await expect(run(new PluneReporter(), tests, tests.map(() => fakeResult()))).resolves.toBeUndefined();
      // Node reports an unhandled rejection once the microtasks run dry — a macrotask later.
      await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      spy.mockRestore();
      process.off('unhandledRejection', onUnhandled);
    }

    expect(unhandled).toEqual([]);
    expect(written.filter((l) => l.includes('reporting stopped — the platform said no'))).toHaveLength(1);
    expect(calls).toEqual(['finish']);
  });
});

describe('a run exists only once a result does', () => {
  // `onBegin` fires for `--list`, for a `--grep` that matches nothing and for a suite of zero
  // tests. Opening the run there put an empty run on the platform every time a person listed
  // their tests with a token set — and with a rejected token, the one request left pending at
  // exit tripped a libuv assertion on Windows. The list is still taken at the start; the run
  // opens on the first result.
  it('opens no run when nothing reports a result — --list, an empty filter, zero tests', async () => {
    const { startRun } = await import('@plune-ai/cli/reporter-core');
    vi.mocked(startRun).mockClear();

    // `--list` and an empty filter: the runner announces the tests and ends; `onTestEnd` never fires.
    for (const tests of [[fakeTest({ id: 'a' }), fakeTest({ id: 'b' })], []]) {
      const reporter = new PluneReporter();
      reporter.onConfigure(configWith(null));
      reporter.onBegin(suiteOf(...tests));
      await reporter.onEnd({} as FullResult);
    }

    expect(startRun).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('still hands the whole declared list over, once, on the first result', async () => {
    const { startRun } = await import('@plune-ai/cli/reporter-core');
    vi.mocked(startRun).mockClear();
    const tests = [fakeTest({ id: 'a' }), fakeTest({ id: 'b' }), fakeTest({ id: 'c' })];

    await run(new PluneReporter(), tests, [fakeResult(), fakeResult(), fakeResult()]);

    expect(startRun).toHaveBeenCalledTimes(1);
    expect(expectedLists[0] as unknown[]).toHaveLength(3);
    expect(added).toHaveLength(3);
    expect(calls).toEqual(['finish']);
  });
});

describe('it stays out of the terminal', () => {
  it('leaves stdio to the runner reporter', () => {
    expect(new PluneReporter().printsToStdio()).toBe(false);
    expect(new PluneReporter().version()).toBe('v2');
  });
});

/**
 * #790 T17. Replays what Playwright 1.63 handed a reporter in a trial run (`fixtures/trial-790`,
 * recorded beside the JSON report of the same run; the machine's paths put under `/repo`): a test that
 * timed out while a helper waited, one with two soft assertions, one whose fixture threw in another
 * file, one that passed — each with the hooks, fixtures and actions a real run has around its steps.
 */
describe('what failed and where, from a recorded run (#790)', () => {
  interface RecordedStep {
    title: string;
    category: string;
    error?: { message: string };
    steps: RecordedStep[];
  }
  interface RecordedEvent {
    title: string;
    file: string;
    line: number;
    status: string;
    retry: number;
    errors: unknown[];
    steps: RecordedStep[];
    attachments: { name: string; contentType: string; path?: string; body?: number }[];
  }
  const fixture = (name: string): unknown =>
    JSON.parse(readFileSync(new URL(`./fixtures/trial-790/${name}`, import.meta.url), 'utf8'));
  const recorded = fixture('events.json') as { rootDir: string; ciAtBegin: Record<string, string>; events: RecordedEvent[] };
  const CI = recorded.ciAtBegin['buildHref'];

  /** The run again: `metadata.ci` arrives after `onConfigure`, as the git plugin adds it (ADR-0004). */
  async function replay(): Promise<void> {
    const file = { type: 'file', title: 'shop.spec.ts', parent: undefined };
    const tests = recorded.events.map((e, i) =>
      fakeTest({ id: `rec-${i}`, title: e.title, location: { file: e.file, line: e.line, column: 1 }, parent: file }),
    );
    const results = recorded.events.map((e) =>
      fakeResult({
        status: e.status,
        retry: e.retry,
        errors: e.errors,
        steps: e.steps,
        attachments: e.attachments.map(({ body, ...a }) => (body === undefined ? a : { ...a, body: Buffer.alloc(body) })),
      }),
    );
    const config = { shard: null, rootDir: recorded.rootDir, metadata: {} as Record<string, unknown> };
    const reporter = new PluneReporter();
    reporter.onConfigure(config as unknown as FullConfig);
    config.metadata['ci'] = recorded.ciAtBegin;
    reporter.onBegin(suiteOf(...tests));
    tests.forEach((t, i) => reporter.onTestEnd(t, results[i] as TestResult));
    await reporter.onEnd({} as FullResult);
  }
  const reported = (title: string): PendingResult | undefined => added.find((r) => r.title === title);

  it('opens the run with the CI run the git plugin wrote after onConfigure, and finds the root once (AC-04)', async () => {
    await replay();
    // With its commit too (plune#927): the same recording holds `commitHash`, and no branch — GitHub
    // gives none, and there is no GitHub environment here to name one.
    expect(startConfigs[0]?.['meta']).toEqual({
      runner: 'playwright',
      ciUrl: CI,
      sha: recorded.ciAtBegin['commitHash'],
    });
    expect(rootsAsked).toEqual([recorded.rootDir]);
  });

  it('on a timeout names the action still waiting, the declared steps down to it and the test’s own line (AC-01c, AC-02)', async () => {
    await replay();
    expect(reported('times out while a helper waits')?.failure).toEqual({
      headline: 'Error: apiRequestContext.get: Request context disposed.',
      steps: ['Pay', 'Read the total'],
      location: { file: 'tests/shop.spec.ts', line: 12, column: 13 },
      artifacts: [{ name: 'error-context', contentType: 'text/markdown' }],
      ciUrl: CI,
    });
  });

  it('keeps hooks, fixtures and actions out of the chain — declared steps from the test body only (AC-02c)', async () => {
    await replay();
    expect(reported('several soft assertions')?.failure?.steps).toEqual(['Pay', 'Check the totals']);
    const thrown = reported('fails in a fixture from another file')?.failure;
    expect(thrown).not.toHaveProperty('steps');
    expect(thrown?.location).toEqual({ file: 'tests/helpers.ts', line: 20, column: 11 });
  });

  it('gives the attempt that passed no failure and no text (AC-02b)', async () => {
    await replay();
    expect(reported('passes')).not.toHaveProperty('failure');
    expect(reported('passes')).not.toHaveProperty('errorContext');
  });

  /**
   * #790 T18. `expected.json` is what `plune run import` makes of `report.json`, the same run read the
   * other road; `src/importers/__tests__/playwright-json.test.ts` holds the importer to the same file.
   * Neither road can import the other's code, so they meet at the file.
   */
  it('gives every attempt the failure and the text the JSON report of the same run gives (AC-06)', async () => {
    await replay();
    const expected = fixture('expected.json') as Record<string, { failure?: unknown; errorContext?: string }>;
    expect(Object.keys(expected)).toEqual(recorded.events.map((e) => e.title));
    for (const { title } of recorded.events) {
      expect({ failure: reported(title)?.failure, errorContext: reported(title)?.errorContext }, title).toEqual(expected[title]);
    }
  });

  it('follows the declared step that failed, not the first one', async () => {
    const steps = [
      { title: 'Open the basket', category: 'test.step', steps: [] },
      { title: 'Pay', category: 'test.step', error: { message: 'x' }, steps: [{ title: 'Card', category: 'test.step', error: { message: 'x' }, steps: [] }] },
    ];
    await run(new PluneReporter(), [fakeTest()], [fakeResult({ status: 'failed', errors: [{ message: 'Error: boom' }], steps })]);
    expect(added[0]?.failure?.steps).toEqual(['Pay', 'Card']);
  });

  it('writes an error as formatError does: no code frame without a place, and the cause after the stack', async () => {
    const errors = [
      { message: 'Error: bare', snippet: '> 1 | x' },
      { message: 'outer', stack: 'Error: outer\n    at /repo/tests/shop.spec.ts:3:1', cause: { message: 'inner' } },
    ];
    await run(new PluneReporter(), [fakeTest()], [fakeResult({ status: 'failed', errors })]);
    expect(added[0]?.errorContext).toBe('Error: bare\n\nError: outer\n    at /repo/tests/shop.spec.ts:3:1\n[cause]: inner');
  });

  it('places the failure where the runner says it was thrown when the stack shows only libraries', async () => {
    const config = { shard: null, rootDir: '/repo/tests', metadata: {} } as unknown as FullConfig;
    const test = fakeTest({ location: { file: '/repo/tests/shop.spec.ts', line: 1, column: 1 } });
    const error = { message: 'Error: x', stack: 'Error: x\n    at /repo/node_modules/lib/a.js:1:1', location: { file: '/repo/tests/shop.spec.ts', line: 7, column: 3 } };
    const reporter = new PluneReporter();
    reporter.onConfigure(config);
    reporter.onBegin(suiteOf(test));
    reporter.onTestEnd(test, fakeResult({ status: 'failed', errors: [error] }));
    await reporter.onEnd({} as FullResult);
    expect(added[0]?.failure?.location).toEqual({ file: 'tests/shop.spec.ts', line: 7, column: 3 });
  });

  it('opens the run without a link when the CI run is no web address (AC-07b)', async () => {
    const config = { shard: null, metadata: { ci: { buildHref: 'javascript:alert(1)' } } } as unknown as FullConfig;
    const reporter = new PluneReporter();
    reporter.onConfigure(config);
    reporter.onBegin(suiteOf(fakeTest()));
    reporter.onTestEnd(fakeTest(), fakeResult());
    await reporter.onEnd({} as FullResult);
    expect(startConfigs[0]?.['meta']).toEqual({ runner: 'playwright' });
  });

  it('keeps a declared step inside a hook out of the chain, as the JSON report does', async () => {
    const inHook = [{ title: 'Before Hooks', category: 'hook', error: { message: 'x' }, steps: [{ title: 'beforeEach hook', category: 'hook', error: { message: 'x' }, steps: [{ title: 'Log in', category: 'test.step', error: { message: 'x' }, steps: [] }] }] }];
    await run(new PluneReporter(), [fakeTest()], [fakeResult({ status: 'failed', errors: [{ message: 'Error: boom' }], steps: inHook })]);
    expect(added[0]?.failure).toEqual({ headline: 'Error: boom' });
  });
});

/**
 * plune-ai/plune#927. The run opens with the commit and the branch it ran at, so the panel of a run can
 * say where it ran. The `ci` objects are what Playwright 1.63's `ciInfo()` builds under each CI's own
 * variables (`lib/runner/index.js`): a commit and no branch on GitHub, both on GitLab and on Jenkins —
 * where there is no `buildHref` either.
 */
describe('the commit and branch the run opens with (plune#927)', () => {
  const SHA = '0123456789abcdef0123456789abcdef01234567';
  const BUILD = 'https://github.com/acme/shop/actions/runs/42';
  const onGitHub = {
    commitHref: `https://github.com/acme/shop/commit/${SHA}`,
    commitHash: SHA,
    buildHref: BUILD,
  };

  /** One test reported with `ci` as `metadata.ci`, in a job whose environment is `vars`. */
  async function metaOf(ci: unknown, vars: Record<string, string> = {}): Promise<unknown> {
    for (const [name, value] of Object.entries(vars)) vi.stubEnv(name, value);
    const config = {
      shard: null,
      metadata: ci === undefined ? {} : { ci },
    } as unknown as FullConfig;
    const reporter = new PluneReporter();
    reporter.onConfigure(config);
    reporter.onBegin(suiteOf(fakeTest()));
    reporter.onTestEnd(fakeTest(), fakeResult());
    await reporter.onEnd({} as FullResult);
    return startConfigs[0]?.['meta'];
  }

  it('on a GitHub push: the commit Playwright wrote, and the ref name as the branch', async () => {
    const vars = {
      GITHUB_ACTIONS: 'true',
      GITHUB_SHA: SHA,
      GITHUB_HEAD_REF: '',
      GITHUB_REF_NAME: 'main',
    };

    expect(await metaOf(onGitHub, vars)).toEqual({
      runner: 'playwright',
      ciUrl: BUILD,
      sha: SHA,
      branch: 'main',
    });
  });

  it('on a GitHub pull request: the pull request’s own branch, not "12/merge"', async () => {
    const pullRequest = {
      ...onGitHub,
      prHref: 'https://github.com/acme/shop/pull/12',
      prTitle: 'A panel for a run',
      prBaseHash: 'fedcba9876543210fedcba9876543210fedcba98',
    };
    const vars = {
      GITHUB_ACTIONS: 'true',
      GITHUB_SHA: SHA,
      GITHUB_HEAD_REF: 'feat/panel',
      GITHUB_REF_NAME: '12/merge',
    };

    expect(await metaOf(pullRequest, vars)).toEqual({
      runner: 'playwright',
      ciUrl: BUILD,
      sha: SHA,
      branch: 'feat/panel',
    });
  });

  it('on GitLab: the commit and the branch Playwright wrote', async () => {
    const onGitLab = {
      commitHref: `https://gitlab.acme.test/acme/shop/-/commit/${SHA}`,
      commitHash: SHA,
      buildHref: 'https://gitlab.acme.test/acme/shop/-/jobs/7',
      branch: 'release/1.4',
    };

    expect(await metaOf(onGitLab)).toEqual({
      runner: 'playwright',
      ciUrl: 'https://gitlab.acme.test/acme/shop/-/jobs/7',
      sha: SHA,
      branch: 'release/1.4',
    });
  });

  it('on Jenkins: the commit and the branch, and no link — Playwright gives Jenkins none', async () => {
    const onJenkins = {
      commitHref: 'https://ci.acme.test/job/shop/9/',
      commitHash: SHA,
      branch: 'origin/main',
    };

    expect(await metaOf(onJenkins)).toEqual({
      runner: 'playwright',
      sha: SHA,
      branch: 'origin/main',
    });
  });

  it('outside a CI: the runner and nothing else — no commit is guessed', async () => {
    expect(await metaOf(undefined)).toEqual({ runner: 'playwright' });
  });
});
