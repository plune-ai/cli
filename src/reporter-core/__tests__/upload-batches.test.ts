import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { startRun } from '../session.js';
import type { PendingResult } from '../types.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plune-batches-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

interface Call {
  path: string;
  /** Local port of the client's socket: equal ports are one connection. */
  socket: number;
  /** Position in one sequence of arrivals and answers (end is -1 until answered). */
  start: number;
  end: number;
}

/** A platform on a real local socket that answers after `latencyMs`, records every call, and can refuse one results batch. */
async function platform(opts: { latencyMs?: number; failResultsCall?: number } = {}) {
  const calls: Call[] = [];
  let inflight = 0;
  let maxInflight = 0;
  let resultCalls = 0;
  let seq = 0;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      const body = raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>);
      const url = req.url ?? '';
      const isResults = /\/results$/.test(url);
      const n = isResults ? resultCalls++ : -1;
      const call: Call = { path: url, socket: req.socket.remotePort ?? 0, start: seq++, end: -1 };
      calls.push(call);
      if (isResults) maxInflight = Math.max(maxInflight, ++inflight);
      setTimeout(() => {
        if (isResults) inflight -= 1;
        call.end = seq++;
        const send = (status: number, payload: unknown): void => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(payload));
        };
        if (url.endsWith('/v1/test-cases/resolve')) {
          const keys = body['keys'] as { value: string }[];
          return send(200, {
            results: keys.map((k) => ({ key: k, testCaseId: `tc-${k.value}`, matchedKind: null })),
          });
        }
        if (url.endsWith('/v1/runs')) return send(201, { run: { id: 'r-1' }, joined: false });
        if (isResults) {
          if (n === opts.failResultsCall) return send(400, { error: 'refused' });
          const list = body['results'] as unknown[];
          return send(200, {
            items: [],
            counts: { accepted: list.length, duplicate: 0, conflict: 0, rejected: 0 },
          });
        }
        if (url.endsWith('/events')) return send(200, { run: { id: 'r-1' }, changed: true });
        return send(500, { error: `unexpected ${url}` });
      }, opts.latencyMs ?? 0);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    calls,
    results: () => calls.filter((c) => /\/results$/.test(c.path)),
    get maxInflight() {
      return maxInflight;
    },
    close: () => {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const item = (i: number): PendingResult => ({
  resultKey: `t${i}#0`,
  keys: [{ kind: 'playwright-id', value: `t${i}` }],
  source: 'playwright',
  rawStatus: 'passed',
});

async function report(
  count: number,
  over: { batchSize?: number } = {},
  opts: Parameters<typeof platform>[0] = {},
) {
  const fake = await platform(opts);
  const fallbackPath = path.join(dir, 'pending.jsonl');
  try {
    const run = await startRun({
      apiUrl: fake.url,
      token: 'tok',
      fallbackPath,
      log: () => undefined,
      ...over,
    });
    for (let i = 0; i < count; i += 1) await run.add(item(i));
    await run.finish();
    return {
      run,
      fallbackPath,
      results: fake.results(),
      calls: [...fake.calls],
      maxInflight: fake.maxInflight,
    };
  } finally {
    await fake.close();
  }
}

describe('result batches (plune-ai/plune#1393)', () => {
  it('7 000 results are 14 requests by default, where batches of 100 were 70', async () => {
    const before = await report(7000, { batchSize: 100 });
    const after = await report(7000);
    console.info(
      `7 000 results: ${before.results.length} result requests at 100 per batch, ${after.results.length} at the default (500)`,
    );
    expect(before.results.length).toBe(70);
    expect(after.results.length).toBe(14);
    expect(after.run.stats).toMatchObject({ accepted: 7000, deferred: 0 });
  });

  it('keeps four batches in flight, after the first one has been answered alone', async () => {
    const { results, maxInflight } = await report(7000, {}, { latencyMs: 30 });
    // never more than four; the exact peak depends on timers, so only "several" is asserted
    expect(maxInflight).toBeLessThanOrEqual(4);
    expect(maxInflight).toBeGreaterThanOrEqual(2);
    // the second request arrived only after the first was answered
    expect(results[1]!.start).toBeGreaterThan(results[0]!.end);
  });

  it('starts the run before any result, and finishes after the last one is answered', async () => {
    const { calls, results } = await report(2500, {}, { latencyMs: 10 });
    const start = calls.find((c) => c.path.endsWith('/v1/runs'))!;
    const finish = calls.find((c) => c.path.endsWith('/events'))!;
    expect(start.start).toBeLessThan(Math.min(...results.map((r) => r.start)));
    expect(finish.end).toBeGreaterThan(Math.max(...results.map((r) => r.end)));
    expect(calls.at(-1)).toBe(finish);
  });

  it('reuses connections: a handful of sockets for all the requests', async () => {
    const { calls } = await report(7000, {}, { latencyMs: 5 });
    expect(calls.length).toBeGreaterThan(14);
    expect(new Set(calls.map((c) => c.socket)).size).toBeLessThanOrEqual(5);
  });

  it('a refused batch goes to the fallback file alone; the others are delivered', async () => {
    const { run, fallbackPath, results } = await report(
      2500,
      {},
      { latencyMs: 5, failResultsCall: 2 },
    );
    expect(results.length).toBe(5);
    expect(run.stats).toMatchObject({ accepted: 2000, deferred: 500 });
    const lines = fs.readFileSync(fallbackPath, 'utf8').trim().split('\n');
    expect(lines.length).toBe(1);
    expect((JSON.parse(lines[0]!) as { results: unknown[] }).results.length).toBe(500);
  });

  it('a process that used the pool exits on its own, with the server still listening', async () => {
    const fake = await platform();
    try {
      const clientUrl = new URL('../client.ts', import.meta.url).href;
      const code = [
        `import { nodeTransport } from ${JSON.stringify(clientUrl)};`,
        'for (let i = 0; i < 3; i += 1) {',
        `  const res = await nodeTransport(${JSON.stringify(fake.url)} + '/v1/runs', { method: 'POST', headers: {}, body: '{}' });`,
        '  await res.json();',
        '}',
        "console.log('done');",
      ].join('\n');
      const exit = await new Promise<{ code: number | null; out: string }>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ['--import', 'tsx', '--input-type=module', '-e', code],
          { cwd: process.cwd() },
        );
        let out = '';
        child.stdout.on('data', (d: Buffer) => (out += d.toString()));
        child.on('error', reject);
        child.on('exit', (c) => resolve({ code: c, out }));
        setTimeout(() => child.kill(), 20_000).unref();
      });
      expect(exit).toEqual({ code: 0, out: 'done\n' });
      expect(new Set(fake.calls.map((c) => c.socket)).size).toBe(1);
    } finally {
      await fake.close();
    }
  }, 30_000);
});
