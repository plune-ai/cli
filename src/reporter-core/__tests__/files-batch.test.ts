import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { startRun } from '../session.js';
import type { PendingResult } from '../types.js';

/**
 * Platform ADR 0051: the files of a report go through `uploads-batch`, `complete-batch` and `direct-batch`, up to 100 a
 * request, each item judged alone. The fake below is the platform's three routes on a real socket (the answers follow
 * `files-batch.ts` of plune-ai/plune), plus the single routes an older platform has.
 */
interface Options {
  /** The project has a bucket (links) or not (`direct`). */
  bucket?: boolean;
  /** `false`: a platform older than the bulk routes — they answer a bare 404. */
  batch?: boolean;
  /** The file of this name is refused by `uploads-batch` (and only it). */
  refuse?: string;
  /** The first n answers of `uploads-batch` are 429 with `Retry-After: 0`. */
  limit429?: number;
  /** `complete-batch` calls the first completion of this file's name `bucket_unreachable` (retryable). */
  unreachableOnce?: string;
}

async function fake(o: Options = {}) {
  const bucket = o.bucket ?? true;
  const batch = o.batch ?? true;
  const calls: { route: string; body: any }[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  const puts: { name: string; bytes: Buffer }[] = [];
  const direct: { name: string; bytes: Buffer }[] = [];
  const announced = new Map<string, { key: string; name: string; type: string }>();
  const finished = new Set<string>();
  let limited = 0;
  let unreachable = o.unreachableOnce !== undefined;

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const reply = (status: number, payload: unknown, headers: Record<string, string> = {}): void => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify(payload));
      };
      const url = (req.url ?? '').split('?')[0]!;
      if (req.method === 'PUT') {
        puts.push({ name: decodeURIComponent(url.replace('/bucket/', '')), bytes: raw });
        return reply(200, {});
      }
      if (/\/files\?name=|\/files\/uploads$|\/complete$|-batch$/.test(url + (req.url ?? '').slice(url.length))) {
        calls.push({ route: url, body: raw.length > 0 && req.headers['content-type'] === 'application/json' ? JSON.parse(raw.toString()) : null });
      }
      const link = (name: string, type: string) => ({
        url: `http://${req.headers.host}/bucket/${encodeURIComponent(name)}?sig=S`,
        method: 'PUT',
        headers: { 'content-type': type },
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
      if (/-batch$/.test(url)) {
        if (!batch) return reply(404, {});
        const body = JSON.parse(raw.toString());
        if (url.endsWith('/uploads-batch')) {
          if (limited < (o.limit429 ?? 0)) {
            limited += 1;
            return reply(429, { error: 'slow down', code: 'rate_limited' }, { 'retry-after': '0' });
          }
          return reply(200, {
            items: body.items.map((f: { resultId: string; name: string; contentType: string; sha256?: string }, index: number) => {
              const key = `${f.resultId}\0${f.name}\0${f.contentType}\0${f.sha256}`;
              if (f.name === o.refuse) return { index, status: 'refused', code: 'file_too_large', error: 'too big', httpStatus: 413 };
              if (f.sha256 !== undefined && finished.has(key)) return { index, status: 'exists', id: `f-${f.name}`, name: f.name };
              if (!bucket) return { index, status: 'direct', name: f.name };
              announced.set(`f-${f.name}`, { key, name: f.name, type: f.contentType });
              return { index, status: 'upload', id: `f-${f.name}`, name: f.name, ...link(f.name, f.contentType) };
            }),
          });
        }
        if (url.endsWith('/complete-batch')) {
          return reply(200, {
            items: body.ids.map((id: string, index: number) => {
              const a = announced.get(id)!;
              if (unreachable && a.name === o.unreachableOnce) {
                unreachable = false;
                return { index, status: 'refused', code: 'bucket_unreachable', error: 'no answer', httpStatus: 502, retryable: true };
              }
              finished.add(a.key);
              return { index, id, status: 'ready', name: a.name, contentType: a.type, size: 1, storage: 'bucket' };
            }),
          });
        }
        return reply(200, {
          items: body.items.map((f: { name: string; contentType: string; data: string }, index: number) => {
            const bytes = Buffer.from(f.data, 'base64');
            direct.push({ name: f.name, bytes });
            return { index, status: 'stored', id: `d-${direct.length}`, name: f.name, contentType: f.contentType, size: bytes.length };
          }),
        });
      }
      // The single routes, as they always were.
      if (/\/v1\/results\/[^/]+\/files$/.test(url)) {
        direct.push({ name: decodeURIComponent(String(req.url).split('name=')[1]), bytes: raw });
        return reply(201, { id: `d-${direct.length}`, size: raw.length });
      }
      const body = raw.length === 0 ? {} : JSON.parse(raw.toString());
      if (url.endsWith('/files/uploads')) {
        return reply(200, {
          files: body.files.map((f: { name: string; contentType: string }) =>
            bucket ? { id: `f-${f.name}`, name: f.name, ...link(f.name, f.contentType) } : { name: f.name, direct: true },
          ),
        });
      }
      if (/\/v1\/files\/[^/]+\/complete$/.test(url)) return reply(200, {});
      if (url === '/v1/runs') return reply(201, { run: { id: 'r-1' }, joined: false });
      if (url === '/v1/test-cases/resolve') return reply(200, { results: body.keys.map((key: unknown) => ({ key, testCaseId: 'tc-1' })) });
      if (url.endsWith('/results')) {
        return reply(200, {
          items: body.results.map((r: { resultKey: string }, index: number) => ({ index, resultKey: r.resultKey, status: 'accepted', id: `id-${r.resultKey}` })),
          counts: { accepted: body.results.length, duplicate: 0, conflict: 0, rejected: 0 },
        });
      }
      if (url.endsWith('/events')) return reply(200, { run: { id: 'r-1' }, changed: true });
      return reply(500, { error: `unexpected ${url}` });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const to = (suffix: string) => calls.filter((c) => c.route.endsWith(suffix));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    calls,
    puts,
    direct,
    to,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plune-batch-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const bytesOf = (n: number): Buffer => Buffer.from([0x89, 0x50, 0x4e, 0x47, n & 255, n >> 8, 7, 7]);
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

/** One result with one picture each, `files` of them, reported to the fake and closed. */
async function report(platform: Awaited<ReturnType<typeof fake>>, files: number, names: (n: number) => string = (n) => `shot-${n}.png`) {
  const log: string[] = [];
  const run = await startRun({ apiUrl: platform.url, token: 'tok', fallbackPath: path.join(dir, 'pending.jsonl'), log: (l) => log.push(l) });
  for (let n = 0; n < files; n += 1) {
    const file = path.join(dir, `f${n}.png`);
    fs.writeFileSync(file, bytesOf(n));
    const result: PendingResult = {
      resultKey: `t${n}#0`,
      keys: [{ kind: 'playwright-id', value: `t${n}` }],
      source: 'playwright',
      rawStatus: 'passed',
      files: [{ name: names(n), contentType: 'image/png', path: file }],
    };
    await run.add(result);
  }
  await run.finish();
  return { run, log, line: log.find((l) => l.startsWith('plune: files —')) ?? '' };
}

describe('files by the bulk routes (platform ADR 0051)', () => {
  it('250 files are 3 + 3 requests, not 250 + 250 + 250, and each announced file carries its sha256', async () => {
    const p = await fake();
    try {
      const { run, line } = await report(p, 250);
      expect(run.stats.screenshots).toEqual({ uploaded: 250, skipped: 0, failed: 0 });
      expect(p.to('/uploads-batch')).toHaveLength(3);
      expect(p.to('/complete-batch')).toHaveLength(3);
      expect(p.to('/files/uploads')).toHaveLength(0);
      expect(p.to('/complete')).toHaveLength(0);
      const items = p.to('/uploads-batch').flatMap((c) => c.body.items);
      expect(items).toHaveLength(250);
      expect(Math.max(...p.to('/uploads-batch').map((c) => c.body.items.length))).toBe(100);
      const bySha = new Map(items.map((i: { name: string; sha256: string }) => [i.name, i.sha256]));
      expect(bySha.get('shot-7.png')).toBe(sha(bytesOf(7)));
      expect(p.puts).toHaveLength(250);
      expect(line).toMatch(/250 uploaded, 0 skipped, 0 already there \(skipped\), 0 retried, 0 dropped, .* \(16 at once, 6 request\(s\) to Plune\)$/);
    } finally {
      await p.close();
    }
  });

  it('a project without a bucket: announced once, then the bytes by direct-batch, 100 to a request', async () => {
    const p = await fake({ bucket: false });
    try {
      const { run } = await report(p, 130);
      expect(run.stats.screenshots.uploaded).toBe(130);
      expect(p.to('/uploads-batch')).toHaveLength(2);
      expect(p.to('/direct-batch').map((c) => c.body.items.length).sort()).toEqual([30, 100].sort());
      const one = p.to('/direct-batch').flatMap((c) => c.body.items).find((i: { name: string }) => i.name === 'shot-5.png');
      expect(Buffer.from(one.data, 'base64')).toEqual(bytesOf(5));
      expect(p.to('?name=')).toHaveLength(0);
    } finally {
      await p.close();
    }
  });

  it('a platform that does not know the bulk routes (404) is served the old way, and is asked once', async () => {
    const p = await fake({ batch: false });
    try {
      const { run, line } = await report(p, 30);
      expect(run.stats.screenshots).toEqual({ uploaded: 30, skipped: 0, failed: 0 });
      expect(p.to('/uploads-batch')).toHaveLength(1);
      expect(p.to('/complete-batch')).toHaveLength(0);
      expect(p.to('/files/uploads')).toHaveLength(30);
      expect(p.to('/complete')).toHaveLength(30);
      expect(p.puts).toHaveLength(30);
      expect(line).toMatch(/\(16 at once, 61 request\(s\) to Plune\)$/); // 1 refused announce + 30 asks + 30 completes (the PUTs go to the bucket)
    } finally {
      await p.close();
    }
  });

  it('the same report sent again: every file is `exists`, no second PUT and no second complete', async () => {
    const p = await fake();
    try {
      await report(p, 40);
      expect(p.puts).toHaveLength(40);
      const again = await report(p, 40);
      expect(p.puts).toHaveLength(40);
      expect(p.to('/complete-batch')).toHaveLength(1);
      expect(again.run.stats.screenshots).toEqual({ uploaded: 0, skipped: 0, failed: 0 });
      expect(again.line).toMatch(/0 uploaded, 0 skipped, 40 already there \(skipped\), 0 retried, 0 dropped/);
    } finally {
      await p.close();
    }
  });

  it('one refused item is counted and said; the other 59 in its request go through', async () => {
    const p = await fake({ refuse: 'shot-13.png' });
    try {
      const { run, log } = await report(p, 60);
      expect(run.stats.screenshots).toEqual({ uploaded: 59, skipped: 0, failed: 1 });
      expect(p.puts).toHaveLength(59);
      expect(p.puts.some((x) => x.name === 'shot-13.png')).toBe(false);
      expect(p.to('/uploads-batch')).toHaveLength(1); // the refusal costs no second request
      expect(log.filter((l) => /could not upload/.test(l))).toHaveLength(1);
    } finally {
      await p.close();
    }
  });

  it('a 429 on a batch waits out its Retry-After and sends the same batch again', async () => {
    const p = await fake({ limit429: 2 });
    try {
      const { run, line } = await report(p, 20);
      expect(run.stats.screenshots).toEqual({ uploaded: 20, skipped: 0, failed: 0 });
      expect(p.to('/uploads-batch')).toHaveLength(3); // 2 limited + 1 taken
      expect(p.to('/uploads-batch')[2]!.body.items).toHaveLength(20);
      expect(line).toMatch(/ 2 retried, /);
    } finally {
      await p.close();
    }
  });

  it('a file whose bucket did not answer at complete goes to complete again — alone', async () => {
    const p = await fake({ unreachableOnce: 'shot-3.png' });
    try {
      const { run } = await report(p, 10);
      expect(run.stats.screenshots).toEqual({ uploaded: 10, skipped: 0, failed: 0 });
      const completes = p.to('/complete-batch');
      expect(completes.map((c) => c.body.ids.length)).toEqual([10, 1]);
      expect(completes[1]!.body.ids).toEqual(['f-shot-3.png']);
      expect(p.puts).toHaveLength(10); // not PUT twice
    } finally {
      await p.close();
    }
  });
});
