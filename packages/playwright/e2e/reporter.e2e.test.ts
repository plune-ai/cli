import { describe, it, expect, beforeAll } from 'vitest';
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
}

interface FixtureRun {
  /** The runner's own exit code — the one thing the reporter must never change. */
  code: number;
  stderr: string;
  received: Received[];
  fallback: string;
}

interface Stub {
  url: string;
  received: Received[];
  close: () => void;
}

/** A stub that speaks the platform's shapes and keeps what it got; `refuseResults` answers every results batch 413. */
async function stub(refuseResults: boolean): Promise<Stub> {
  const received: Received[] = [];
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += String(c)));
    req.on('end', () => {
      const url = req.url ?? '';
      const body = raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>);
      received.push({ path: url, body });

      const json = (payload: unknown, status = 200): void => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };

      if (url === '/v1/runs') return json({ run: { id: 'r-e2e' }, joined: false }, 201);
      if (url === '/v1/test-cases/resolve') {
        const keys = (body['keys'] ?? []) as { value: string }[];
        // Every key resolves, so nothing is dropped for a reason unrelated to what is being tested.
        return json({ results: keys.map((k) => ({ key: k, testCaseId: `tc-${k.value.slice(0, 6)}`, matchedKind: null })) });
      }
      if (url.endsWith('/results')) {
        if (refuseResults) return json({ error: 'request body too large' }, 413);
        const list = (body['results'] ?? []) as unknown[];
        return json({ items: [], counts: { accepted: list.length, duplicate: 0, conflict: 0, rejected: 0 } });
      }
      if (url.endsWith('/events')) return json({ run: { id: 'r-e2e' }, changed: true });
      return json({ error: `unexpected ${url}` }, 500);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const url = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`;
  return { url, received, close: () => server.close() };
}

/**
 * Run the fixture project once against a stub; `refuseResults` answers every results batch 413, `args`
 * go to the runner as they are, and `env` over the environment it inherits.
 */
async function runFixture(refuseResults: boolean, args: string[] = [], env: Record<string, string> = {}): Promise<FixtureRun> {
  const platform = await stub(refuseResults);
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
        code === null ? reject(new Error(stderr)) : resolve({ code, stderr, received: platform.received, fallback }),
      );
      child.on('error', reject);
    });
  } finally {
    platform.close();
  }
}

/** `plune run import` of a report by the built CLI against a stub, in a job whose environment is `env`. */
async function importReport(file: string, env: Record<string, string>): Promise<Received[]> {
  const platform = await stub(false);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'plune-import-'));
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [cli, 'run', 'import', file, '--format', 'playwright-json'], {
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
 * #790 T18, the CI link's contract on the pinned runner. Under GitHub's variables Playwright writes
 * `metadata.ci` itself (`ciInfo()` in playwright 1.63 `lib/runner/index.js`), and both roads link the
 * run and its failure to that CI run: the reporter live, and `plune run import` of the JSON report of
 * the same run, from a later job whose own variables name another run (AC-04b).
 */
describe('both roads link the run and its failure to the CI run that ran the tests (#790)', () => {
  const LINK = 'https://github.com/acme/shop/actions/runs/42';
  const CI_RUN = {
    GITHUB_ACTIONS: 'true',
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_REPOSITORY: 'acme/shop',
    GITHUB_RUN_ID: '42',
    GITHUB_SHA: '0123456789abcdef0123456789abcdef01234567',
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
      imported = await importReport(report, { ...CI_RUN, GITHUB_REPOSITORY: 'acme/replay', GITHUB_RUN_ID: '7' });
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
    expect(openedWith(live)).toEqual({ runner: 'playwright', ciUrl: LINK });
    expect(failedIn(live)?.failure?.ciUrl).toBe(LINK);
  });

  it('an import in another job links to the CI run that wrote the report, not to its own (AC-04b)', () => {
    expect(openedWith(imported)).toEqual({ runner: 'playwright-json', ciUrl: LINK });
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
