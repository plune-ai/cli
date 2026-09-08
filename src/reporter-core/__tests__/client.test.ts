import { describe, it, expect, vi } from 'vitest';
import { createClient } from '../client.js';

const TOKEN = 'plune_tok_do_not_leak_me';

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/** A client whose transport, waits and attempt budget are all visible to the test. */
function harness(responses: (Response | Error)[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const waited: number[] = [];
  let i = 0;
  const client = createClient({
    apiUrl: 'https://api.test',
    token: TOKEN,
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      const next = responses[Math.min(i++, responses.length - 1)];
      if (next instanceof Error) throw next;
      return next as Response;
    }) as unknown as typeof fetch,
    wait: async (ms: number) => {
      waited.push(ms);
    },
  });
  return { client, calls, waited };
}

describe('client — what it sends', () => {
  it('carries the bearer token and a JSON content type', async () => {
    const { client, calls } = harness([json({ run: { id: 'r-1' }, joined: false }, 201)]);
    await client.post('/v1/runs', { schemaVersion: 2 });

    expect(calls[0]?.url).toBe('https://api.test/v1/runs');
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['authorization']).toBe(`Bearer ${TOKEN}`);
    expect(headers['content-type']).toBe('application/json');
  });

  it('returns the parsed body on success', async () => {
    const { client } = harness([json({ run: { id: 'r-7' }, joined: true }, 200)]);
    const out = await client.post<{ run: { id: string }; joined: boolean }>('/v1/runs', {});

    expect(out.ok).toBe(true);
    expect(out.ok && out.status).toBe(200);
    expect(out.ok && out.body.run.id).toBe('r-7');
  });
});

describe('client — what it retries (AC-05)', () => {
  it('gives a dropped connection three attempts, then gives up as unavailable', async () => {
    const { client, calls } = harness([new TypeError('fetch failed')]);
    const out = await client.post('/v1/runs', {});

    expect(calls).toHaveLength(3);
    expect(out.ok).toBe(false);
    expect(!out.ok && out.kind).toBe('unavailable');
  });

  it('retries a 5xx the same way', async () => {
    const { client, calls } = harness([json({ error: 'boom' }, 503)]);
    const out = await client.post('/v1/runs', {});

    expect(calls).toHaveLength(3);
    expect(!out.ok && out.kind).toBe('unavailable');
  });

  it('stops retrying the moment it succeeds', async () => {
    const { client, calls } = harness([new TypeError('fetch failed'), json({ ok: 1 }, 200)]);
    const out = await client.post('/v1/runs', {});

    expect(calls).toHaveLength(2);
    expect(out.ok).toBe(true);
  });

  // The platform sends Retry-After with every 429 (its rate-limit middleware sets it). Ignoring it
  // in favour of our own backoff is how a client walks straight back into the same wall.
  it('waits exactly as long as a 429 asked it to', async () => {
    const { client, waited } = harness([json({ error: 'slow down' }, 429, { 'retry-after': '7' })]);
    await client.post('/v1/runs', {});

    expect(waited).toEqual([7000, 7000]);
  });

  it('falls back to its own backoff when a 429 names no delay', async () => {
    const { client, waited } = harness([json({ error: 'slow down' }, 429)]);
    await client.post('/v1/runs', {});

    expect(waited).toHaveLength(2);
    expect(waited[0]).toBeGreaterThan(0);
    expect(waited[1]).toBeGreaterThan(waited[0] as number);
  });
});

describe('client — what it refuses to retry', () => {
  it('does not retry a rejected token (AC-06)', async () => {
    const { client, calls } = harness([json({ error: 'unauthorized' }, 401)]);
    const out = await client.post('/v1/runs', {});

    expect(calls).toHaveLength(1);
    expect(!out.ok && out.kind).toBe('auth');
  });

  it('does not retry a conflict, and carries what the server said (AC-07)', async () => {
    const { client, calls } = harness([json({ error: "run 'r-1' is closed to new results" }, 409)]);
    const out = await client.post('/v1/runs/r-1/results', {});

    expect(calls).toHaveLength(1);
    expect(!out.ok && out.kind).toBe('conflict');
    expect(!out.ok && out.detail).toBe("run 'r-1' is closed to new results");
  });

  it('does not retry a rejected body, and keeps the named reason', async () => {
    const detail = 'validation failed — results.0.resultKey: Required';
    const { client, calls } = harness([json({ error: detail }, 400)]);
    const out = await client.post('/v1/runs/r-1/results', {});

    expect(calls).toHaveLength(1);
    expect(!out.ok && out.kind).toBe('invalid');
    expect(!out.ok && out.detail).toBe(detail);
  });
});

describe('client — hygiene', () => {
  // Learned the hard way in `sync.ts`: an unread response body leaves undici's socket half-open,
  // which blocks a clean process exit and trips a libuv teardown assertion on Windows.
  it('drains the body of a failure it is not going to read', async () => {
    const res = json({ error: 'nope' }, 400);
    const spy = vi.spyOn(res, 'json');
    const { client } = harness([res]);
    await client.post('/v1/runs', {});

    expect(spy).toHaveBeenCalled();
  });

  it('never puts the token in anything it returns', async () => {
    const { client } = harness([json({ error: `bad token ${TOKEN}` }, 401)]);
    const out = await client.post('/v1/runs', {});

    expect(JSON.stringify(out)).not.toContain(TOKEN);
  });
});
