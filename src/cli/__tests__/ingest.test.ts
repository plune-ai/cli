import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  formatIngestResult,
  handleIngest,
  reportIngestFailure,
  IngestHttpError,
  IngestNetworkError,
  IngestNotLoggedInError,
  IngestTokenRejectedError,
} from '../commands/ingest.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): string => path.join(here, 'fixtures', 'cairn', name);

const okFetch = (body: unknown, status = 201): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;

const deps = (over: Partial<Parameters<typeof handleIngest>[0]> = {}) => ({
  dir: fixture('design'),
  apiUrl: 'https://api.test',
  loadToken: () => 'plune_test_token',
  fetchImpl: okFetch({ runId: 'run-1', linked: 0, proposed: 29, skipped: 0 }),
  ...over,
});

describe('handleIngest', () => {
  it('uploads the run and returns the counters the server reported', async () => {
    expect(await handleIngest(deps())).toEqual({ runId: 'run-1', linked: 0, proposed: 29, skipped: 0 });
  });

  it('posts to the ingest endpoint, with the token as a bearer credential', async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    await handleIngest(
      deps({
        fetchImpl: (async (url: string, init: RequestInit) => {
          seen = { url, init };
          return new Response('{}', { status: 201 });
        }) as unknown as typeof fetch,
      }),
    );
    expect(seen?.url).toBe('https://api.test/v1/ingest/cairn');
    expect((seen?.init.headers as Record<string, string>).authorization).toBe('Bearer plune_test_token');
  });

  it('sends the read payload, not the raw artifact', async () => {
    let body: Record<string, unknown> = {};
    await handleIngest(
      deps({
        fetchImpl: (async (_u: string, init: RequestInit) => {
          body = JSON.parse(init.body as string) as Record<string, unknown>;
          return new Response('{}', { status: 201 });
        }) as unknown as typeof fetch,
      }),
    );
    expect(body).toMatchObject({ schemaVersion: 1, run: { mode: 'design' } });
    // Cairn's own detail stays on Cairn's side of the boundary.
    expect(body).not.toHaveProperty('pageSemantics');
    expect(body).not.toHaveProperty('scores');
  });

  // Auth is checked before the directory is read: telling a logged-out user to log in should not
  // require parsing a run first.
  it('refuses without a token, before reading anything', async () => {
    await expect(handleIngest(deps({ loadToken: () => null, dir: fixture('nope') }))).rejects.toThrow(
      IngestNotLoggedInError,
    );
  });

  it('turns a rejected token into its own error rather than a generic HTTP one', async () => {
    await expect(handleIngest(deps({ fetchImpl: okFetch({ error: 'nope' }, 401) }))).rejects.toThrow(
      IngestTokenRejectedError,
    );
  });

  it('reports an unreachable API without leaking the transport error', async () => {
    const err = await handleIngest(
      deps({ fetchImpl: (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IngestNetworkError);
    expect((err as Error).message).not.toMatch(/ECONNREFUSED/);
  });

  // A refusal must upload nothing at all — that is the difference between "we did not record this"
  // and "we recorded half of it".
  it('uploads nothing when the run cannot be read safely', async () => {
    let called = false;
    await expect(
      handleIngest(
        deps({
          dir: fixture('legacy'),
          fetchImpl: (async () => { called = true; return new Response('{}'); }) as unknown as typeof fetch,
        }),
      ),
    ).rejects.toThrow(/0\.7\.0/);
    expect(called).toBe(false);
  });
});

describe('reportIngestFailure — what the user can fix vs what they can retry', () => {
  const say = (): { out: string[]; write: (s: string) => void } => {
    const out: string[] = [];
    return { out, write: (s) => out.push(s) };
  };

  it.each([
    ['no token', new IngestNotLoggedInError(), 2],
    ['rejected token', new IngestTokenRejectedError(), 2],
    ['unreachable api', new IngestNetworkError('https://api.test'), 1],
    ['server error', new IngestHttpError(500, 'boom'), 1],
  ])('%s exits %i with a message', (_label, err, code) => {
    const { out, write } = say();
    expect(reportIngestFailure(err, write)).toBe(code);
    expect(out.join('')).not.toBe('');
  });

  it('never prints the token, whatever went wrong', () => {
    const { out, write } = say();
    reportIngestFailure(new IngestTokenRejectedError(), write);
    expect(out.join('')).not.toMatch(/plune_/);
  });

  it('leaves an error it does not recognise to the caller', () => {
    expect(reportIngestFailure(new Error('something else'), () => {})).toBeNull();
  });
});

describe('formatIngestResult', () => {
  // The counters ARE the report (Plune FR-9). Each must be visible, including a zero — "0 proposed"
  // is the answer to "did it queue anything", and hiding it would leave the reader guessing.
  it('shows all three counters even when they are zero', () => {
    const out = formatIngestResult({ runId: 'r1', linked: 0, proposed: 0, skipped: 0 });
    expect(out).toMatch(/0 result\(s\) attached/);
    expect(out).toMatch(/0 case\(s\) proposed/);
    expect(out).toMatch(/0 skipped/);
  });

  it('tells the reader where proposed cases went', () => {
    expect(formatIngestResult({ runId: 'r1', linked: 1, proposed: 2, skipped: 3 })).toMatch(/review/i);
  });
});
