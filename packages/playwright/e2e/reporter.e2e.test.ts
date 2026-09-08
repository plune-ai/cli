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

interface Received {
  path: string;
  body: Record<string, unknown>;
}

let server: Server;
let baseUrl = '';
let fallback = '';
const received: Received[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
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
        const list = (body['results'] ?? []) as unknown[];
        return json({ items: [], counts: { accepted: list.length, duplicate: 0, conflict: 0, rejected: 0 } });
      }
      if (url.endsWith('/events')) return json({ run: { id: 'r-e2e' }, changed: true });
      return json({ error: `unexpected ${url}` }, 500);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`;
  fallback = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'plune-e2e-')), 'pending.jsonl');

  await new Promise<void>((resolve, reject) => {
    const child = spawn('npx', ['playwright', 'test'], {
      cwd: fixture,
      shell: process.platform === 'win32',
      env: { ...process.env, PLUNE_STUB_URL: baseUrl, PLUNE_FALLBACK: fallback, CI: '1' },
    });
    let stderr = '';
    child.stderr.on('data', (c) => (stderr += String(c)));
    // One test fails on purpose, so a non-zero exit is the expected outcome — what must not happen
    // is the runner failing to start at all.
    child.on('close', (code) => (code === null ? reject(new Error(stderr)) : resolve()));
    child.on('error', reject);
  });
}, 120_000);

afterAll(() => {
  server.close();
});

const bodiesFor = (suffix: string): Record<string, unknown>[] =>
  received.filter((r) => r.path.endsWith(suffix)).map((r) => r.body);

describe('a foreign Playwright project reports to Plune (AC-01)', () => {
  it('starts exactly one run, in the schema the lifecycle speaks', () => {
    const starts = received.filter((r) => r.path === '/v1/runs');

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
    expect(fs.existsSync(fallback)).toBe(false);
  });
});
