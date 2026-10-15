import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createClient, parseRetryAfter, RETRY_AFTER_CAP_MS } from '../client.js';
import { readEnv } from '../env.js';
import { startRun } from '../session.js';
import type { PendingResult } from '../types.js';
import { fakePlatform, type FakeOptions } from './fake-platform.js';

let dir: string;
let png: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plune-uploads-'));
  png = path.join(dir, 'shot.png');
  fs.writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]));
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

const withShot = (n: number): PendingResult => ({
  resultKey: `t${n}#0`,
  keys: [{ kind: 'playwright-id', value: `t${n}` }],
  source: 'playwright',
  rawStatus: 'passed',
  files: [{ name: 'shot.png', contentType: 'image/png', path: png }],
});

/** Reports `files` results with one picture each to a fake platform and closes the run. */
async function report(files: number, fake: FakeOptions, over: Record<string, unknown> = {}) {
  const platform = await fakePlatform(fake);
  const log: string[] = [];
  try {
    const run = await startRun({
      apiUrl: platform.url,
      token: 'tok',
      fallbackPath: path.join(dir, 'pending.jsonl'),
      log: (line) => log.push(line),
      ...over,
    });
    for (let i = 0; i < files; i += 1) await run.add(withShot(i));
    const started = Date.now();
    await run.finish();
    return { platform, run, log, ms: Date.now() - started };
  } finally {
    await platform.close();
  }
}

describe('PLUNE_UPLOAD_CONCURRENCY — how many files are in flight', () => {
  it('keeps four at once when nothing is set', async () => {
    const { platform } = await report(40, { latencyMs: 15 });
    expect(platform.maxInflight).toBe(4);
  });

  it('never has more in flight than the variable says, and does use them', async () => {
    vi.stubEnv('PLUNE_UPLOAD_CONCURRENCY', '2');
    const slow = await report(24, { latencyMs: 15 });
    expect(slow.platform.maxInflight).toBe(2);

    vi.stubEnv('PLUNE_UPLOAD_CONCURRENCY', '16');
    const wide = await report(60, { latencyMs: 15 });
    expect(wide.platform.maxInflight).toBeGreaterThan(4);
    expect(wide.platform.maxInflight).toBeLessThanOrEqual(16);
    expect(wide.run.stats.screenshots.uploaded).toBe(60);
  });

  it('takes the value passed in (the --upload-concurrency flag) over the variable', async () => {
    vi.stubEnv('PLUNE_UPLOAD_CONCURRENCY', '8');
    const { platform } = await report(30, { latencyMs: 15 }, { uploadConcurrency: 1 });
    expect(platform.maxInflight).toBe(1);
  });

  it.each(['abc', '0', '-3', '33', '2.5', '1e1'])('falls back to four, and says so, for %j', async (bad) => {
    vi.stubEnv('PLUNE_UPLOAD_CONCURRENCY', bad);
    const { platform, log } = await report(20, { latencyMs: 15 });
    expect(platform.maxInflight).toBe(4);
    expect(log.filter((l) => l.includes('PLUNE_UPLOAD_CONCURRENCY'))).toHaveLength(1);
    expect(log.find((l) => l.includes('PLUNE_UPLOAD_CONCURRENCY'))).toMatch(/1 to 32 — using 4/);
  });

  it('reads the bounds as the documentation gives them', () => {
    const read = (v: string) => readEnv({ PLUNE_UPLOAD_CONCURRENCY: v });
    expect(read('1').config.uploadConcurrency).toBe(1);
    expect(read('32').config.uploadConcurrency).toBe(32);
    expect(read('33').config.uploadConcurrency).toBeUndefined();
    expect(readEnv({}).warnings).toEqual([]);
  });
});

describe('a 429 on the uploads', () => {
  it('waits out its Retry-After before the file is tried again', async () => {
    const { platform, run, ms } = await report(1, { limiter: (n) => (n === 1 ? { retryAfter: '1' } : undefined) });
    expect(run.stats.screenshots).toEqual({ uploaded: 1, skipped: 0, failed: 0 });
    const [first, second] = platform.arrivals;
    expect(first?.status).toBe(429);
    expect((second as { at: number }).at - (first as { at: number }).at).toBeGreaterThanOrEqual(990);
    expect(ms).toBeGreaterThanOrEqual(990);
  });

  it('holds back the files that are not waiting yet: one told to wait slows all of them', async () => {
    const { platform } = await report(24, { latencyMs: 20, limiter: (n) => (n === 6 ? { retryAfter: '1' } : undefined) });
    const told = platform.arrivals.find((a) => a.status === 429) as { at: number };
    // 20 ms for the answer to come back; from then on, nothing new reaches the platform until the pause is over.
    const during = platform.arrivals.filter((a) => a.at > told.at + 60 && a.at < told.at + 950);
    expect(during).toEqual([]);
    expect(platform.stored).toBe(24);
  });

  it('drains a storm without dropping a file when the retries suffice', async () => {
    const { run, log } = await report(40, { latencyMs: 2, limiter: (n) => (n <= 20 ? { retryAfter: '0' } : undefined) });
    expect(run.stats.screenshots).toEqual({ uploaded: 40, skipped: 0, failed: 0 });
    const files = log.find((l) => l.startsWith('plune: files —')) ?? '';
    expect(files).toMatch(/^plune: files — 40 uploaded, 0 skipped, 20 retried, 0 dropped, in \d+\.\d s \(4 at once\)$/);
  });

  it('drops the file — counted, said, the run still closes — when the retries are used up', async () => {
    vi.stubEnv('PLUNE_UPLOAD_RETRIES', '2');
    const { run, log } = await report(3, { limiter: () => ({ retryAfter: '0' }) });
    expect(run.stats.screenshots).toEqual({ uploaded: 0, skipped: 0, failed: 3 });
    expect(log.some((l) => /its result is reported without it/.test(l))).toBe(true);
    expect(log.find((l) => l.startsWith('plune: files —'))).toMatch(/0 uploaded, 0 skipped, 6 retried, 3 dropped/);
    expect(log.at(-1)).toMatch(/^plune: 3 accepted/);
  });

  it('does not retry a 429 that names no time: that is the quota, and waiting does not lift it', async () => {
    const { platform, run } = await report(2, { limiter: () => ({ retryAfter: null }) });
    expect(platform.arrivals).toHaveLength(2);
    expect(run.stats.screenshots.failed).toBe(2);
  });

  it('takes PLUNE_UPLOAD_RETRIES, and falls back to six for a value that is not a count', async () => {
    vi.stubEnv('PLUNE_UPLOAD_RETRIES', '0');
    const none = await report(1, { limiter: () => ({ retryAfter: '0' }) });
    expect(none.platform.arrivals).toHaveLength(1);

    vi.stubEnv('PLUNE_UPLOAD_RETRIES', 'many');
    const dflt = await report(1, { limiter: () => ({ retryAfter: '0' }) });
    expect(dflt.platform.arrivals).toHaveLength(7);
    expect(dflt.log.some((l) => l.includes('PLUNE_UPLOAD_RETRIES') && l.includes('using 6'))).toBe(true);
  });
});

describe('Retry-After and the jitter', () => {
  const now = Date.parse('2026-10-15T12:00:00Z');

  it('reads seconds and an HTTP date, and nothing else', () => {
    expect(parseRetryAfter('7', now)).toBe(7000);
    expect(parseRetryAfter(' 0 ', now)).toBe(0);
    expect(parseRetryAfter('Thu, 15 Oct 2026 12:00:09 GMT', now)).toBe(9000);
    expect(parseRetryAfter('Thu, 15 Oct 2026 11:00:00 GMT', now)).toBe(0);
    expect(parseRetryAfter('soon', now)).toBeNull();
    expect(parseRetryAfter('', now)).toBeNull();
    expect(parseRetryAfter(null, now)).toBeNull();
  });

  it('caps what it will wait at a minute', () => {
    expect(parseRetryAfter('86400', now)).toBe(RETRY_AFTER_CAP_MS);
    expect(parseRetryAfter('Fri, 16 Oct 2026 12:00:00 GMT', now)).toBe(RETRY_AFTER_CAP_MS);
  });

  const waits = async (random: number, headers: Record<string, string>) => {
    const waited: number[] = [];
    let calls = 0;
    const client = createClient({
      apiUrl: 'https://api.test',
      token: 't',
      random: () => random,
      wait: async (ms) => void waited.push(ms),
      fetchImpl: (async () =>
        ++calls === 1
          ? new Response('{}', { status: 429, headers })
          : new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch,
    });
    await client.post('/v1/runs', {});
    return waited;
  };

  it('never waits less than the platform asked, nor more than half as much again', async () => {
    expect(await waits(0, { 'retry-after': '2' })).toEqual([2000]);
    const [high] = await waits(0.999999, { 'retry-after': '2' });
    expect(high).toBeGreaterThanOrEqual(2000);
    expect(high).toBeLessThanOrEqual(3000);
  });

  it('honours an HTTP date', async () => {
    const date = new Date(Date.now() + 5000).toUTCString();
    const [ms] = await waits(0, { 'retry-after': date });
    expect(ms).toBeGreaterThan(3500);
    expect(ms).toBeLessThanOrEqual(5000);
  });

  it('backs off exponentially when nothing was said, and only twice for a platform that is down', async () => {
    const waited: number[] = [];
    const down = createClient({
      apiUrl: 'https://api.test',
      token: 't',
      uploadRetries: 8,
      random: () => 0,
      wait: async (ms) => void waited.push(ms),
      fetchImpl: (async () => {
        throw new TypeError('fetch failed');
      }) as unknown as typeof fetch,
    });
    await down.post('/v1/runs', {});
    expect(waited).toEqual([300, 600]);
  });
});
