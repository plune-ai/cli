import {
  copyFile,
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { formatIngestResult, handleIngest } from '../commands/ingest.js';
import { platformJobs } from './job-platform.js';

// `plune ingest` of a run recorded with `--screencast`: each case's video and trace go to what the ingest made of the case, by the
// `items` of its answer — the proposal in the review queue, or the result of a case approved before.

const here = path.dirname(fileURLToPath(import.meta.url));
/** Three cases of the `design` fixture, by `stableId`. */
const [A, B, C] = ['b94c281595ac', 'cc5eb42f9568', 'ba312863c50b'];

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

/** A copy of the `design` run with recordings: `screencasts/<test>/video.webm` (+ `trace.zip`) for each entry. */
async function recordedRun(
  entries: { stableId?: string; test: string; trace?: boolean; videoBytes?: number }[],
): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'plune-ingest-files-'));
  dirs.push(dir);
  await copyFile(
    path.join(here, 'fixtures', 'cairn', 'design', 'report.json'),
    path.join(dir, 'report.json'),
  );
  await mkdir(path.join(dir, 'screencasts'));
  const index = [];
  for (const e of entries) {
    await mkdir(path.join(dir, 'screencasts', e.test), { recursive: true });
    const video = `screencasts/${e.test}/video.webm`;
    await writeFile(path.join(dir, video), 'webm-bytes');
    if (e.videoBytes !== undefined) await truncate(path.join(dir, video), e.videoBytes);
    const trace = `screencasts/${e.test}/trace.zip`;
    if (e.trace === true) await writeFile(path.join(dir, trace), 'zip-bytes');
    index.push({
      test: e.test,
      ...(e.stableId !== undefined ? { stableId: e.stableId } : {}),
      video,
      ...(e.trace === true ? { trace } : {}),
      chapters: [],
    });
  }
  await writeFile(path.join(dir, 'screencasts', 'screencasts.json'), JSON.stringify(index));
  return dir;
}

type Answer = { status: number; body: unknown };

/**
 * The platform as `fetch`: the ingest (201, or 200 for a repeat), the job queue, the one-file routes of a review item and of a
 * result, a bucket on `bucket.test`, and `complete`. `refuse` answers a file's step 1 in place of the platform.
 */
function fakePlatform(
  opts: {
    items?: unknown;
    status?: number;
    bucket?: boolean;
    refuse?: (name: string, owner: string) => Answer | undefined;
    /** What each target already holds, by `review-items/<id>` or `results/<id>`: the names of its files. */
    held?: Record<string, string[]>;
  } = {},
) {
  const calls: string[] = [];
  const puts: string[] = [];
  const direct: string[] = [];
  const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = (async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    const method = init.method ?? 'GET';
    if (url.pathname.startsWith('/v1/jobs')) {
      return platformJobs({
        url: input,
        method,
        body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      });
    }
    if (url.host === 'bucket.test') {
      puts.push(decodeURIComponent(url.pathname));
      return new Response('', { status: 200 });
    }
    calls.push(`${method} ${url.pathname}`);
    if (url.pathname === '/v1/ingest/cairn') {
      return json(opts.status ?? 201, {
        runId: 'run-1',
        linked: 1,
        proposed: 2,
        skipped: 0,
        ...(opts.items !== undefined ? { items: opts.items } : {}),
      });
    }
    const owned = /^\/v1\/(review-items|results)\/([^/]+)\/files(\/uploads)?$/.exec(url.pathname);
    if (owned !== null && owned[3] === '/uploads') {
      const [file] = (
        JSON.parse(init.body as string) as { files: { name: string; contentType: string }[] }
      ).files;
      const refused = opts.refuse?.(file!.name, owned[1]!);
      if (refused !== undefined) return json(refused.status, refused.body);
      if (opts.bucket === false)
        return json(200, { files: [{ name: file!.name, skipped: 'no_storage' }] });
      return json(200, {
        files: [
          {
            id: `f-${owned[2]}-${file!.name}`,
            name: file!.name,
            url: `https://bucket.test/${owned[1]}/${owned[2]}/${file!.name}`,
            method: 'PUT',
            headers: { 'content-type': file!.contentType },
          },
        ],
      });
    }
    if (owned !== null) {
      direct.push(`${owned[1]}/${owned[2]}/${url.searchParams.get('name')}`);
      return json(201, { id: 'f-direct' });
    }
    if (/^\/v1\/files\/[^/]+\/complete$/.test(url.pathname)) return json(200, {});
    const filesOf = (key: string) =>
      (opts.held?.[key] ?? []).map((name, i) => ({ id: `h-${i}`, name }));
    const item = /^\/v1\/review-items\/([^/]+)$/.exec(url.pathname);
    if (method === 'GET' && item !== null)
      return json(200, { id: item[1], files: filesOf(`review-items/${item[1]}`) });
    if (method === 'GET' && url.pathname === '/v1/runs/run-1/results') {
      // One result a page, `next` while more remain: the reader must follow it.
      const ids = Object.keys(opts.held ?? {})
        .filter((k) => k.startsWith('results/'))
        .map((k) => k.slice('results/'.length));
      const at = Number(url.searchParams.get('before') ?? '0');
      const id = ids[at];
      return json(200, {
        results: id === undefined ? [] : [{ id, files: filesOf(`results/${id}`) }],
        ...(at + 1 < ids.length ? { next: String(at + 1) } : {}),
      });
    }
    return json(500, { error: `unexpected ${method} ${url.pathname}` });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls, puts, direct };
}

const ingest = (dir: string, fetchImpl: typeof fetch) =>
  handleIngest({ dir, apiUrl: 'https://api.test', loadToken: () => 'plune_test_token', fetchImpl });

describe('plune ingest · the run’s recordings go with its proposals', () => {
  it('sends each case’s video and trace to its review item, or to its result when only a result is named', async () => {
    const dir = await recordedRun([
      { stableId: A, test: 'cart', trace: true },
      { stableId: B, test: 'login' },
    ]);
    const p = fakePlatform({
      items: [
        { stableId: A, reviewItemId: 'ri-1' },
        { stableId: B, resultId: 'res-9' },
      ],
    });
    const result = await ingest(dir, p.fetchImpl);

    expect(p.calls).toEqual(
      expect.arrayContaining([
        'POST /v1/review-items/ri-1/files/uploads',
        'POST /v1/files/f-ri-1-video.webm/complete',
        'POST /v1/files/f-ri-1-trace.zip/complete',
        'POST /v1/results/res-9/files/uploads',
        'POST /v1/files/f-res-9-video.webm/complete',
      ]),
    );
    expect(p.puts.sort()).toEqual([
      '/results/res-9/video.webm',
      '/review-items/ri-1/trace.zip',
      '/review-items/ri-1/video.webm',
    ]);
    expect(result.files).toEqual(['3 session file(s) uploaded']);
    expect(formatIngestResult(result)).toContain('\n  3 session file(s) uploaded\n');
  });

  it('a recording whose case the ingest skipped, or that names no case, stays behind with one line', async () => {
    const dir = await recordedRun([
      { stableId: A, test: 'cart' },
      { stableId: C, test: 'skipped-case' },
      { test: 'hand-written' },
    ]);
    const p = fakePlatform({ items: [{ stableId: A, reviewItemId: 'ri-1' }] });
    const result = await ingest(dir, p.fetchImpl);
    expect(p.puts).toEqual(['/review-items/ri-1/video.webm']);
    expect(result.files).toEqual([
      '1 session file(s) uploaded',
      '1 recording(s) name no case — not uploaded',
      '1 case(s) with recordings got no proposal or result in this run — not uploaded',
    ]);
  });

  it('a file over 100 MiB is skipped with a line, never asked about, and the others still go', async () => {
    const dir = await recordedRun([
      { stableId: A, test: 'cart', trace: true, videoBytes: 100 * 1024 * 1024 + 1 },
    ]);
    const p = fakePlatform({ items: [{ stableId: A, reviewItemId: 'ri-1' }] });
    const result = await ingest(dir, p.fetchImpl);
    expect(p.puts).toEqual(['/review-items/ri-1/trace.zip']);
    expect(result.files).toEqual([
      '1 session file(s) uploaded, 1 skipped',
      '"video.webm" skipped — larger than the 100 MiB a session file may be',
    ]);
  });

  it('413 file_too_large and 409 too_many_files are report lines; the ingest succeeds', async () => {
    const dir = await recordedRun([{ stableId: A, test: 'cart', trace: true }]);
    const p = fakePlatform({
      items: [{ stableId: A, reviewItemId: 'ri-1' }],
      refuse: (name) =>
        name === 'video.webm'
          ? { status: 413, body: { error: "'video.webm' is too big", code: 'file_too_large' } }
          : { status: 409, body: { error: 'review item holds 30 files', code: 'too_many_files' } },
    });
    const result = await ingest(dir, p.fetchImpl);
    expect(result.runId).toBe('run-1');
    expect(p.puts).toEqual([]);
    expect(result.files?.[0]).toBe('0 session file(s) uploaded, 2 failed to upload');
    expect(result.files).toEqual(
      expect.arrayContaining([
        '"video.webm" not uploaded to your bucket (file_too_large) — the run is recorded without it.',
        '"trace.zip" not uploaded to your bucket (too_many_files) — the run is recorded without it.',
      ]),
    );
  });

  it('a decided review item (409 without a code) is one line, and the ingest succeeds', async () => {
    const dir = await recordedRun([{ stableId: A, test: 'cart', trace: true }]);
    const p = fakePlatform({
      items: [{ stableId: A, reviewItemId: 'ri-1' }],
      refuse: () => ({
        status: 409,
        body: { error: 'the review item is decided — it takes no more files' },
      }),
    });
    const result = await ingest(dir, p.fetchImpl);
    expect(result.files).toEqual([
      '0 session file(s) uploaded, 2 failed to upload',
      'could not upload a file (the review item is decided — it takes no more files) — the run is recorded without it.',
    ]);
  });

  it('a known case’s result that no longer takes files (409, the run is closed) is one line; the proposal’s files still go', async () => {
    const dir = await recordedRun([
      { stableId: A, test: 'cart' },
      { stableId: B, test: 'login', trace: true },
    ]);
    const p = fakePlatform({
      items: [
        { stableId: A, reviewItemId: 'ri-1' },
        { stableId: B, resultId: 'res-9' },
      ],
      refuse: (_name, owner) =>
        owner === 'results'
          ? { status: 409, body: { error: 'the run is closed — its results stand' } }
          : undefined,
    });
    const result = await ingest(dir, p.fetchImpl);
    expect(p.puts).toEqual(['/review-items/ri-1/video.webm']);
    expect(result.files).toEqual([
      '1 session file(s) uploaded, 2 failed to upload',
      'could not upload a file (the run is closed — its results stand) — the run is recorded without it.',
    ]);
  });

  it('without a bucket a video or a trace has no place: skipped, said once, nothing sent to the direct route', async () => {
    const dir = await recordedRun([{ stableId: A, test: 'cart', trace: true }]);
    const p = fakePlatform({ items: [{ stableId: A, reviewItemId: 'ri-1' }], bucket: false });
    const result = await ingest(dir, p.fetchImpl);
    expect(p.direct).toEqual([]);
    expect(result.files).toEqual([
      '0 session file(s) uploaded, 2 skipped',
      '"video.webm" not stored — no storage bucket is connected to this project.',
    ]);
  });

  it('a platform that sends no `items` gets no files, and one line says why', async () => {
    const dir = await recordedRun([{ stableId: A, test: 'cart', trace: true }]);
    const p = fakePlatform();
    const result = await ingest(dir, p.fetchImpl);
    expect(p.calls).toEqual(['POST /v1/ingest/cairn']);
    expect(result).toMatchObject({
      runId: 'run-1',
      files: ['session files not uploaded — this Plune is older than the routes that take them'],
    });
  });

  it('a repeat ingest (200) sends only the files its review item does not hold yet', async () => {
    const dir = await recordedRun([{ stableId: A, test: 'cart', trace: true }]);
    const p = fakePlatform({
      items: [{ stableId: A, reviewItemId: 'ri-1' }],
      status: 200,
      held: { 'review-items/ri-1': ['video.webm'] },
    });
    const result = await ingest(dir, p.fetchImpl);
    expect(p.calls).toContain('GET /v1/review-items/ri-1');
    expect(p.puts).toEqual(['/review-items/ri-1/trace.zip']);
    expect(result.files).toEqual([
      '1 session file(s) uploaded',
      '1 file(s) already on the platform, 1 sent',
    ]);
  });

  it('a repeat ingest whose files are all there sends none; a result is read from the run’s results, page by page', async () => {
    const dir = await recordedRun([
      { stableId: A, test: 'cart', trace: true },
      { stableId: B, test: 'login' },
    ]);
    const p = fakePlatform({
      items: [
        { stableId: A, reviewItemId: 'ri-1' },
        { stableId: B, resultId: 'res-9' },
      ],
      status: 200,
      held: {
        'review-items/ri-1': ['video.webm', 'trace.zip'],
        'results/res-0': [],
        'results/res-9': ['video.webm'],
      },
    });
    const result = await ingest(dir, p.fetchImpl);
    expect(p.calls).toContain('GET /v1/runs/run-1/results');
    expect(p.puts).toEqual([]);
    expect(result.files).toEqual([
      '0 session file(s) uploaded',
      '3 file(s) already on the platform, 0 sent',
    ]);
  });

  it('a repeat ingest that cannot read what a target holds sends nothing there, and says so', async () => {
    const dir = await recordedRun([{ stableId: A, test: 'cart' }]);
    const p = fakePlatform({ items: [{ stableId: A, reviewItemId: 'ri-gone' }], status: 200 });
    const base = p.fetchImpl;
    const fetchImpl = (async (input: string, init?: RequestInit) =>
      new URL(input).pathname === '/v1/review-items/ri-gone' && (init?.method ?? 'GET') === 'GET'
        ? new Response(JSON.stringify({ error: "review item 'ri-gone' not found" }), {
            status: 404,
          })
        : base(input, init)) as unknown as typeof fetch;
    const result = await ingest(dir, fetchImpl);
    expect(p.puts).toEqual([]);
    expect(result.files).toEqual([
      '0 session file(s) uploaded',
      '1 file(s) not sent again — what the platform holds could not be read',
      '0 file(s) already on the platform, 0 sent',
    ]);
  });

  it('a run without recordings says nothing about files', async () => {
    const p = fakePlatform({ items: [{ stableId: A, reviewItemId: 'ri-1' }] });
    const result = await ingest(path.join(here, 'fixtures', 'cairn', 'design'), p.fetchImpl);
    expect(result).not.toHaveProperty('files');
    expect(p.calls).toEqual(['POST /v1/ingest/cairn']);
  });

  it('a recording path that leaves the run directory is not uploaded', async () => {
    const dir = await recordedRun([]);
    await writeFile(
      path.join(dir, 'screencasts', 'screencasts.json'),
      JSON.stringify([
        { test: 'x', stableId: A, video: '../../outside.webm', chapters: [] },
        // A file that exists, named by an absolute path outside the run.
        {
          test: 'y',
          stableId: A,
          video: path.join(here, 'fixtures', 'cairn', 'design', 'report.json'),
          chapters: [],
        },
      ]),
    );
    const p = fakePlatform({ items: [{ stableId: A, reviewItemId: 'ri-1' }] });
    const result = await ingest(dir, p.fetchImpl);
    expect(p.puts).toEqual([]);
    expect(result.files).toEqual([
      '0 session file(s) uploaded',
      '2 file(s) not uploaded — the path leaves the run directory',
    ]);
  });

  /** A link (a symlink, or a junction for a directory where Windows refuses symlinks), or `false` where the OS refuses both. */
  async function link(target: string, at: string, kind: 'file' | 'dir'): Promise<boolean> {
    for (const type of kind === 'dir' ? (['dir', 'junction'] as const) : (['file'] as const)) {
      try {
        await symlink(target, at, type);
        return true;
      } catch {
        // EPERM: no symlink privilege here (Windows without developer mode); try the next kind
      }
    }
    return false;
  }

  it('a recording that is a link to a file outside the run directory is not uploaded', async (ctx) => {
    const dir = await recordedRun([{ stableId: A, test: 'cart', trace: true }]);
    const outside = await mkdtemp(path.join(tmpdir(), 'plune-outside-'));
    dirs.push(outside);
    await writeFile(path.join(outside, 'secret.webm'), 'not the run’s');
    const video = path.join(dir, 'screencasts', 'cart', 'video.webm');
    await rm(video);
    // Skipped only where this OS refuses this user a file symlink (Windows without developer mode).
    if (!(await link(path.join(outside, 'secret.webm'), video, 'file'))) ctx.skip();
    const p = fakePlatform({ items: [{ stableId: A, reviewItemId: 'ri-1' }] });
    const result = await ingest(dir, p.fetchImpl);
    expect(p.puts).toEqual(['/review-items/ri-1/trace.zip']);
    expect(result.files).toEqual([
      '1 session file(s) uploaded',
      '1 file(s) not uploaded — the path leaves the run directory',
    ]);
  });

  it('a `screencasts` directory that is a link (or junction) to a directory outside the run uploads nothing from it', async (ctx) => {
    const dir = await recordedRun([{ stableId: A, test: 'cart', trace: true }]);
    const outside = await mkdtemp(path.join(tmpdir(), 'plune-outside-'));
    dirs.push(outside);
    await rename(path.join(dir, 'screencasts'), path.join(outside, 'screencasts'));
    if (!(await link(path.join(outside, 'screencasts'), path.join(dir, 'screencasts'), 'dir')))
      ctx.skip();
    const p = fakePlatform({ items: [{ stableId: A, reviewItemId: 'ri-1' }] });
    const result = await ingest(dir, p.fetchImpl);
    expect(p.puts).toEqual([]);
    expect(result.files).toEqual([
      '0 session file(s) uploaded',
      '2 file(s) not uploaded — the path leaves the run directory',
    ]);
  });
});
