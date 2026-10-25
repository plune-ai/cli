import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ParsedRunResult } from '../../../types/run-result-schema.js';
import {
  handleSync,
  NotLoggedInError,
  reportSyncFailure,
  SyncFileError,
  SyncHttpError,
  SyncNetworkError,
  TokenRejectedError,
} from '../sync.js';

const TOKEN = 'plune_secret_do_not_leak';

function runResult(over: Partial<ParsedRunResult> = {}): ParsedRunResult {
  return {
    schemaVersion: 1,
    plune_version: '0.1.0',
    started_at: '2026-07-06T10:00:00.000Z',
    finished_at: '2026-07-06T10:00:01.000Z',
    config_hash: 'cfg',
    summary: { total: 2, passed: 2, failed: 0, errored: 0, cost_usd: 0.01, duration_ms: 535 },
    evals: [],
    ...over,
  };
}

/** A fetch stub that records each call and returns a canned JSON Response with the given status. */
function stubFetch(
  status: number,
  body: unknown,
): { fn: typeof fetch; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    // The default server is an older one: no jobs route. Job tests use `jobsFetch`.
    if (String(url).includes('/v1/jobs')) return new Response('{}', { status: 404 });
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { fn, calls };
}

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'plune-sync-'));
});

function writeRun(dir: string, result: ParsedRunResult = runResult()): void {
  mkdirSync(join(dir, '.plune'), { recursive: true });
  writeFileSync(join(dir, '.plune', 'last-run.json'), JSON.stringify(result));
}

describe('handleSync (#49)', () => {
  it('uploads the latest run and returns the id + read-back URL', async () => {
    writeRun(tmp);
    const { fn, calls } = stubFetch(201, { id: 'run_123' });
    const res = await handleSync({
      cwd: tmp,
      apiUrl: 'https://api.test',
      loadToken: () => TOKEN,
      fetchImpl: fn,
    });
    expect(res).toEqual({ id: 'run_123', url: 'https://api.test/v1/runs/run_123' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.test/v1/runs');
    expect(calls[0]?.init.method).toBe('POST');
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['authorization']).toBe(`Bearer ${TOKEN}`);
    expect(headers['content-type']).toBe('application/json');
    const sent = JSON.parse(String(calls[0]?.init.body)) as ParsedRunResult;
    expect(sent.schemaVersion).toBe(1); // posts the run byte-for-byte, no reshaping
  });

  it('rejects with NotLoggedInError when no token is stored (no request made)', async () => {
    writeRun(tmp);
    const { fn, calls } = stubFetch(201, { id: 'x' });
    await expect(
      handleSync({ cwd: tmp, loadToken: () => null, fetchImpl: fn }),
    ).rejects.toBeInstanceOf(NotLoggedInError);
    expect(calls).toHaveLength(0);
  });

  it('rejects with SyncFileError when there is no run to sync', async () => {
    const { fn } = stubFetch(201, { id: 'x' });
    await expect(
      handleSync({ cwd: tmp, loadToken: () => TOKEN, fetchImpl: fn }),
    ).rejects.toBeInstanceOf(SyncFileError);
  });

  it('rejects with SyncFileError when the run file fails RunResult validation', async () => {
    mkdirSync(join(tmp, '.plune'), { recursive: true });
    writeFileSync(join(tmp, '.plune', 'last-run.json'), JSON.stringify({ nope: true }));
    const { fn } = stubFetch(201, { id: 'x' });
    await expect(
      handleSync({ cwd: tmp, loadToken: () => TOKEN, fetchImpl: fn }),
    ).rejects.toBeInstanceOf(SyncFileError);
  });

  it('maps a 401 to TokenRejectedError', async () => {
    writeRun(tmp);
    const { fn } = stubFetch(401, { error: 'unauthorized' });
    await expect(
      handleSync({ cwd: tmp, apiUrl: 'https://api.test', loadToken: () => TOKEN, fetchImpl: fn }),
    ).rejects.toBeInstanceOf(TokenRejectedError);
  });

  it('drains the response body on a non-2xx (so no half-open socket blocks process exit)', async () => {
    writeRun(tmp);
    let captured: Response | undefined;
    const fn = (async () => {
      captured = new Response(JSON.stringify({ error: 'nope' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
      return captured;
    }) as typeof fetch;
    await handleSync({
      cwd: tmp,
      apiUrl: 'https://api.test',
      loadToken: () => TOKEN,
      fetchImpl: fn,
    }).catch(() => undefined);
    expect(captured?.bodyUsed).toBe(true); // body was consumed before throwing
  });

  it('maps a non-401 error status to SyncHttpError carrying the server detail', async () => {
    writeRun(tmp);
    const { fn } = stubFetch(400, { error: 'validation failed — summary: required' });
    const err = await handleSync({
      cwd: tmp,
      apiUrl: 'https://api.test',
      loadToken: () => TOKEN,
      fetchImpl: fn,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SyncHttpError);
    expect((err as SyncHttpError).status).toBe(400);
    expect((err as SyncHttpError).message).toContain('validation failed');
  });

  it('maps a fetch rejection to SyncNetworkError naming the host, never the token', async () => {
    writeRun(tmp);
    const fn = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;
    const err = await handleSync({
      cwd: tmp,
      apiUrl: 'https://api.test',
      loadToken: () => TOKEN,
      fetchImpl: fn,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SyncNetworkError);
    expect((err as Error).message).toContain('https://api.test');
    expect((err as Error).message).not.toContain(TOKEN);
  });

  it('honours --file, syncing an explicit run JSON', async () => {
    writeFileSync(
      join(tmp, 'my-run.json'),
      JSON.stringify(runResult({ config_hash: 'from-file' })),
    );
    const { fn, calls } = stubFetch(201, { id: 'run_file' });
    const res = await handleSync({
      cwd: tmp,
      file: 'my-run.json',
      apiUrl: 'https://api.test',
      loadToken: () => TOKEN,
      fetchImpl: fn,
    });
    expect(res.id).toBe('run_file');
    const sent = JSON.parse(String(calls[0]?.init.body)) as ParsedRunResult;
    expect(sent.config_hash).toBe('from-file');
  });

  it('rejects with SyncFileError when --file does not exist', async () => {
    const { fn } = stubFetch(201, { id: 'x' });
    const err = await handleSync({
      cwd: tmp,
      file: 'missing.json',
      loadToken: () => TOKEN,
      fetchImpl: fn,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SyncFileError);
    expect((err as Error).message).toContain('not found');
  });

  it('normalises a trailing slash in the API URL', async () => {
    writeRun(tmp);
    const { fn, calls } = stubFetch(201, { id: 'run_1' });
    await handleSync({
      cwd: tmp,
      apiUrl: 'https://api.test/',
      loadToken: () => TOKEN,
      fetchImpl: fn,
    });
    expect(calls[0]?.url).toBe('https://api.test/v1/runs');
  });

  it('falls back to PLUNE_API_URL when no apiUrl is passed', async () => {
    writeRun(tmp);
    const saved = process.env['PLUNE_API_URL'];
    process.env['PLUNE_API_URL'] = 'https://env.test';
    try {
      const { fn, calls } = stubFetch(201, { id: 'e' });
      await handleSync({ cwd: tmp, loadToken: () => TOKEN, fetchImpl: fn });
      expect(calls[0]?.url).toBe('https://env.test/v1/runs');
    } finally {
      if (saved === undefined) delete process.env['PLUNE_API_URL'];
      else process.env['PLUNE_API_URL'] = saved;
    }
  });
});

/**
 * `plune sync --fail-on-failures` (plune#1247): after the upload, one `GET /v1/runs/:id/summary` — `counts`
 * by the status each result is counted under (a muted failure under `muted`), `notRun`, and the run's
 * `statusEvent` — and the exit code is the gate's.
 */
describe('handleSync --fail-on-failures', () => {
  /** The upload answers 201; the summary answers what it is given — or throws, for a platform gone after the upload. */
  function platform(summary: { status: number; body: unknown } | 'network') {
    const calls: { url: string; method: string }[] = [];
    const fn = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes('/v1/jobs')) return new Response('{}', { status: 404 }); // older server
      calls.push({ url: String(url), method: init?.method ?? 'GET' });
      if (init?.method === 'POST') return new Response(JSON.stringify({ id: 'run_7' }), { status: 201 });
      if (summary === 'network') throw new TypeError('fetch failed');
      return new Response(JSON.stringify(summary.body), { status: summary.status });
    }) as typeof fetch;
    return { fn, calls };
  }
  const sync = (fn: typeof fetch, failOnFailures = true) => {
    writeRun(tmp);
    return handleSync({
      cwd: tmp,
      apiUrl: 'https://api.test',
      loadToken: () => TOKEN,
      fetchImpl: fn,
      ...(failOnFailures ? { failOnFailures: true } : {}),
    });
  };
  const summary = (counts: Record<string, number>, notRun: string[] = [], statusEvent = 'finished') => ({
    status: 200,
    body: { counts, unmapped: 0, discovered: 0, withDefect: 0, run: { kind: 'eval', statusEvent }, notRun },
  });

  it('reads the verdict with one GET of the summary, after the upload', async () => {
    const { fn, calls } = platform(summary({ passed: 2, failed: 0, broken: 0, muted: 1 }));
    const res = await sync(fn);
    expect(calls).toEqual([
      { url: 'https://api.test/v1/runs', method: 'POST' },
      { url: 'https://api.test/v1/runs/run_7/summary', method: 'GET' },
    ]);
    expect(res.gate).toEqual({ code: 0, line: 'plune: gate passed — 0 failed · 0 broken · 0 not run · 1 muted' });
  });

  it.each([
    ['a failed eval', summary({ passed: 1, failed: 1 })],
    ['a broken eval', summary({ passed: 1, broken: 1 })],
    ['an expected case that never reported', summary({ passed: 2 }, ['tc-1'])],
    ['a terminated run', summary({ passed: 2 }, [], 'terminated')],
    ['a summary the platform refused', { status: 500, body: { error: 'boom' } }],
  ])('exits 1 on %s', async (_name, answer) => {
    const { fn } = platform(answer);
    expect((await sync(fn)).gate?.code).toBe(1);
  });

  it('exits 1 when the platform is gone after the upload: no verdict, no pass', async () => {
    const { fn } = platform('network');
    const res = await sync(fn);
    expect(res.id).toBe('run_7');
    expect(res.gate?.code).toBe(1);
  });

  it('without the flag, makes the one upload and nothing more', async () => {
    const { fn, calls } = platform(summary({ failed: 3 }));
    expect(await sync(fn, false)).toEqual({ id: 'run_7', url: 'https://api.test/v1/runs/run_7' });
    expect(calls).toHaveLength(1);
  });
});

describe('reportSyncFailure (#49)', () => {
  it('maps auth/file errors to exit 2, network/http to exit 1, and passes unknown through as null', () => {
    const out: string[] = [];
    const w = (s: string): void => void out.push(s);
    expect(reportSyncFailure(new NotLoggedInError(), w)).toBe(2);
    expect(reportSyncFailure(new TokenRejectedError(), w)).toBe(2);
    expect(reportSyncFailure(new SyncFileError('x'), w)).toBe(2);
    expect(reportSyncFailure(new SyncNetworkError('https://a'), w)).toBe(1);
    expect(reportSyncFailure(new SyncHttpError(500, ''), w)).toBe(1);
    expect(reportSyncFailure(new Error('unknown'), w)).toBeNull();
    expect(out).toHaveLength(5); // the unknown error printed nothing
  });
});

describe('handleSync Idempotency-Key (#104)', () => {
  const sha256Hex = (s: string): string => createHash('sha256').update(s).digest('hex');
  const keyOf = (c: { init: RequestInit } | undefined): string =>
    (c?.init.headers as Record<string, string>)['idempotency-key'] ?? '';
  const upload = (dir: string, fn: typeof fetch): ReturnType<typeof handleSync> =>
    handleSync({ cwd: dir, apiUrl: 'https://api.test', loadToken: () => TOKEN, fetchImpl: fn });

  it('sends the SHA-256 of the exact body; same body, same key; other body, other key', async () => {
    writeRun(tmp);
    const a = stubFetch(201, { id: 'r1' });
    await upload(tmp, a.fn);
    await upload(tmp, a.fn);
    expect(keyOf(a.calls[0])).toMatch(/^[0-9a-f]{64}$/);
    expect(keyOf(a.calls[0])).toBe(sha256Hex(String(a.calls[0]?.init.body)));
    expect(keyOf(a.calls[1])).toBe(keyOf(a.calls[0]));

    writeRun(tmp, runResult({ config_hash: 'other' }));
    const b = stubFetch(201, { id: 'r2' });
    await upload(tmp, b.fn);
    expect(keyOf(b.calls[0])).not.toBe(keyOf(a.calls[0]));
  });

  it('a 201 then a 200 replay are both success with the same result', async () => {
    writeRun(tmp);
    const first = await upload(tmp, stubFetch(201, { id: 'r1', linked: 2, unlinked: 0 }).fn);
    const again = await upload(tmp, stubFetch(200, { id: 'r1', linked: 2, unlinked: 0 }).fn);
    expect(again).toEqual(first);
  });

  it.each([422, 409, 400])('reports %i as an error and does not retry', async (status) => {
    writeRun(tmp);
    const { fn, calls } = stubFetch(status, { error: 'idempotency conflict' });
    const err = await upload(tmp, fn).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SyncHttpError);
    expect((err as SyncHttpError).status).toBe(status);
    expect(calls).toHaveLength(1);
  });

  it('a retry after a lost answer (network error, then 5xx) resends the same key', async () => {
    writeRun(tmp);
    const keys: string[] = [];
    let n = 0;
    const flaky = (async (u: string | URL | Request, init?: RequestInit) => {
      if (String(u).includes('/v1/jobs')) return new Response('{}', { status: 404 });
      keys.push((init?.headers as Record<string, string>)['idempotency-key'] ?? '');
      n += 1;
      if (n === 1) throw new TypeError('fetch failed');
      return new Response(JSON.stringify({ id: 'r1' }), { status: n === 2 ? 503 : 200 });
    }) as typeof fetch;
    await upload(tmp, flaky).catch(() => undefined);
    await upload(tmp, flaky).catch(() => undefined);
    await upload(tmp, flaky);
    expect(new Set(keys).size).toBe(1);
    expect(keys).toHaveLength(3);
  });
});

describe('CLI · sync · job reporting, held to the platform contract (plune#1769, cli#139)', () => {
  type Call = { url: string; method: string; body: unknown; status?: number };

  // The platform's job contract as plune-ai/plune has it on master (ae9f9ec1): `src/contracts/job.ts` and
  // `src/contracts/job-states.ts`, copied because the CLI does not depend on the platform. Before cli#139 the fake
  // server here took whatever the CLI sent, so a body the real one answers 400 passed.
  const count = z.number().int().nonnegative().max(2_147_483_647);
  const cursor = z.string().min(1).max(2000).nullable();
  const attempt = z.number().int().positive().max(2_147_483_647).optional();
  const JOB_STATES = ['in_progress', 'action_needed', 'paused', 'blocked', 'completed', 'failed', 'cancelled'] as const;
  const STOPPED: readonly string[] = ['action_needed', 'paused', 'blocked', 'failed'];
  const jobCreateSchema = z.strictObject({
    kind: z.string().trim().min(1).max(64),
    subjectId: z.string().min(1).max(200).optional(),
    subjectName: z.string().trim().min(1).max(200).optional(),
    progress: z
      .strictObject({ done: count, total: count.min(1) })
      .refine((p) => p.done <= p.total)
      .optional(),
    cursor: cursor.unwrap().optional(),
  });
  const jobProgressReportSchema = z
    .strictObject({ done: count.nullable(), total: count.min(1).nullable(), cursor: cursor.optional(), attempt })
    .refine((p) => (p.done === null) === (p.total === null))
    .refine((p) => p.done === null || p.total === null || p.done <= p.total);
  const jobStateReportSchema = z
    .strictObject({
      state: z.enum(JOB_STATES),
      reason: z.string().trim().min(1).max(2000).optional(),
      cursor: cursor.optional(),
      attempt,
    })
    .refine((b) => b.state === 'cancelled' || STOPPED.includes(b.state) === (b.reason !== undefined));
  /** The producer's routes as `src/server/jobs/v1-routes.ts` mounts them, each with the schema it judges the body by. */
  const ROUTES: Record<string, z.ZodType> = {
    'POST /v1/jobs': jobCreateSchema,
    'PATCH /v1/jobs/:id/progress': jobProgressReportSchema,
    'PATCH /v1/jobs/:id/state': jobStateReportSchema,
  };

  /** The jobs routes as the platform answers them: 400 for a body its schema refuses, 404 for a route it does not have. */
  function platformJobs(call: Call): Response {
    const route = `${call.method} ${new URL(call.url).pathname.replace(/^\/v1\/jobs\/[^/]+/, '/v1/jobs/:id')}`;
    const schema = ROUTES[route];
    if (schema === undefined) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
    const parsed = schema.safeParse(call.body);
    if (!parsed.success) {
      return new Response(JSON.stringify({ error: `validation failed — ${parsed.error.message}` }), { status: 400 });
    }
    return new Response(JSON.stringify({ id: 'job_1' }), { status: route === 'POST /v1/jobs' ? 201 : 200 });
  }

  /** Routes /v1/jobs to `jobs`, everything else to a run upload answering `run`. Each job call keeps the status it got. */
  function jobsFetch(jobs: (c: Call) => Response | Promise<Response>, run = { status: 201, body: { id: 'run_1' } }) {
    const calls: Call[] = [];
    const fn = (async (url: string | URL | Request, init?: RequestInit) => {
      const call: Call = {
        url: String(url),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      };
      calls.push(call);
      if (!call.url.includes('/v1/jobs')) return new Response(JSON.stringify(run.body), { status: run.status });
      const res = await jobs(call);
      call.status = res.status;
      return res;
    }) as typeof fetch;
    return { fn, calls };
  }
  const deps = (fn: typeof fetch) => ({ cwd: tmp, apiUrl: 'https://api.test', loadToken: () => TOKEN, fetchImpl: fn });
  const jobCalls = (calls: Call[]) => calls.filter((c) => c.url.includes('/v1/jobs'));
  const routes = (calls: Call[]) => jobCalls(calls).map((c) => `${c.status} ${c.method} ${c.url}`);

  it('opens a job of the kind the queue panel names, reports the upload and completes it, every call taken', async () => {
    writeRun(tmp); // summary.total: 2
    const { fn, calls } = jobsFetch(platformJobs);
    const res = await handleSync(deps(fn));
    expect(routes(calls)).toEqual([
      '201 POST https://api.test/v1/jobs',
      '200 PATCH https://api.test/v1/jobs/job_1/progress',
      '200 PATCH https://api.test/v1/jobs/job_1/state',
    ]);
    const [open, progress, state] = jobCalls(calls);
    // `sync` is a kind the panel has words for (`app/src/i18n/en.json`: `queue.kind.sync` «Sync», `queue.verb.sync` «Synced»).
    expect(open?.body).toEqual({ kind: 'sync', subjectName: basename(tmp), progress: { done: 0, total: 2 } });
    expect(progress?.body).toEqual({ done: 2, total: 2, cursor: 'run_1' });
    expect(state?.body).toEqual({ state: 'completed' });
    expect(res).toEqual({ id: 'run_1', url: 'https://api.test/v1/runs/run_1' });
  });

  it('opens a run with no rows without a size and reports it as still counting, never 0 / 0', async () => {
    writeRun(tmp, runResult({ summary: { total: 0, passed: 0, failed: 0, errored: 0, cost_usd: 0, duration_ms: 0 } }));
    const { fn, calls } = jobsFetch(platformJobs);
    const res = await handleSync(deps(fn));
    expect(jobCalls(calls).map((c) => c.status)).toEqual([201, 200, 200]);
    const [open, progress] = jobCalls(calls);
    expect(open?.body).toEqual({ kind: 'sync', subjectName: basename(tmp) });
    expect(progress?.body).toEqual({ done: null, total: null, cursor: 'run_1' });
    expect(res.jobProblem).toBeUndefined();
  });

  it('fails the job with the error text, cut to what the platform keeps, when the upload fails, and still throws', async () => {
    writeRun(tmp);
    const { fn, calls } = jobsFetch(platformJobs, { status: 500, body: { error: 'boom '.repeat(1000) } });
    await expect(handleSync(deps(fn))).rejects.toBeInstanceOf(SyncHttpError);
    expect(routes(calls)).toEqual(['201 POST https://api.test/v1/jobs', '200 PATCH https://api.test/v1/jobs/job_1/state']);
    expect(jobCalls(calls)[1]?.body).toEqual({ state: 'failed', reason: expect.stringContaining('HTTP 500') });
    expect(JSON.stringify(calls)).not.toContain(TOKEN);
  });

  it.each([404, 405])('changes nothing against a server that answers %i for the jobs route', async (status) => {
    writeRun(tmp);
    const { fn, calls } = jobsFetch(() => new Response('{}', { status }));
    const res = await handleSync(deps(fn));
    expect(res).toEqual({ id: 'run_1', url: 'https://api.test/v1/runs/run_1' });
    expect(jobCalls(calls)).toHaveLength(1); // the open, nothing after it
  });

  it('does not fail the sync when job reporting errors, and says what went wrong first', async () => {
    writeRun(tmp);
    let n = 0;
    const { fn } = jobsFetch((call) => {
      n += 1;
      if (n === 1) return platformJobs(call);
      throw new TypeError(n === 2 ? 'network down' : 'socket hang up');
    });
    const res = await handleSync(deps(fn));
    expect(res.id).toBe('run_1');
    expect(res.jobProblem).toBe('network down');
  });

  it('does not fail the sync when opening the job answers 500, and says so', async () => {
    writeRun(tmp);
    const { fn } = jobsFetch(() => new Response('nope', { status: 500 }));
    await expect(handleSync(deps(fn))).resolves.toMatchObject({ id: 'run_1', jobProblem: 'HTTP 500' });
  });

  it('names the refusal when the platform refuses a job report', async () => {
    writeRun(tmp);
    const { fn } = jobsFetch((call) =>
      call.method === 'POST' ? platformJobs(call) : new Response(JSON.stringify({ error: 'job_finished' }), { status: 409 }),
    );
    await expect(handleSync(deps(fn))).resolves.toMatchObject({ id: 'run_1', jobProblem: 'HTTP 409 — job_finished' });
  });

  it('says so when the job is gone after the open: a 404 is "older server" only for the open itself', async () => {
    writeRun(tmp);
    const { fn } = jobsFetch((call) => {
      if (call.method === 'POST') return platformJobs(call);
      return call.url.endsWith('/progress')
        ? new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
        : new Response(JSON.stringify({ error: 'job_finished' }), { status: 409 });
    });
    await expect(handleSync(deps(fn))).resolves.toMatchObject({ id: 'run_1', jobProblem: 'HTTP 404 — not found' });
  });
});
