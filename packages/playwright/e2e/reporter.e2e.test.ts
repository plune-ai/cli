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

/**
 * Run the fixture project once against a stub; `refuseResults` answers every results batch 413, and
 * `args` go to the runner as they are.
 */
async function runFixture(refuseResults: boolean, args: string[] = []): Promise<FixtureRun> {
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
  const baseUrl = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`;
  const fallback = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'plune-e2e-')), 'pending.jsonl');

  try {
    return await new Promise<FixtureRun>((resolve, reject) => {
      const child = spawn('npx', ['playwright', 'test', ...args], {
        cwd: fixture,
        shell: process.platform === 'win32',
        env: { ...process.env, PLUNE_STUB_URL: baseUrl, PLUNE_FALLBACK: fallback, CI: '1' },
      });
      let stderr = '';
      child.stderr.on('data', (c) => (stderr += String(c)));
      // One test fails on purpose, so a non-zero exit is the expected outcome — what must not happen
      // is the runner failing to start at all.
      child.on('close', (code) => (code === null ? reject(new Error(stderr)) : resolve({ code, stderr, received, fallback })));
      child.on('error', reject);
    });
  } finally {
    server.close();
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
  // Not on Windows until cli#58: there the process can abort at exit whatever the platform answered —
  // V8's background compile of the fetch parser against Playwright's `process.exit` — and a green run
  // ends 0xC0000409. On Linux this is the check.
  it.skipIf(process.platform === 'win32')('leaves a green run green', () => {
    expect(refused.code).toBe(0);
  });

  it('says the result was not delivered, and keeps it for "plune run report"', () => {
    expect(refused.stderr).toContain(`plune: 0 accepted · 1 not delivered — written to ${refused.fallback}`);
    expect(fs.readFileSync(refused.fallback, 'utf8').trim().split('\n')).toHaveLength(1);
  });
});
