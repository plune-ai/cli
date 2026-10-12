// END-TO-END for `--fail-on-failures` (plune-ai/plune#1247), against the REAL built binary (dist/cli.cjs) and a
// platform on a real socket. Run with `pnpm test:e2e` (builds first). What it pins is the wiring: each of the four
// commands takes the flag, and the process exits with the gate's code — and exits as before without it.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const cli = path.join(root, 'dist', 'cli.cjs');

const MUTED_ONLY = { counts: { passed: 1, muted: 1 }, notRun: [], total: 2 };
const ONE_FAILED = { counts: { passed: 1, failed: 1 }, notRun: [], total: 2 };

/** What `finish` freezes and the summary reads: set by each test. */
let verdict: typeof MUTED_ONLY = MUTED_ONLY;
let server: Server;
let url = '';
let tmp = '';

beforeAll(async () => {
  if (!fs.existsSync(cli)) throw new Error('dist/cli.cjs not found — run `pnpm test:e2e` (it builds first).');
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plune-e2e-gate-'));
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      const body = (raw === '' ? {} : JSON.parse(raw)) as Record<string, unknown>;
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      const at = req.url ?? '';
      if (at === '/v1/runs') {
        return body['schemaVersion'] === 2 ? send(201, { run: { id: 'r-1' }, joined: false }) : send(201, { id: 'r-1' });
      }
      if (at === '/v1/test-cases/resolve') {
        return send(200, { results: (body['keys'] as unknown[]).map((key) => ({ key, testCaseId: 'tc-1' })) });
      }
      if (at.endsWith('/results')) {
        const results = body['results'] as { resultKey: string }[];
        return send(200, {
          items: results.map((r, index) => ({ index, resultKey: r.resultKey, status: 'accepted', id: `res-${index}` })),
          counts: { accepted: results.length, duplicate: 0, conflict: 0, rejected: 0 },
        });
      }
      if (at.endsWith('/events')) return send(200, { run: { id: 'r-1', statusEvent: 'finished' }, summary: verdict, detached: 0 });
      if (at.endsWith('/summary')) {
        return send(200, { counts: verdict.counts, notRun: verdict.notRun, run: { statusEvent: 'finished' } });
      }
      send(404, { error: `unexpected ${req.method ?? ''} ${at}` });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
});

function plune(args: string[]): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve, reject) => {
    const env: Record<string, string | undefined> = {
      ...process.env,
      PLUNE_API_URL: url,
      PLUNE_TOKEN: 'tok-e2e',
      PLUNE_FALLBACK: path.join(tmp, 'pending.jsonl'),
      GITHUB_ACTIONS: '',
      GITLAB_CI: '',
      JENKINS_URL: '',
    };
    for (const name of ['PLUNE_RUN', 'PLUNE_PROCEED', 'PLUNE_SHARED_RUN']) delete env[name];
    const child = spawn(process.execPath, [cli, ...args], { cwd: tmp, env });
    let out = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString()));
    child.stderr.on('data', (c: Buffer) => (out += c.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out }));
  });
}

const file = (name: string, text: string): string => {
  const at = path.join(tmp, name);
  fs.writeFileSync(at, text);
  return at;
};

describe('--fail-on-failures on the built binary', () => {
  const report = () =>
    file(
      'results.xml',
      '<testsuites><testsuite name="s" file="s.spec.ts"><testcase classname="s" name="a"/>' +
        '<testcase classname="s" name="b"><failure message="no"/></testcase></testsuite></testsuites>',
    );
  const runJson = () =>
    file(
      'run.json',
      JSON.stringify({
        schemaVersion: 1,
        plune_version: '0.0.0',
        started_at: '2026-10-12T10:00:00.000Z',
        finished_at: '2026-10-12T10:00:01.000Z',
        config_hash: 'cfg',
        summary: { total: 0, passed: 0, failed: 0, errored: 0, cost_usd: 0, duration_ms: 1 },
        evals: [],
      }),
    );
  // The runner exits 1, as one does on a muted case it knows nothing about.
  const failingRunner = () => ['node', file('runner.cjs', 'process.exit(1)')];

  const FLAG = ['--fail-on-failures'];
  const commands: [string, (flag: string[]) => string[], number][] = [
    ['run finish', (flag) => ['run', 'finish', 'r-1', ...flag], 0],
    ['run exec', (flag) => ['run', 'exec', ...flag, '--', ...failingRunner()], 1],
    ['run import', (flag) => ['run', 'import', report(), ...flag], 0],
    ['sync', (flag) => ['sync', '--file', runJson(), ...flag], 0],
  ];

  it.each(commands)('%s exits 1 on a counted failure', async (_name, args) => {
    verdict = ONE_FAILED;
    const r = await plune(args(FLAG));
    expect(r.out).toContain('gate failed');
    expect(r.code).toBe(1);
  });

  it.each(commands)('%s exits 0 when the only failure is muted', async (_name, args) => {
    verdict = MUTED_ONLY;
    const r = await plune(args(FLAG));
    expect(r.out).toContain('gate passed');
    expect(r.code).toBe(0);
  });

  it.each(commands)('%s without the flag exits as it always did, %i', async (_name, args, before) => {
    verdict = ONE_FAILED;
    const r = await plune(args([]));
    expect(r.out).not.toContain('gate');
    expect(r.code).toBe(before);
  });
});
