import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
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
