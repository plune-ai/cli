import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The one thing a unit test cannot prove: that Playwright actually calls this class, in the
 * calling convention `version()` claims.
 *
 * Every mapping in the adapter is covered by fast unit tests against fake `TestCase` objects. What
 * those cannot see is the reporter API itself — if `version()` stopped being honoured, Playwright
 * would fall back to `onBegin(config, suite)` and every one of those unit tests would still pass
 * while the reporter silently reported nothing.
 *
 * So this runs the real runner, over a real (browser-free) project, against a stub that speaks the
 * platform's shapes, and checks what arrived.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, 'fixture');
/** The root package's built CLI — the other road into a run, `plune run import`. */
const cli = path.resolve(here, '../../../dist/cli.cjs');

interface Received {
  path: string;
  body: Record<string, unknown>;
  /** An upload's type and bytes — its body is the file, not JSON. */
  file?: { type: string; bytes: Buffer };
}

interface FixtureRun {
  /** The runner's own exit code — the one thing the reporter must never change. */
  code: number;
  stderr: string;
  received: Received[];
  fallback: string;
  /** How many results the stub had answered when the run was closed; `null` if it never was. */
  answeredAtClose: number | null;
}

interface Stub {
  url: string;
  received: Received[];
  answeredAtClose: () => number | null;
  close: () => void;
}

/**
 * A stub that speaks the platform's shapes and keeps what it got; `refuseResults` answers every results
 * batch 413, `answerAfterMs` answers each batch that much later, and `refuseStart` answers every request
 * to open a run 503. A result counts as stored when it is answered, and a batch or a file arriving after
 * the run closed is refused 409 — as the platform does.
 */
async function stub(refuseResults: boolean, answerAfterMs = 0, refuseStart = false): Promise<Stub> {
  const received: Received[] = [];
  let answered = 0;
  let answeredAtClose: number | null = null;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = req.url ?? '';
      const raw = Buffer.concat(chunks);

      const json = (payload: unknown, status = 200): void => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };

      // Before the JSON below: a file's body is its bytes (platform ADR 0040).
      if (url.includes('/files?name=')) {
        received.push({ path: url, body: {}, file: { type: req.headers['content-type'] ?? '', bytes: raw } });
        if (answeredAtClose !== null) return json({ error: 'the run is closed — its results stand' }, 409);
        return json({ id: `file-${received.length}`, size: raw.length }, 201);
      }
      const body = raw.length === 0 ? {} : (JSON.parse(raw.toString('utf8')) as Record<string, unknown>);
      received.push({ path: url, body });

      if (url === '/v1/runs') {
        if (refuseStart) return json({ error: 'the platform is down' }, 503);
        return json({ run: { id: 'r-e2e' }, joined: false }, 201);
      }
      if (url === '/v1/test-cases/resolve') {
        const keys = (body['keys'] ?? []) as { value: string }[];
        // Every key resolves, so nothing is dropped for a reason unrelated to what is being tested.
        return json({ results: keys.map((k) => ({ key: k, testCaseId: `tc-${k.value.slice(0, 6)}`, matchedKind: null })) });
      }
      if (url.endsWith('/results')) {
        if (refuseResults) return json({ error: 'request body too large' }, 413);
        if (answeredAtClose !== null) return json({ error: 'this run is finished' }, 409);
        const list = (body['results'] ?? []) as { resultKey: string }[];
        const answer = (): void => {
          // The platform's answer (plune `src/server/results/v1-store.ts`): a verdict per result, and
          // the id of each one it stored — what a file is uploaded to.
          const items = list.map((r, index) => ({ index, resultKey: r.resultKey, status: 'accepted', id: `res-${answered + index}` }));
          answered += list.length;
          json({ items, counts: { accepted: list.length, duplicate: 0, conflict: 0, rejected: 0 } });
        };
        if (answerAfterMs > 0) setTimeout(answer, answerAfterMs);
        else answer();
        return;
      }
      if (url.endsWith('/events')) {
        answeredAtClose ??= answered;
        return json({ run: { id: 'r-e2e' }, changed: true });
      }
      return json({ error: `unexpected ${url}` }, 500);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const url = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`;
  return { url, received, answeredAtClose: () => answeredAtClose, close: () => server.close() };
}

/**
 * Run the fixture project once against a stub; `refuseResults` answers every results batch 413, `args`
 * go to the runner as they are, `env` over the environment it inherits, `answerAfterMs` delays every
 * results answer, and `refuseStart` has the platform refuse to open a run at all.
 */
async function runFixture(
  refuseResults: boolean,
  args: string[] = [],
  env: Record<string, string> = {},
  answerAfterMs = 0,
  refuseStart = false,
): Promise<FixtureRun> {
  const platform = await stub(refuseResults, answerAfterMs, refuseStart);
  const fallback = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'plune-e2e-')), 'pending.jsonl');

  try {
    return await new Promise<FixtureRun>((resolve, reject) => {
      const child = spawn('npx', ['playwright', 'test', ...args], {
        cwd: fixture,
        shell: process.platform === 'win32',
        env: { ...process.env, PLUNE_STUB_URL: platform.url, PLUNE_FALLBACK: fallback, CI: '1', ...env },
      });
      let stderr = '';
      child.stderr.on('data', (c) => (stderr += String(c)));
      // One test fails on purpose, so a non-zero exit is the expected outcome — what must not happen
      // is the runner failing to start at all.
      child.on('close', (code) =>
        code === null
          ? reject(new Error(stderr))
          : resolve({ code, stderr, received: platform.received, fallback, answeredAtClose: platform.answeredAtClose() }),
      );
      child.on('error', reject);
    });
  } finally {
    platform.close();
  }
}

/** `plune run import` of a report by the built CLI against a stub, in a job whose environment is `env`. */
async function importReport(
  file: string,
  env: Record<string, string>,
  format: 'playwright-json' | 'junit' = 'playwright-json',
): Promise<Received[]> {
  const platform = await stub(false);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'plune-import-'));
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [cli, 'run', 'import', file, '--format', format], {
        cwd,
        env: { ...process.env, ...env, PLUNE_API_URL: platform.url, PLUNE_TOKEN: 'stub-token' },
      });
      let stderr = '';
      child.stderr.on('data', (c) => (stderr += String(c)));
      child.on('close', (code) => (code === null ? reject(new Error(stderr)) : resolve()));
      child.on('error', reject);
    });
    return platform.received;
  } finally {
    platform.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

/** `plune run report` of a fallback file by the built CLI against a stub that works, in a job whose environment is `env`. */
async function replayFallback(
  file: string,
  env: Record<string, string>,
): Promise<{ received: Received[]; stdout: string }> {
  const platform = await stub(false);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'plune-replay-'));
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, [cli, 'run', 'report', '--file', file], {
        cwd,
        env: { ...process.env, ...env, PLUNE_API_URL: platform.url, PLUNE_TOKEN: 'stub-token' },
      });
      let out = '';
      let stderr = '';
      child.stdout.on('data', (c) => (out += String(c)));
      child.stderr.on('data', (c) => (stderr += String(c)));
      child.on('close', (code) =>
        code === 0 ? resolve(out) : reject(new Error(`exit ${String(code)}: ${stderr}${out}`)),
      );
      child.on('error', reject);
    });
    return { received: platform.received, stdout };
  } finally {
    platform.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

let delivered: FixtureRun;
let refused: FixtureRun;

beforeAll(async () => {
  delivered = await runFixture(false);
  // Only the passing test: with the failing one in, the runner exits 1 anyway, and a reporter that
  // broke the run would exit 1 too. Green alone, anything but 0 is the reporter's doing.
  refused = await runFixture(true, ['-g', 'accepts a positive quantity']);
}, 240_000);

const bodiesFor = (suffix: string): Record<string, unknown>[] =>
  delivered.received.filter((r) => r.path.endsWith(suffix)).map((r) => r.body);

describe('a foreign Playwright project reports to Plune (AC-01)', () => {
  it('starts exactly one run, in the schema the lifecycle speaks', () => {
    const starts = delivered.received.filter((r) => r.path === '/v1/runs');

    expect(starts).toHaveLength(1);
    expect(starts[0]?.body['schemaVersion']).toBe(2);
    expect(starts[0]?.body['externalKey']).toBe('e2e-fixture');
  });

  it('tells the platform what it intended to run, so a crash is visible (AC-09)', () => {
    const configuration = bodiesFor('/v1/runs')[0]?.['configuration'] as
      | { expected: unknown[] }
      | undefined;

    expect(configuration?.expected).toHaveLength(3);
  });

  it('looks every test up in one request, not one per test (AC-10)', () => {
    expect(bodiesFor('/v1/test-cases/resolve')).toHaveLength(1);
  });

  it('reports each test with the word the runner used', () => {
    const results = bodiesFor('/results').flatMap(
      (b) => (b['results'] ?? []) as { rawStatus: string; source: string }[],
    );

    expect(results).toHaveLength(3);
    expect(results.map((r) => r.rawStatus).sort()).toEqual(['failed', 'passed', 'skipped']);
    expect(new Set(results.map((r) => r.source))).toEqual(new Set(['playwright']));
  });

  it('sends what a failure actually said', () => {
    const results = bodiesFor('/results').flatMap(
      (b) => (b['results'] ?? []) as { rawStatus: string; errorContext?: string }[],
    );
    const failed = results.find((r) => r.rawStatus === 'failed');

    expect(failed?.errorContext).toContain('cart.spec.ts');
  });

  it('closes the run, because nothing here is a shard', () => {
    const events = bodiesFor('/events');

    expect(events).toHaveLength(1);
    expect(events[0]?.['event']).toBe('finish');
  });

  it('needed no fallback, because nothing failed to send', () => {
    expect(fs.existsSync(delivered.fallback)).toBe(false);
  });

  it('says what failed and on which line of the test, from the repository root (#790)', () => {
    const results = bodiesFor('/results').flatMap(
      (b) => (b['results'] ?? []) as { rawStatus: string; failure?: { headline?: string; location?: unknown } }[],
    );
    const failed = results.find((r) => r.rawStatus === 'failed');

    expect(failed?.failure?.headline).toMatch(/^Error: expect\(received\)\.toBeGreaterThan\(expected\)/);
    expect(failed?.failure?.location).toMatchObject({ file: 'packages/playwright/e2e/fixture/tests/cart.spec.ts', line: 12 });
    expect(results.filter((r) => r.failure !== undefined)).toHaveLength(1);
  });
});

describe('a refused batch changes nothing about the test run (#790, #788)', () => {
  // On Windows too (cli#58): through `fetch`, V8's background compile of undici's WASM parser against
  // Playwright's `process.exit` could abort a green run with 0xC0000409, whatever the platform answered.
  it('leaves a green run green', () => {
    expect(refused.code).toBe(0);
  });

  it('says the result was not delivered, and keeps it for "plune run report"', () => {
    expect(refused.stderr).toContain(`plune: 0 accepted · 1 not delivered — written to ${refused.fallback}`);
    expect(fs.readFileSync(refused.fallback, 'utf8').trim().split('\n')).toHaveLength(1);
  });
});

/**
 * #790 review F4, on the real runner and the real core: a hundred results in batches of two against a
 * platform that answers each batch 100 ms later. The run closes only after the last batch is answered,
 * or `notRun` freezes without them and the batches behind the close are refused.
 */
describe('a slow platform has every result before the run closes (#790 AC-15)', () => {
  let slow: FixtureRun;

  beforeAll(async () => {
    slow = await runFixture(false, [], { PLUNE_TEST_DIR: './many', PLUNE_BATCH_SIZE: '2' }, 100);
  }, 240_000);

  it('answered all 100 before the finish arrived, and the summary counts all of them', () => {
    expect(slow.answeredAtClose).toBe(100);
    expect(slow.stderr).toContain('plune: 100 accepted');
    expect(fs.existsSync(slow.fallback)).toBe(false);
    expect(slow.code).toBe(0);
  });
});

/**
 * plune-ai/plune#913 on the published bundle: a screenshot a test attached by path reaches its result.
 * Playwright hands the reporter the copy it saved as `<name>-<sha1>.png`; what has to leave is one upload
 * under the attachment's own name, as the PNG's bytes, to the id the batch was answered with — before
 * the run is closed, since the platform takes no file on a closed run.
 */
describe('a screenshot a test kept reaches its result (plune#913)', () => {
  // The PNG `fixture/shots/checkout.spec.ts` writes and attaches.
  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  );
  let shots: FixtureRun;

  beforeAll(async () => {
    shots = await runFixture(false, [], { PLUNE_TEST_DIR: './shots' });
  }, 240_000);

  it('uploads it once, under the attachment’s name, as the PNG it is, before the run is closed', () => {
    const uploads = shots.received.filter((r) => r.file !== undefined);
    expect(uploads.map((r) => r.path)).toEqual(['/v1/results/res-0/files?name=checkout.png']);
    expect(uploads[0]?.file?.type).toBe('image/png');
    expect(uploads[0]?.file?.bytes).toEqual(PNG);

    const order = shots.received.map((r) => r.path);
    expect(order.indexOf('/v1/results/res-0/files?name=checkout.png')).toBeLessThan(order.indexOf('/v1/runs/r-e2e/events'));
    expect(shots.stderr).toContain('plune: 1 accepted · 1 screenshot(s) uploaded');
    expect(shots.code).toBe(0);
  });
});

/**
 * #790 T18, the CI link's contract on the pinned runner. Under GitHub's variables Playwright writes
 * `metadata.ci` itself (`ciInfo()` in playwright 1.63 `lib/runner/index.js`), and both roads link the
 * run and its failure to that CI run: the reporter live, and `plune run import` of the JSON report of
 * the same run, from a later job whose own variables name another run (AC-04b).
 */
describe('both roads link the run and its failure to the CI run that ran the tests (#790)', () => {
  const LINK = 'https://github.com/acme/shop/actions/runs/42';
  const SHA = '0123456789abcdef0123456789abcdef01234567';
  const CI_RUN = {
    GITHUB_ACTIONS: 'true',
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_REPOSITORY: 'acme/shop',
    GITHUB_RUN_ID: '42',
    GITHUB_SHA: SHA,
    // A push to main. Named here, not left to the environment this test runs in: on GitHub Actions
    // that one has a branch of its own, and the run opens with whichever it is (plune#927).
    GITHUB_HEAD_REF: '',
    GITHUB_REF_NAME: 'main',
    // No pull request: with one, Playwright fetches its base commit to diff against.
    GITHUB_EVENT_PATH: '',
  };
  let live: Received[] = [];
  let imported: Received[] = [];

  beforeAll(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plune-ci-'));
    const report = path.join(dir, 'report.json');
    try {
      live = (await runFixture(false, [], { ...CI_RUN, PLUNE_JSON_REPORT: report })).received;
      // Another job, of another commit on another branch: what the report names is what ran.
      imported = await importReport(report, {
        ...CI_RUN,
        GITHUB_REPOSITORY: 'acme/replay',
        GITHUB_RUN_ID: '7',
        GITHUB_SHA: 'fedcba9876543210fedcba9876543210fedcba98',
        GITHUB_REF_NAME: 'some-other-branch',
      });
    } finally {
      // The report holds the commit's author as git knows them — nothing to leave behind.
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 240_000);

  interface Sent {
    rawStatus: string;
    failure?: { ciUrl?: string; location?: unknown };
    errorContext?: string;
  }
  const openedWith = (received: Received[]): unknown => received.find((r) => r.path === '/v1/runs')?.body['meta'];
  const failedIn = (received: Received[]): Sent | undefined =>
    received
      .filter((r) => r.path.endsWith('/results'))
      .flatMap((r) => (r.body['results'] ?? []) as Sent[])
      .find((r) => r.rawStatus === 'failed');

  it('the reporter opens the run with the CI run, and links the failure to it (AC-04)', () => {
    // With the commit the real Playwright wrote into `metadata.ci`, and the branch it never gives on
    // GitHub — read from the job (plune#927).
    expect(openedWith(live)).toEqual({
      runner: 'playwright',
      ciUrl: LINK,
      sha: SHA,
      branch: 'main',
    });
    expect(failedIn(live)?.failure?.ciUrl).toBe(LINK);
  });

  it('an import in another job links to the CI run that wrote the report, not to its own (AC-04b)', () => {
    // And names the commit the report names — with no branch, since the job it runs in is of another.
    expect(openedWith(imported)).toEqual({ runner: 'playwright-json', ciUrl: LINK, sha: SHA });
    expect(failedIn(imported)?.failure?.ciUrl).toBe(LINK);
  });

  it('both roads send the same failure and the same text, its failing line marked in the code frame (AC-06)', () => {
    const [reporter, importer] = [failedIn(live), failedIn(imported)];
    expect(reporter?.failure?.location).toMatchObject({ file: 'packages/playwright/e2e/fixture/tests/cart.spec.ts', line: 12 });
    expect(importer?.failure).toEqual(reporter?.failure);
    expect(importer?.errorContext).toBe(reporter?.errorContext);
    expect(reporter?.errorContext).toContain('> 12 |     expect(-1).toBeGreaterThan(0);');
  });
});

/**
 * plune-ai/cli#47 and #38, on the real runner: one run written as Playwright's own JUnit report as well,
 * and `plune run import` of that report. The file suite's title comes in the OS's separators — a
 * backslash here on Windows — and the reporter's key is spelled with forward slashes on every OS, so
 * the two roads meet only if the import spells it the same way. Where the import reads a `@P<id>` from
 * a title, it has to be the reporter's case too.
 */
describe('the JUnit road names each test the way the reporter does (cli#47, cli#38)', () => {
  let live: Received[] = [];
  let imported: Received[] = [];

  beforeAll(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plune-junit-'));
    const report = path.join(dir, 'junit.xml');
    try {
      live = (await runFixture(false, [], { PLUNE_TEST_DIR: './nested', PLUNE_JUNIT_REPORT: report })).received;
      imported = await importReport(report, {}, 'junit');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 240_000);

  /** Every `path-title` a road asked the platform to resolve, sorted. */
  const pathTitles = (received: Received[]): string[] =>
    received
      .filter((r) => r.path === '/v1/test-cases/resolve')
      .flatMap((r) => (r.body['keys'] ?? []) as { kind?: string; value: string }[])
      .filter((k) => k.kind === 'path-title')
      .map((k) => k.value)
      .sort();

  /** The titles of the results a road sent to case 42. */
  const titlesSentTo42 = (received: Received[]): string[] =>
    received
      .filter((r) => r.path.endsWith('/results'))
      .flatMap((r) => (r.body['results'] ?? []) as { title: string; testCaseId?: string }[])
      .filter((r) => r.testCaseId === '42')
      .map((r) => r.title);

  it('asks for the same path-title of every test as the reporter did in the run that wrote the report', () => {
    expect(pathTitles(imported)).toEqual(pathTitles(live));
    // Spelled out, so two roads that both said nothing, or the same wrong thing, would not pass.
    expect(pathTitles(live)).toEqual([
      'checkout/cart.spec.ts#cart#adds an item',
      'checkout/cart.spec.ts#cart#coupons#applies a coupon',
      'checkout/cart.spec.ts#cart#coupons#keeps its case when renamed @P42',
      'checkout/cart.spec.ts#starts with an empty cart',
      'login.spec.ts#shows the sign-in form',
    ]);
  });

  it('sends the @P<id> of a title as the case on both roads, and no other test as one', () => {
    expect(titlesSentTo42(live)).toEqual(['cart › coupons › keeps its case when renamed @P42']);
    // The import's title leads with the file, as the OS spelled it — only where it ends is the same.
    const [title, ...more] = titlesSentTo42(imported);
    expect(title).toMatch(/cart › coupons › keeps its case when renamed @P42$/);
    expect(more).toEqual([]);
  });
});

/**
 * cli#45 and plune#927 on the real chain: the real runner, with the platform unwilling to open a run, writes
 * the fallback file; the built `plune run report` replays it. A hundred results at a batch of thirty are four
 * lines. They are one run — opened once, with the commit and branch the reporter's own job named rather than
 * those of the job replaying them — and once every result has gone the file is set aside, not left to be sent
 * a second time.
 */
describe('the lines of one reporter run replay as one run (cli#45, plune#927)', () => {
  const SHA = '89abcdef0123456789abcdef0123456789abcdef';
  /** A pull request's job: its branch is the head's, and `GITHUB_REF_NAME` names the merge ref. */
  const REPORTING_JOB = {
    GITHUB_ACTIONS: 'true',
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_REPOSITORY: 'acme/shop',
    GITHUB_RUN_ID: '43',
    GITHUB_SHA: SHA,
    GITHUB_HEAD_REF: 'feature/checkout',
    GITHUB_REF_NAME: '12/merge',
    // No event file: with a pull request in it, Playwright fetches its base commit to diff against.
    GITHUB_EVENT_PATH: '',
  };
  /** What the reporter's job says the run is — and so what the replay has to open its run with. */
  const META = {
    runner: 'playwright',
    ciUrl: 'https://github.com/acme/shop/actions/runs/43',
    sha: SHA,
    branch: 'feature/checkout',
  };
  let fallback = '';
  let live: FixtureRun | undefined;
  let lines: Record<string, unknown>[] = [];
  let replay: { received: Received[]; stdout: string } | undefined;

  beforeAll(async () => {
    live = await runFixture(
      false,
      [],
      { ...REPORTING_JOB, PLUNE_TEST_DIR: './many', PLUNE_BATCH_SIZE: '30' },
      0,
      true,
    );
    fallback = live.fallback;
    lines = fs
      .readFileSync(fallback, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    // Some other job, of another commit on another branch: what the lines name is what ran.
    replay = await replayFallback(fallback, {
      ...REPORTING_JOB,
      GITHUB_RUN_ID: '9',
      GITHUB_SHA: 'fedcba9876543210fedcba9876543210fedcba98',
      GITHUB_HEAD_REF: 'unrelated',
      GITHUB_REF_NAME: 'main',
    });
  }, 240_000);

  afterAll(() => {
    if (fallback !== '') fs.rmSync(path.dirname(fallback), { recursive: true, force: true });
  });

  const opened = (): Received[] => (replay?.received ?? []).filter((r) => r.path === '/v1/runs');

  it('are written one line per batch, every one marked with the same session and naming where the run came from', () => {
    expect(live?.received.filter((r) => r.path.endsWith('/results'))).toEqual([]);
    expect(lines.map((line) => (line['results'] as unknown[]).length)).toEqual([30, 30, 30, 10]);
    expect(lines.map((line) => line['runId'])).toEqual([null, null, null, null]);
    expect(typeof lines[0]?.['session']).toBe('string');
    expect(new Set(lines.map((line) => line['session'])).size).toBe(1);
    for (const line of lines) expect(line['meta']).toEqual(META);
  });

  it('are one run when replayed, opened with what the reporter recorded and nothing of the job replaying them', () => {
    expect(opened()).toHaveLength(1);
    expect(opened()[0]?.body['externalKey']).toBe('e2e-fixture');
    expect(opened()[0]?.body['meta']).toEqual(META);

    const sent = (replay?.received ?? [])
      .filter((r) => r.path.endsWith('/results'))
      .flatMap((r) => (r.body['results'] ?? []) as unknown[]);
    expect(sent).toHaveLength(100);
    // Left open: a replay cannot know that the run it makes is the whole of it.
    expect((replay?.received ?? []).filter((r) => r.path.endsWith('/events'))).toEqual([]);
    expect(replay?.stdout).toContain('Replayed 4 batch(es)');
    expect(replay?.stdout).toContain('100 sent, 0 not');
  });

  it('leave the file set aside once every result has gone, where it can still be read', () => {
    expect(fs.existsSync(fallback)).toBe(false);

    const dir = path.dirname(fallback);
    const aside = fs
      .readdirSync(dir)
      .filter((name) =>
        /^pending\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.sent\.jsonl$/.test(name),
      );
    expect(aside).toHaveLength(1);
    expect(
      fs
        .readFileSync(path.join(dir, aside[0] ?? ''), 'utf8')
        .trim()
        .split('\n'),
    ).toHaveLength(4);
    expect(replay?.stdout).toContain('Every result was sent');
  });
});
