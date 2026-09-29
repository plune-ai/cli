import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { createProgram } from '../../cli.js';

/**
 * plune-ai/cli#71, through the command line.
 *
 * A test of `handleRunImport` starts after the parser has done its work, and the last time that
 * mattered a flag was lost there for two releases while every handler test stayed green
 * (`program.test.ts`). So this one types the command — `plune run import <file> --create` — into the
 * program the binary runs, and answers it from a platform on a real socket, over the transport the
 * binary uses. What it reads is what a person reads: the lines the command prints.
 */

const QUEUE_FULL =
  'review queue quota reached — at most 1000 items waiting. Approve or reject what is already in the queue to make room.';
const CASE_LIMIT =
  'test case quota reached — at most 5000 cases per project. Delete cases you no longer need, or ask an operator to raise the limit.';

const REPORT = `<testsuites>
  <testsuite name="cart" timestamp="2026-09-09T10:00:00.000Z" file="tests/cart.spec.ts">
    <testcase classname="cart" name="adds an item" time="0.1"/>
    <testcase classname="cart" name="removes an item" time="0.1"/>
  </testsuite>
</testsuites>`;

let dir = '';
let server: Server;
let printed: string[] = [];

/** A platform that knows no test and refuses every offer to its review queue with `error`, as a 429. */
async function refusingOffers(error: string): Promise<string> {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body =
        chunks.length === 0
          ? {}
          : (JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>);
      const reply = (status: number, payload: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      const url = req.url ?? '';
      if (url === '/v1/runs') return reply(201, { run: { id: 'r-9' }, joined: false });
      if (url === '/v1/test-cases/resolve') {
        const keys = (body['keys'] ?? []) as { value: string }[];
        return reply(200, { results: keys.map((key) => ({ key, testCaseId: null })) });
      }
      if (url === '/v1/review-items/discovered') return reply(429, { error });
      if (url.endsWith('/events')) return reply(200, { run: { id: 'r-9' }, changed: true });
      return reply(500, { error: `unexpected ${url}` });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** `plune run import report.xml --create`, as typed, against a platform that refuses the offer. */
async function importTyped(error: string): Promise<string> {
  const file = path.join(dir, 'report.xml');
  fs.writeFileSync(file, REPORT, 'utf8');
  vi.stubEnv('PLUNE_API_URL', await refusingOffers(error));
  await createProgram().parseAsync(['node', 'plune', 'run', 'import', file, '--create']);
  return printed.join('');
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plune-import-parser-'));
  printed = [];
  vi.stubEnv('PLUNE_TOKEN', 'tok-parser');
  // Nothing here is to reach a file of the machine it runs on, or the CI it runs in (plune#927).
  vi.stubEnv('PLUNE_FALLBACK', path.join(dir, 'pending.jsonl'));
  for (const marker of ['GITHUB_ACTIONS', 'GITLAB_CI', 'JENKINS_URL']) vi.stubEnv(marker, '');
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array): boolean => {
    printed.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
    return true;
  });
  // A command that fails ends the process; in a test that has to be a failure, not the end of it.
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`the command exited with ${String(code)}`);
  }) as (code?: string | number | null) => never);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('plune run import --create, when the platform refuses the offer (cli#71)', () => {
  it('at the project’s case limit says so — and does not say the review queue is full', async () => {
    const out = await importTyped(CASE_LIMIT);

    expect(out).not.toContain('the review queue is full');
    expect(out).toContain('2 more could not be offered — the project is at its test case limit.');
    expect(out).toContain('Delete cases you no longer need, or ask an operator to raise the limit');
    // The platform's own words are still above it, naming the limit.
    expect(out).toContain(`(${CASE_LIMIT})`);
  });

  it('when the queue is what is full, still says that, with what to do about a queue', async () => {
    const out = await importTyped(QUEUE_FULL);

    expect(out).toContain(
      '2 more could not be offered — the review queue is full. Approve or reject what is waiting',
    );
    expect(out).not.toContain('test case limit');
  });
});
