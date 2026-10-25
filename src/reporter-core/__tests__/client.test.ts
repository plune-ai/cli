import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from 'node:http';
import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    random: () => 0,
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

  // 429 without Retry-After means quota exceeded, not rate limit — retrying with short delays is useless.
  // The client classifies it as 'invalid' and gives up immediately. See cli#79.
  it('treats a 429 without Retry-After as quota exceeded and does not retry', async () => {
    const { client, calls } = harness([json({ error: 'slow down' }, 429)]);
    const out = await client.post('/v1/runs', {});

    expect(calls).toHaveLength(1);
    expect(out.ok).toBe(false);
    expect(!out.ok && out.kind).toBe('invalid');
    expect(!out.ok && out.detail).toMatch(/quota exceeded/);
  });

  // The platform's 429 for a quota carries a `quota` object, and the run quota's also a Retry-After
  // (plune-ai/plune#1599). The body decides: waiting till the reset frees nothing. See cli#111.
  const QUOTA = { kind: 'runs', limit: 50, used: 50, remaining: 0, resetsAt: '2026-10-18T00:00:00.000Z' };

  it.each([
    ['with Retry-After', { 'retry-after': '3600' }],
    ['without Retry-After', {}],
  ])('treats a 429 with a quota object %s as a quota: one request, the limit named', async (_n, headers) => {
    const { client, calls, waited } = harness([json({ error: 'daily run quota reached', quota: QUOTA }, 429, headers)]);
    const out = await client.post('/v1/runs', {});

    expect(calls).toHaveLength(1);
    expect(waited).toEqual([]);
    expect(!out.ok && out.kind).toBe('invalid');
    expect(!out.ok && out.detail).toBe(
      'quota exceeded (runs: 50 of 50 used, resets 2026-10-18T00:00:00.000Z) — daily run quota reached',
    );
  });

  it('names a quota that gave only its kind', async () => {
    const { client } = harness([json({ error: 'full', quota: { kind: 'cases' } }, 429, { 'retry-after': '5' })]);
    const out = await client.post('/v1/runs', {});

    expect(!out.ok && out.detail).toBe('quota exceeded (cases) — full');
  });

  it('still waits and retries a 429 with Retry-After and no quota object', async () => {
    const { client, calls, waited } = harness([json({ error: 'slow down', quota: 'n/a' }, 429, { 'retry-after': '2' })]);
    const out = await client.post('/v1/runs', {});

    expect(calls).toHaveLength(3);
    expect(waited).toEqual([2000, 2000]);
    expect(!out.ok && out.kind).toBe('unavailable');
  });

  it('does not crash on a 429 whose body is not JSON', async () => {
    const html = () => new Response('<html>429</html>', { status: 429 });
    const none = harness([html()]);
    const out = await none.client.post('/v1/runs', {});
    expect(none.calls).toHaveLength(1);
    expect(!out.ok && out.detail).toBe('quota exceeded (no Retry-After)');

    const slow = harness([new Response('<html>429</html>', { status: 429, headers: { 'retry-after': '1' } })]);
    const throttled = await slow.client.post('/v1/runs', {});
    expect(slow.calls).toHaveLength(3);
    expect(!throttled.ok && throttled.kind).toBe('unavailable');
  });

  it('scrubs the token out of a quota kind', async () => {
    const { client } = harness([json({ quota: { kind: `k ${TOKEN}` } }, 429)]);
    const out = await client.post('/v1/runs', {});

    expect(!out.ok && out.detail).not.toContain(TOKEN);
  });

  // The quota branch rewrites `detail` after the scrubbed one was already built, and it used to
  // append the server's words raw. A proxy or a gateway in front of the platform can echo the
  // bearer token back in an error page, and this string goes straight into a CI log. See cli#79.
  it('scrubs the token out of the quota detail as well', async () => {
    const { client } = harness([json({ error: `quota spent, token ${TOKEN} has no room left` }, 429)]);
    const out = await client.post('/v1/runs', {});

    expect(out.ok).toBe(false);
    expect(!out.ok && out.detail).not.toContain(TOKEN);
    expect(!out.ok && out.detail).toBe('quota exceeded (no Retry-After) — quota spent, token *** has no room left');
  });
});

/** plune-ai/plune#913, platform ADR 0040: a file is its bytes, not a JSON document about them. */
describe('client — a file', () => {
  it('sends the bytes as they are, under their own type, and waits out a 429 as a POST does', async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const { client, calls, waited } = harness([
      json({ error: 'slow down' }, 429, { 'retry-after': '2' }),
      json({ id: 'f-1', name: 'a.png', contentType: 'image/png', size: 4 }, 201),
    ]);
    const out = await client.upload('/v1/results/res-1/files?name=a.png', bytes, 'image/png');

    expect(out).toEqual({ ok: true, status: 201, body: { id: 'f-1', name: 'a.png', contentType: 'image/png', size: 4 } });
    expect(waited).toEqual([2000]);
    expect(calls.map((c) => c.url)).toEqual([
      'https://api.test/v1/results/res-1/files?name=a.png',
      'https://api.test/v1/results/res-1/files?name=a.png',
    ]);
    expect(calls[1]?.init.body).toBe(bytes);
    expect(calls[1]?.init.headers).toEqual({ 'content-type': 'image/png', authorization: `Bearer ${TOKEN}` });
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
    const client = createClient({ random: () => 0, apiUrl: url, token: TOKEN, wait: async (ms) => void waited.push(ms) });
    answers.push(reply(503, { error: 'busy' }, { 'retry-after': '2' }), reply(204));
    expect(await client.del('/v1/runs/r-1')).toEqual({ ok: true, status: 204, body: undefined });
    expect(waited).toEqual([2000]);
    expect(seen.map((s) => s.method)).toEqual(['DELETE', 'DELETE']);

    answers.push(reply(401, { error: `bad token ${TOKEN}` }));
    expect(await client.post('/v1/runs', {})).toEqual({ ok: false, kind: 'auth', status: 401, detail: 'bad token ***' });
  });

  it('sends a file’s bytes over node:http with their own type and length', async () => {
    answers.push(reply(201, { id: 'f-1' }));
    const out = await createClient({ apiUrl: url, token: TOKEN }).upload(
      '/v1/results/r-1/files?name=a.png',
      Buffer.from('not really a png'),
      'image/png',
    );

    expect(out).toEqual({ ok: true, status: 201, body: { id: 'f-1' } });
    expect(seen[0]).toMatchObject({ method: 'POST', path: '/v1/results/r-1/files?name=a.png', body: 'not really a png' });
    expect(seen[0]?.headers).toMatchObject({ 'content-type': 'image/png', 'content-length': '16' });
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

describe('put — a file to a short-lived link of the project’s bucket (plune-ai/plune#946)', () => {
  let bucket: Server;
  let base: string;
  let got: { headers: IncomingHttpHeaders; bytes: Buffer } | undefined;
  let answer = 200;
  let dir: string;

  beforeEach(async () => {
    got = undefined;
    answer = 200;
    dir = mkdtempSync(join(tmpdir(), 'plune-put-'));
    bucket = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        got = { headers: req.headers, bytes: Buffer.concat(chunks) };
        res.writeHead(answer).end();
      });
    });
    await new Promise<void>((resolve) => bucket.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(bucket.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await new Promise((resolve) => bucket.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });

  const real = () => createClient({ apiUrl: 'https://api.test', token: TOKEN, wait: async () => undefined });

  it('streams a file from disk with the length written beforehand, the link’s headers and no token', async () => {
    const bytes = Buffer.alloc(3 * 1024 * 1024 + 7, 'z');
    const at = join(dir, 'trace.zip');
    writeFileSync(at, bytes);
    const out = await real().put(`${base}/o?sig=1`, { 'content-type': 'application/zip', 'Content-Length': '1' }, { path: at, size: bytes.length });

    expect(out).toEqual({ ok: true });
    expect(got?.bytes.equals(bytes)).toBe(true);
    // The size of the file, not the link's header (which fetch would refuse) and not chunked.
    expect(got?.headers['content-length']).toBe(String(bytes.length));
    expect(got?.headers['transfer-encoding']).toBeUndefined();
    expect(got?.headers['content-type']).toBe('application/zip');
    expect(got?.headers['authorization']).toBeUndefined();
  });

  it('sends bytes held in memory the same way', async () => {
    const out = await real().put(`${base}/o`, { 'content-type': 'text/plain' }, { body: Buffer.from('hello') });

    expect(out).toEqual({ ok: true });
    expect(got?.bytes.toString()).toBe('hello');
    expect(got?.headers['content-length']).toBe('5');
  });

  it('answers a 403 at once, for the caller to ask for a new link, and a 4xx with its status', async () => {
    answer = 403;
    expect(await real().put(`${base}/o`, {}, { body: Buffer.from('x') })).toEqual({ ok: false, status: 403, code: 'bucket_403' });
  });

  it('reads the 403 the bucket sent while the body was still going out as that 403, not as a broken connection, and lets the file go', async () => {
    await new Promise((resolve) => bucket.close(resolve));
    let link: Socket | undefined;
    const refusing = createServer((req, res) => {
      // The link is dead: say so at once, with the body still arriving and never read. The answer is left
      // open, so the reset below reaches a client still in the middle of it, and the status has to win.
      link = req.socket;
      res.writeHead(403, { connection: 'close' }).flushHeaders();
    });
    // Then the connection is cut under that body, but only once the client holds the status: the channel is
    // published as the client parses the status line and headers (#140). A reset that gets there first takes
    // the unread 403 with it, since the OS drops a socket's unread bytes on a RST (RFC 9112 §9.6), and no
    // client reads what is gone. That race is the transport's limit, not a behaviour to test; `res.end()` here
    // would let Node close the socket at once and run it.
    const cut = (): void => void link?.destroy();
    subscribe('http.client.response.finish', cut);
    await new Promise<void>((resolve) => refusing.listen(0, '127.0.0.1', resolve));
    const at = join(dir, 'trace.zip');
    writeFileSync(at, Buffer.alloc(40 * 1024 * 1024, 'z'));
    const out = await real()
      .put(`http://127.0.0.1:${(refusing.address() as AddressInfo).port}/o`, {}, { path: at, size: 40 * 1024 * 1024 })
      .finally(() => unsubscribe('http.client.response.finish', cut));
    await new Promise((resolve) => refusing.close(resolve));

    expect(out).toEqual({ ok: false, status: 403, code: 'bucket_403' });
    // A file still held open cannot be removed on Windows.
    rmSync(at);
  });

  it('tries a 429 again after the pause the bucket asked for', async () => {
    const waited: number[] = [];
    let n = 0;
    await new Promise((resolve) => bucket.close(resolve));
    const slow = createServer((_req, res) => {
      n += 1;
      res.writeHead(n === 1 ? 429 : 200, n === 1 ? { 'retry-after': '3' } : {}).end();
    });
    await new Promise<void>((resolve) => slow.listen(0, '127.0.0.1', resolve));
    const client = createClient({ random: () => 0, apiUrl: 'https://api.test', token: TOKEN, wait: async (ms) => void waited.push(ms) });
    const out = await client.put(`http://127.0.0.1:${(slow.address() as AddressInfo).port}/o`, {}, { body: Buffer.from('x') });
    await new Promise((resolve) => slow.close(resolve));

    expect(out).toEqual({ ok: true });
    expect(waited).toEqual([3000]);
  });

  it('gives a refused connection a code and nothing of the address', async () => {
    await new Promise((resolve) => bucket.close(resolve));
    const out = await real().put(`${base}/o?sig=SECRET`, {}, { body: Buffer.from('x') });

    expect(out).toEqual({ ok: false, status: null, code: 'ECONNREFUSED' });
    expect(JSON.stringify(out)).not.toContain('127.0.0.1');
  });
});
