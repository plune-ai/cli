import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createClient, nodeTransport } from '../client.js';

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

/**
 * cli#58. With no `fetchImpl` the client speaks `node:http(s)`, whose parser is native. `fetch` goes
 * through undici, whose first request compiles a WASM parser that V8 re-optimizes on a background
 * thread; on Windows a `process.exit` during that — Playwright calls it as a run ends — trips a libuv
 * assertion, and a green run exits 0xC0000409.
 */
describe('client — its own transport (cli#58)', () => {
  let server: Server;
  let url = '';
  let seen: { method?: string; path?: string; headers: IncomingHttpHeaders; body: string }[] = [];
  let answers: ((res: ServerResponse) => void)[] = [];

  beforeEach(async () => {
    seen = [];
    answers = [];
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += String(chunk)));
      req.on('end', () => {
        seen.push({ method: req.method, path: req.url, headers: req.headers, body });
        answers.shift()?.(res);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    server.closeAllConnections();
    server.close();
  });

  const reply =
    (status: number, body: unknown = undefined, headers: Record<string, string> = {}) =>
    (res: ServerResponse): void => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(body === undefined ? undefined : JSON.stringify(body));
    };

  it('sends the request over node:http, never through fetch', async () => {
    const viaFetch = vi.spyOn(globalThis, 'fetch');
    answers.push(reply(201, { run: { id: 'r-1' } }));
    const out = await createClient({ apiUrl: url, token: TOKEN }).post('/v1/runs', { schemaVersion: 2 });

    expect(out).toEqual({ ok: true, status: 201, body: { run: { id: 'r-1' } } });
    expect(seen[0]).toMatchObject({ method: 'POST', path: '/v1/runs', body: '{"schemaVersion":2}' });
    expect(seen[0]?.headers).toMatchObject({
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
      'content-length': '19',
    });
    expect(viaFetch).not.toHaveBeenCalled();
  });

  it('reads a refusal, its Retry-After and an empty 204 as fetch did', async () => {
    const waited: number[] = [];
    const client = createClient({ apiUrl: url, token: TOKEN, wait: async (ms) => void waited.push(ms) });
    answers.push(reply(503, { error: 'busy' }, { 'retry-after': '2' }), reply(204));
    expect(await client.del('/v1/runs/r-1')).toEqual({ ok: true, status: 204, body: undefined });
    expect(waited).toEqual([2000]);
    expect(seen.map((s) => s.method)).toEqual(['DELETE', 'DELETE']);

    answers.push(reply(401, { error: `bad token ${TOKEN}` }));
    expect(await client.post('/v1/runs', {})).toEqual({ ok: false, kind: 'auth', status: 401, detail: 'bad token ***' });
  });

  it('calls a platform nobody answers for unavailable', async () => {
    server.close();
    const out = await createClient({ apiUrl: url, token: TOKEN, wait: async () => {} }).post('/v1/runs', {});
    expect(out).toMatchObject({ ok: false, kind: 'unavailable', status: null });
  });

  it('gives up on a platform that stops answering, rather than holding the run open', async () => {
    // No answer queued: the server reads the request and says nothing.
    await expect(nodeTransport(`${url}/v1/runs`, { method: 'POST', headers: {}, body: '{}' }, 50)).rejects.toThrow(/answer/);
  });
});
