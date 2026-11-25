// The recording proxy from the client's side. Every upstream is a fake server on 127.0.0.1, and a guard
// on the sockets of this process fails any connection to an address that is not loopback.

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import * as http from 'node:http';
import { connect, createServer, type AddressInfo, type Socket } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadStubFile } from '../schema.js';
import {
  isSecretBodyKey,
  parseTarget,
  startRecorder,
  type Recorder,
  type RecordOptions,
} from '../record.js';
import { start } from '../server.js';
import { guardNetwork, type NetGuard } from './net-guard.js';

const KEY = 'sk-test-9f8e7d6c5b4a3210';
// What is left of the key in any encoding of it.
const KEY_CORE = '9f8e7d6c5b4a';

interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

interface Fake {
  origin: string;
  port: number;
  seen: Seen[];
  close(): Promise<void>;
}

type Answer = (seen: Seen, res: http.ServerResponse) => void;

async function fake(answer: Answer): Promise<Fake> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const entry = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      seen.push(entry);
      answer(entry, res);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    port,
    seen,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

const json =
  (body: unknown, status = 200, headers: http.OutgoingHttpHeaders = {}): Answer =>
  (_seen, res) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };

let guard: NetGuard;
let dir: string;
const open: Array<{ close(): Promise<void> }> = [];
const warnings: string[] = [];

beforeAll(() => {
  guard = guardNetwork();
});
afterAll(() => guard.restore());
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plune-record-'));
  warnings.length = 0;
  guard.seen.length = 0;
});
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(open.splice(0).map((o) => o.close()));
  fs.rmSync(dir, { recursive: true, force: true });
  // No test of this file may have tried the real network.
  expect(guard.refused.splice(0)).toEqual([]);
});

async function upstream(answer: Answer): Promise<Fake> {
  const f = await fake(answer);
  open.push(f);
  return f;
}

/** An upstream that is no HTTP server: it answers each connection's first bytes as `reply` says. */
async function rawUpstream(reply: (socket: Socket) => void): Promise<string> {
  const server = createServer((socket) => {
    socket.on('error', () => undefined);
    socket.once('data', () => reply(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  open.push({ close: () => new Promise((resolve) => server.close(() => resolve())) });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function recorder(target: string, more: Partial<RecordOptions> = {}): Promise<Recorder> {
  const r = await startRecorder({
    target,
    file: 'stubs.yaml',
    cwd: dir,
    warn: (line) => warnings.push(line),
    today: () => '2026-01-02',
    ...more,
  });
  open.push(r);
  return r;
}

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    redirect: 'manual',
  });

const bytes = async (res: Response): Promise<Buffer> => Buffer.from(await res.arrayBuffer());

/** One request written byte for byte, and everything that came back. */
async function rawRequest(port: number, target: string, headers: string[] = []): Promise<string> {
  const socket = connect(port, '127.0.0.1');
  let text = '';
  socket.on('data', (c: Buffer) => (text += c.toString('utf8')));
  const head = [`GET ${target} HTTP/1.1`, ...headers, 'connection: close', '', ''];
  if (!headers.some((h) => h.startsWith('host:'))) head.splice(1, 0, `host: 127.0.0.1:${port}`);
  socket.write(head.join('\r\n'));
  await once(socket, 'close');
  return text;
}

/** Stops the recorder and serves what it wrote from the stub server, with the scope `default`. */
async function replay(r: Recorder): Promise<string> {
  await r.close();
  const server = await start();
  open.push(server);
  return server.scope('default', (await loadStubFile(r.file)).stubs).url;
}

describe('mock · record · where a request goes', () => {
  it('runs under a guard that refuses a connection to an address that is not loopback', async () => {
    // 192.0.2.1 is a documentation address; the guard throws before any packet is sent.
    expect(() => connect(80, '192.0.2.1')).toThrow(/not loopback/);
    await expect(fetch('http://192.0.2.1/')).rejects.toThrow();
    expect(guard.refused).toEqual(['192.0.2.1:80', '192.0.2.1:80']);
    guard.refused.length = 0;
  });

  it('sends the path, the query, the body and the credentials to the target', async () => {
    const up = await upstream(json({ ok: true }));
    const r = await recorder(up.origin);
    const res = await post(
      `${r.url}/v1/chat?stream=0`,
      { model: 'm' },
      { authorization: `Bearer ${KEY}` },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(up.seen).toHaveLength(1);
    expect(up.seen[0]).toMatchObject({
      method: 'POST',
      url: '/v1/chat?stream=0',
      body: '{"model":"m"}',
    });
    expect(up.seen[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(up.seen[0]!.headers.host).toBe(`127.0.0.1:${up.port}`);
    expect(r.url).toBe(`http://127.0.0.1:${r.port}/default`);
  });

  it('takes nothing from X-Forwarded-* or Forwarded, and sends none of them on', async () => {
    const up = await upstream(json({ ok: true }));
    const r = await recorder(up.origin);
    const res = await post(
      `${r.url}/v1/chat`,
      {},
      {
        'x-forwarded-host': 'evil.example',
        'x-forwarded-proto': 'https',
        'x-forwarded-for': '10.0.0.1',
        forwarded: 'host=evil.example;proto=https',
      },
    );
    expect(res.status).toBe(200);
    expect(up.seen).toHaveLength(1);
    expect(up.seen[0]!.headers.host).toBe(`127.0.0.1:${up.port}`);
    expect(Object.keys(up.seen[0]!.headers).filter((n) => /forwarded/.test(n))).toEqual([]);
    // Only the client's connection to the recorder and the recorder's to the fake.
    expect(new Set(guard.seen)).toEqual(new Set([`127.0.0.1:${r.port}`, `127.0.0.1:${up.port}`]));
  });

  it.each([
    ['a Host that is another name', (port: number) => [`host: evil.example:${port}`]],
    ['a Host with another port', (port: number) => [`host: 127.0.0.1:${port + 1}`]],
    ['an Origin of another site', () => ['origin: https://evil.example']],
    ['an opaque Origin', () => ['origin: null']],
    [
      'a request a browser marked as cross-site, with no Origin',
      () => ['sec-fetch-site: cross-site'],
    ],
    [
      'a request a browser marked as same-site, with no Origin',
      () => ['sec-fetch-site: same-site'],
    ],
  ])('refuses %s with a 403, forwards nothing and records nothing', async (_name, headers) => {
    const up = await upstream(json({ ok: true }));
    const r = await recorder(up.origin);
    const text = await rawRequest(r.port, '/default/v1/chat', headers(r.port));
    expect(text).toMatch(/^HTTP\/1\.1 403 /);
    expect(text).toContain('mock_not_local');
    expect(text.toLowerCase()).not.toContain('access-control');
    expect(up.seen).toEqual([]);
    expect(guard.seen).toEqual([`127.0.0.1:${r.port}`]);
    await r.close();
    expect((await loadStubFile(r.file)).stubs).toEqual([]);
  });

  it('serves a request addressed to localhost with an Origin of another loopback name and no Sec-Fetch-Site', async () => {
    const up = await upstream(json({ ok: true }));
    const r = await recorder(up.origin);
    const text = await rawRequest(r.port, '/default/v1/chat', [
      `host: localhost:${r.port}`,
      `origin: http://127.0.0.1:${r.port}`,
    ]);
    expect(text).toMatch(/^HTTP\/1\.1 200 /);
    expect(text.toLowerCase()).not.toContain('access-control');
  });

  it('refuses the same request once it says Sec-Fetch-Site cross-site, as a browser sends it', async () => {
    const up = await upstream(json({ ok: true }));
    const r = await recorder(up.origin);
    const text = await rawRequest(r.port, '/default/v1/chat', [
      `host: localhost:${r.port}`,
      `origin: http://127.0.0.1:${r.port}`,
      'sec-fetch-site: cross-site',
    ]);
    expect(text).toMatch(/^HTTP\/1\.1 403 /);
    expect(up.seen).toEqual([]);
    await r.close();
    expect((await loadStubFile(r.file)).stubs).toEqual([]);
  });

  it('serves a client that says nothing of where it came from, and a request a browser marked as its own', async () => {
    const up = await upstream(json({ ok: true }));
    const r = await recorder(up.origin);
    for (const headers of [[], ['sec-fetch-site: same-origin'], ['sec-fetch-site: none']])
      expect(await rawRequest(r.port, '/default/v1/chat', headers)).toMatch(/^HTTP\/1\.1 200 /);
    expect(up.seen).toHaveLength(3);
  });

  it.each([
    ['an absolute-form target', 'http://evil.example/default/v1/chat'],
    ['a target outside the scope', '/other/v1/chat'],
    ['a dot segment', '/default/../v1/chat'],
    ['an encoded dot segment', '/default/%2e%2e/v1/chat'],
    ['an authority-form look-alike', '//evil.example/default/v1'],
  ])('refuses %s with a 400 and forwards nothing', async (_name, target) => {
    const up = await upstream(json({ ok: true }));
    const r = await recorder(up.origin);
    const text = await rawRequest(r.port, target);
    expect(text).toMatch(/^HTTP\/1\.1 400 /);
    expect(text).toContain('mock_bad_target');
    expect(text).not.toContain('evil');
    expect(up.seen).toEqual([]);
    expect(guard.seen).toEqual([`127.0.0.1:${r.port}`]);
  });

  it('keeps a path that looks like another host on the target', async () => {
    const up = await upstream(json({ ok: true }));
    const r = await recorder(up.origin);
    await rawRequest(r.port, '/default//evil.example/x');
    expect(up.seen.map((s) => s.url)).toEqual(['//evil.example/x']);
  });

  it('passes a redirect back to the client, does not follow it and does not record it', async () => {
    const elsewhere = await upstream(json({ followed: true }));
    const up = await upstream((seen, res) => {
      if (seen.url === '/v1/same') res.writeHead(304);
      else res.writeHead(302, { location: `${elsewhere.origin}/v1/moved` });
      res.end();
    });
    const r = await recorder(up.origin);
    const res = await post(`${r.url}/v1/chat`, {});
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${elsewhere.origin}/v1/moved`);
    expect((await post(`${r.url}/v1/same`, {})).status).toBe(304);
    expect(elsewhere.seen).toEqual([]);
    await r.close();
    expect((await loadStubFile(r.file)).stubs).toEqual([]);
    expect(warnings).toEqual([
      'not recorded: POST 302 (a redirect is passed back, not followed)',
      'not recorded: POST 304 (a 304 has no body to replay)',
    ]);
  });

  it.each([
    ['ftp://127.0.0.1', /http: or https:/],
    ['file:///etc/hosts', /http: or https:/],
    ['not a url', /not a URL/],
    [`http://user:${KEY}@127.0.0.1`, /no user name or password/],
    ['http://127.0.0.1/v1', /an origin, with no path or query/],
    [`http://127.0.0.1/?key=${KEY}`, /an origin, with no path or query/],
  ])('refuses the target %s and repeats nothing of it', async (target, message) => {
    expect(() => parseTarget(target)).toThrow(message);
    await expect(startRecorder({ target, file: 'stubs.yaml', cwd: dir })).rejects.not.toThrow(
      KEY_CORE,
    );
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('listens on 127.0.0.1 only', async () => {
    const up = await upstream(json({ ok: true }));
    const r = await recorder(up.origin);
    expect(new URL(r.url).hostname).toBe('127.0.0.1');
  });

  it.each([
    ['a status under 100', 'HTTP/1.1 099 Odd\r\ncontent-length: 0\r\n\r\n'],
    ['a status over 599', 'HTTP/1.1 600 Odd\r\ncontent-length: 0\r\n\r\n'],
    ['a 101', 'HTTP/1.1 101 Switching Protocols\r\nupgrade: x\r\nconnection: upgrade\r\n\r\n'],
  ])('answers %s from the target with a 502, records nothing and goes on', async (_name, reply) => {
    const origin = await rawUpstream((socket) => socket.write(reply));
    const good = await upstream(json({ ok: true }));
    const r = await recorder(origin, { upstreamTimeoutMs: 3000 });
    const res = await post(`${r.url}/v1/chat`, {});
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: { type: string } }).error.type).toBe(
      'mock_upstream_failed',
    );
    await r.close();
    expect((await loadStubFile(r.file)).stubs).toEqual([]);
    // The process is alive: another recorder serves a request.
    const again = await recorder(good.origin, { file: 'again.yaml' });
    expect((await post(`${again.url}/v1/chat`, {})).status).toBe(200);
  });
});

describe('mock · record · what is written', () => {
  it('writes no credential: not from a header, the query, the path, a body or an allowed response header', async () => {
    const up = await upstream((seen, res) => {
      res.writeHead(200, {
        'content-type': 'application/json',
        'retry-after': KEY,
        'x-echo': KEY,
        'set-cookie': `session=${KEY}`,
      });
      res.end(
        JSON.stringify({
          echoed: seen.headers.authorization,
          key: KEY,
          url: seen.url,
          answer: 'hi',
        }),
      );
    });
    const r = await recorder(up.origin);
    const res = await post(
      `${r.url}/v1/keys/${KEY}/chat?api_key=${KEY}&q=hello`,
      {
        model: 'm',
        api_key: KEY,
        max_tokens: 5,
        messages: [{ role: 'user', content: `my key is ${KEY}` }],
      },
      { authorization: `Bearer ${KEY}`, 'x-api-key': KEY, cookie: `sid=${KEY}` },
    );
    // The client still gets everything: masking is for the file only.
    expect(res.headers.get('x-echo')).toBe(KEY);
    expect(await res.text()).toContain(KEY);
    await r.close();

    const text = fs.readFileSync(r.file, 'utf8');
    expect(text).not.toContain(KEY_CORE);
    expect(warnings.join('\n')).not.toContain(KEY_CORE);
    expect(fs.readdirSync(dir)).toEqual(['stubs.yaml']);
    const [stub] = (await loadStubFile(r.file)).stubs;
    expect(stub).toEqual({
      method: 'POST',
      path: '/v1/keys/[masked]/chat',
      // The query is not stored; `api_key` is there with the mask for its value; `max_tokens` is no secret.
      body: {
        model: 'm',
        api_key: '[masked]',
        max_tokens: 5,
        messages: [{ role: 'user', content: 'my key is [masked]' }],
      },
      match: 'exact',
      times: 'always',
      response: {
        status: 200,
        headers: { 'content-type': 'application/json', 'retry-after': '[masked]' },
        json: {
          echoed: '[masked]',
          key: '[masked]',
          url: '/v1/keys/[masked]/chat?api_key=[masked]&q=hello',
          answer: 'hi',
        },
      },
    });
  });

  // One credential per place a request can carry one; each is echoed back in every form below.
  const CARRIED = {
    header: 'hdr-Kq7+Zx/9f8e7d6c5b4a=A',
    query: 'qry-Kq7+Zx/9f8e7d6c5b4a=B',
    // Not `cookie`: the answer echoes these under their names, and that one is a secret's name.
    cookiePart: 'cke-Kq7+Zx/9f8e7d6c5b4a-C',
    bodyField: 'bdy-Kq7+Zx/9f8e7d6c5b4a=D',
    nestedField: 'nst-Kq7+Zx/9f8e7d6c5b4a=E',
  };
  const formsOf = (v: string): Record<string, string> => ({
    plain: v,
    upper: v.toUpperCase(),
    lower: v.toLowerCase(),
    url: encodeURIComponent(v),
    json: JSON.stringify(v).slice(1, -1),
    base64: Buffer.from(v).toString('base64'),
    base64url: Buffer.from(v).toString('base64url'),
    hex: Buffer.from(v).toString('hex'),
    hexUpper: Buffer.from(v).toString('hex').toUpperCase(),
  });

  it('masks a credential from a header, the query, a cookie and a body field at any depth, in every form it comes back in', async () => {
    const echo = Object.fromEntries(Object.entries(CARRIED).map(([k, v]) => [k, formsOf(v)]));
    const up = await upstream(json({ echo, answer: 'kept' }));
    const r = await recorder(up.origin);
    await (
      await post(
        `${r.url}/v1/chat/${encodeURIComponent(CARRIED.bodyField)}?access_token=${encodeURIComponent(CARRIED.query)}`,
        {
          model: 'm',
          api_key: CARRIED.bodyField,
          options: { login: { clientSecret: CARRIED.nestedField } },
        },
        { 'x-api-key': CARRIED.header, cookie: `theme=dark; sid=${CARRIED.cookiePart}` },
      )
    ).text();
    await r.close();
    const text = fs.readFileSync(r.file, 'utf8').toLowerCase();
    for (const [place, value] of Object.entries(CARRIED))
      for (const [form, written] of Object.entries(formsOf(value)))
        expect(text.includes(written.toLowerCase()), `${place} as ${form}`).toBe(false);
    const [stub] = (await loadStubFile(r.file)).stubs;
    expect(stub!.path).toBe('/v1/chat/[masked]');
    expect(stub!.body).toEqual({
      model: 'm',
      api_key: '[masked]',
      options: { login: { clientSecret: '[masked]' } },
    });
    const masked = Object.fromEntries(Object.keys(formsOf('')).map((form) => [form, '[masked]']));
    expect(stub!.response?.json).toEqual({
      echo: Object.fromEntries(Object.keys(CARRIED).map((k) => [k, masked])),
      answer: 'kept',
    });
  });

  it('finds a credential in its JSON-escaped form, and one learnt from a later request', async () => {
    const odd = `K1"x\\y+z/${KEY_CORE}`;
    const up = await upstream((seen, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(
        `raw ${odd} url ${encodeURIComponent(odd)} json ${JSON.stringify(odd)} n=${seen.url.length}`,
      );
    });
    const r = await recorder(up.origin);
    // The first exchange is in the file before the proxy has seen the credential in a header.
    await (await post(`${r.url}/v1/a`, {})).text();
    await vi.waitFor(() => expect(r.recorded).toBe(1));
    await (await post(`${r.url}/v1/b`, {}, { 'x-api-key': odd })).text();
    await r.close();
    const text = fs.readFileSync(r.file, 'utf8');
    expect(text).not.toContain(KEY_CORE);
    expect((await loadStubFile(r.file)).stubs.map((s) => s.response?.text)).toEqual([
      'raw [masked] url [masked] json "[masked]" n=5',
      'raw [masked] url [masked] json "[masked]" n=5',
    ]);
  });

  it('does not record a stream that sends a credential back split over its events', async () => {
    const half = Math.floor(KEY.length / 2);
    const events = [KEY.slice(0, half), KEY.slice(half)]
      .map(
        (delta) =>
          `data: ${JSON.stringify({ id: 'c1', choices: [{ delta: { content: delta } }] })}\n\n`,
      )
      .join('');
    const up = await upstream((seen, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(seen.url === '/v1/split' ? events : 'data: {"delta":"fine"}\n\n');
    });
    const r = await recorder(up.origin);
    const headers = { authorization: `Bearer ${KEY}` };
    expect(await (await post(`${r.url}/v1/split`, {}, headers)).text()).toBe(events);
    await (await post(`${r.url}/v1/whole`, {}, headers)).text();
    await r.close();
    expect(warnings).toEqual([
      'not recorded: POST 200 (a credential is split over the pieces of the answer)',
    ]);
    expect((await loadStubFile(r.file)).stubs.map((s) => s.path)).toEqual(['/v1/whole']);
    expect(fs.readFileSync(r.file, 'utf8')).not.toContain(KEY.slice(half));
  });

  it.each([
    ['api_key', true],
    ['apiKey', true],
    ['x-api-key', true],
    ['key', false],
    ['auth', false],
    ['secret_key', true],
    ['token', true],
    ['access_token', true],
    ['refreshToken', true],
    ['client_secret', true],
    ['password', true],
    ['authorization', true],
    ['session_id', true],
    ['max_tokens', false],
    ['max_completion_tokens', false],
    ['prompt_tokens', false],
    ['tokenizer', false],
    ['author', false],
    ['keywords', false],
    ['monkey', false],
    ['code', false],
    ['model', false],
  ])('takes the body key %s as a secret: %s', (name, secret) => {
    expect(isSecretBodyKey(name)).toBe(secret);
  });

  it('keeps of the response headers only content-type and retry-after', async () => {
    const up = await upstream(
      json({ error: 'slow down' }, 429, {
        'retry-after': '7',
        'set-cookie': 'a=b',
        'x-request-id': 'req-1',
        'www-authenticate': 'Bearer realm="x"',
      }),
    );
    const r = await recorder(up.origin);
    const res = await post(`${r.url}/v1/chat`, {});
    expect(res.headers.get('x-request-id')).toBe('req-1');
    await r.close();
    expect((await loadStubFile(r.file)).stubs[0]!.response).toEqual({
      status: 429,
      headers: { 'content-type': 'application/json', 'retry-after': '7' },
      json: { error: 'slow down' },
    });
  });

  it('starts the file with the date and the origin, what it holds, and the limits of the masking', async () => {
    const up = await upstream(json({ ok: true }));
    const r = await recorder(up.origin);
    await post(`${r.url}/v1/chat?q=1`, {});
    await r.close();
    const lines = fs.readFileSync(r.file, 'utf8').split('\n');
    expect(lines.slice(0, 7)).toEqual([
      `# Recorded by \`plune mock --record\` on 2026-01-02 from ${up.origin}`,
      '# Prompts and answers are stored as they were sent and received: they may hold personal or confidential text.',
      "# A field with a secret's name holds [masked] in place of its value: in the JSON body of a request whatever the value is, in the JSON of an answer only a string of 16 characters or more with no whitespace that is not letters only.",
      '# A credential value is also replaced wherever it is found, if it came in a header, the query or a cookie and has 8 characters or more, or in a body field and has 16 or more with no whitespace.',
      '# Not searched for: a value of letters only, and a value in a form other than plain, URL-encoded, JSON-escaped, base64 or hex; a value over 4096 characters is found by its first 4096.',
      '# A credential in a path segment, or under an ordinary header, query or body-field name, is not known to the recorder.',
      '# Request headers, query strings and timing are not stored. Keep this file local.',
    ]);
  });
});

describe('mock · record · the file', () => {
  it('indents every key of a stub alike, two spaces a level', async () => {
    const up = await upstream(json({ ok: true }));
    const r = await recorder(up.origin);
    await (await post(`${r.url}/v1/chat`, { model: 'm' })).text();
    await (await post(`${r.url}/v1/chat`, { model: 'm' })).text();
    await r.close();
    expect(fs.readFileSync(r.file, 'utf8').split('\n').slice(7).join('\n')).toBe(
      [
        '{',
        '  "version": 1,',
        '  "stubs": [',
        '    {',
        '      "method": "POST",',
        '      "times": "once",',
        '      "path": "/v1/chat",',
        '      "body": {',
        '        "model": "m"',
        '      },',
        '      "match": "exact",',
        '      "response": {',
        '        "status": 200,',
        '        "headers": {',
        '          "content-type": "application/json"',
        '        },',
        '        "json": {',
        '          "ok": true',
        '        }',
        '      }',
        '    },',
        '    {',
        '      "method": "POST",',
        '      "times": "always",',
        '      "path": "/v1/chat",',
        '      "body": {',
        '        "model": "m"',
        '      },',
        '      "match": "exact",',
        '      "response": {',
        '        "status": 200,',
        '        "headers": {',
        '          "content-type": "application/json"',
        '        },',
        '        "json": {',
        '          "ok": true',
        '        }',
        '      }',
        '    }',
        '  ]',
        '}',
        '',
      ].join('\n'),
    );
  });

  it('is a valid empty stub file from the start, and whole after every exchange with no temp file left', async () => {
    const up = await upstream(json({ ok: true }));
    const r = await recorder(up.origin);
    expect((await loadStubFile(r.file)).stubs).toEqual([]);
    for (let i = 1; i <= 3; i += 1) {
      await (await post(`${r.url}/v1/chat`, { i })).text();
      await vi.waitFor(() => expect(r.recorded).toBe(i));
      expect((await loadStubFile(r.file)).stubs).toHaveLength(i);
      expect(fs.readdirSync(dir)).toEqual(['stubs.yaml', 'stubs.yaml.lock']);
    }
  });

  it('replaces the file by renaming a temp file beside it, with a name nobody can guess', async () => {
    const up = await upstream(json({ ok: true }));
    const r = await recorder(up.origin);
    const rename = vi.spyOn(fs.promises, 'rename');
    const write = vi.spyOn(fs.promises, 'writeFile');
    await (await post(`${r.url}/v1/chat`, { n: 1 })).text();
    await vi.waitFor(() => expect(r.recorded).toBe(1));
    await (await post(`${r.url}/v1/chat`, { n: 2 })).text();
    await r.close();
    const temps = rename.mock.calls.map(([from, to]) => {
      expect(to).toBe(r.file);
      return String(from);
    });
    expect(temps).toHaveLength(2);
    for (const temp of temps) expect(temp.slice(r.file.length)).toMatch(/^\.[0-9a-f]{32}\.tmp$/);
    expect(new Set(temps).size).toBe(2);
    // Created anew and for the owner only: nobody else on a shared machine reads prompts from it.
    for (const [, , options] of write.mock.calls)
      expect(options).toEqual({ flag: 'wx', mode: 0o600 });
  });

  it.skipIf(process.platform === 'win32')(
    'keeps the recording readable by its owner only',
    async () => {
      const up = await upstream(json({ ok: true }));
      const r = await recorder(up.origin);
      expect(fs.statSync(r.file).mode & 0o777).toBe(0o600);
      await (await post(`${r.url}/v1/chat`, {})).text();
      await r.close();
      expect(fs.statSync(r.file).mode & 0o777).toBe(0o600);
    },
  );

  it('writes an exchange again when the rename is refused, as when another program reads the file', async () => {
    const up = await upstream(json({ ok: true }));
    const r = await recorder(up.origin);
    const real = fs.promises.rename.bind(fs.promises);
    let refusals = 3;
    vi.spyOn(fs.promises, 'rename').mockImplementation((from, to) => {
      if (refusals === 0) return real(from, to);
      refusals -= 1;
      return Promise.reject(Object.assign(new Error('EPERM'), { code: 'EPERM' }));
    });
    await (await post(`${r.url}/v1/chat`, { n: 1 })).text();
    await r.close();
    expect(r.unwritten).toBe(0);
    expect(warnings).toEqual([]);
    expect((await loadStubFile(r.file)).stubs).toHaveLength(1);
    expect(fs.readdirSync(dir)).toEqual(['stubs.yaml']);
  });

  it('loses no exchange while another program keeps reading the file', async () => {
    const up = await upstream(json({ ok: true }));
    const r = await recorder(up.origin);
    // Another process, as an editor or an indexer is: it reads the file every 3 ms.
    const loop =
      'const f=process.argv[1],w=new Int32Array(new SharedArrayBuffer(4));process.stdout.write("r");' +
      'for(;;){try{require("fs").readFileSync(f)}catch{}Atomics.wait(w,0,0,3)}';
    const reader = spawn(process.execPath, ['-e', loop, r.file]);
    try {
      await once(reader.stdout, 'data');
      for (let i = 0; i < 40; i += 1) await (await post(`${r.url}/v1/chat`, { i })).text();
      await r.close();
    } finally {
      reader.kill();
      await once(reader, 'exit');
    }
    expect(warnings.join(' | ')).toBe('');
    expect(r.unwritten).toBe(0);
    expect((await loadStubFile(r.file)).stubs).toHaveLength(40);
  });

  it('keeps what it could not write and says how many when it stops', async () => {
    const up = await upstream(json({ ok: true }));
    const r = await recorder(up.origin);
    await (await post(`${r.url}/v1/chat`, { n: 1 })).text();
    await vi.waitFor(() => expect(r.recorded).toBe(1));
    const rename = vi.spyOn(fs.promises, 'rename');
    rename.mockRejectedValue(Object.assign(new Error('EPERM'), { code: 'EPERM' }));
    await (await post(`${r.url}/v1/chat`, { n: 2 })).text();
    await (await post(`${r.url}/v1/chat`, { n: 3 })).text();
    await vi.waitFor(() => expect(warnings.length).toBeGreaterThan(0), { timeout: 5000 });
    expect(r.unwritten).toBe(2);
    // The next write carries everything that waited.
    rename.mockRestore();
    await (await post(`${r.url}/v1/chat`, { n: 4 })).text();
    await r.close();
    expect(r.unwritten).toBe(0);
    expect((await loadStubFile(r.file)).stubs.map((s) => s.body)).toEqual([
      { n: 1 },
      { n: 2 },
      { n: 3 },
      { n: 4 },
    ]);
    expect(warnings[0]).toMatch(/^the file could not be written \(EPERM\): \d exchanges? wait/);
    expect(fs.readdirSync(dir)).toEqual(['stubs.yaml']);
  }, 15_000);

  it('refuses a path outside the project folder, also through a link', async () => {
    const up = await upstream(json({ ok: true }));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'plune-outside-'));
    try {
      fs.symlinkSync(outside, path.join(dir, 'link'), 'junction');
      for (const file of [
        '../stubs.yaml',
        path.join(outside, 'stubs.yaml'),
        'link/stubs.yaml',
        'missing/stubs.yaml',
      ])
        await expect(startRecorder({ target: up.origin, file, cwd: dir })).rejects.toThrow(
          /inside the current project folder only/,
        );
      expect(fs.readdirSync(outside)).toEqual([]);
      expect(fs.readdirSync(path.dirname(dir)).filter((f) => f === 'stubs.yaml')).toEqual([]);
    } finally {
      fs.rmSync(path.join(dir, 'link'), { force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('writes into a folder under the project folder', async () => {
    fs.mkdirSync(path.join(dir, 'evals'));
    const up = await upstream(json({ ok: true }));
    const r = await recorder(up.origin, { file: 'evals/chat.stubs.yaml' });
    expect(fs.existsSync(path.join(dir, 'evals', 'chat.stubs.yaml'))).toBe(true);
    expect(r.file.endsWith(path.join('evals', 'chat.stubs.yaml'))).toBe(true);
  });

  it('does not replace a file that exists unless asked', async () => {
    const up = await upstream(json({ ok: true }));
    const old = 'version: 1\nstubs:\n  - path: /old\n    response: { text: old }\n';
    fs.writeFileSync(path.join(dir, 'stubs.yaml'), old);
    await expect(
      startRecorder({ target: up.origin, file: 'stubs.yaml', cwd: dir }),
    ).rejects.toThrow(/exists already.*--force/);
    expect(fs.readFileSync(path.join(dir, 'stubs.yaml'), 'utf8')).toBe(old);
    const r = await recorder(up.origin, { force: true });
    expect((await loadStubFile(r.file)).stubs).toEqual([]);
  });

  it('replaces with --force only a stub file or an empty file, and never a folder', async () => {
    const up = await upstream(json({ ok: true }));
    const config = 'version: 1\nprovider:\n  type: mock\nevals: []\n';
    fs.writeFileSync(path.join(dir, 'plune.yaml'), config);
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'mine');
    fs.writeFileSync(path.join(dir, 'empty.yaml'), ' \n');
    fs.mkdirSync(path.join(dir, 'folder'));
    const forced = (file: string) =>
      startRecorder({ target: up.origin, file, cwd: dir, force: true });
    await expect(forced('plune.yaml')).rejects.toThrow(/only a stub file or an empty file/);
    await expect(forced('notes.txt')).rejects.toThrow(/only a stub file or an empty file/);
    await expect(forced('folder')).rejects.toThrow(/is a folder/);
    await expect(startRecorder({ target: up.origin, file: 'folder', cwd: dir })).rejects.toThrow(
      /is a folder/,
    );
    expect(fs.readFileSync(path.join(dir, 'plune.yaml'), 'utf8')).toBe(config);
    expect(fs.readFileSync(path.join(dir, 'notes.txt'), 'utf8')).toBe('mine');
    const r = await recorder(up.origin, { file: 'empty.yaml', force: true });
    expect((await loadStubFile(r.file)).stubs).toEqual([]);
  });

  it('claims the port before the file: a taken port leaves no new file and an old one as it was', async () => {
    const up = await upstream(json({ ok: true }));
    await expect(
      startRecorder({ target: up.origin, file: 'stubs.yaml', cwd: dir, port: up.port }),
    ).rejects.toThrow(/Cannot listen on 127\.0\.0\.1: EADDRINUSE/);
    expect(fs.readdirSync(dir)).toEqual([]);
    const old = 'version: 1\nstubs:\n  - path: /old\n    response: { text: old }\n';
    fs.writeFileSync(path.join(dir, 'stubs.yaml'), old);
    await expect(
      startRecorder({
        target: up.origin,
        file: 'stubs.yaml',
        cwd: dir,
        port: up.port,
        force: true,
      }),
    ).rejects.toThrow(/Cannot listen on 127\.0\.0\.1: EADDRINUSE/);
    expect(fs.readFileSync(path.join(dir, 'stubs.yaml'), 'utf8')).toBe(old);
    expect(fs.readdirSync(dir)).toEqual(['stubs.yaml']);
  });
});

describe('mock · record · replay with no network', () => {
  const SSE =
    'event: start\ndata: {"type":"start"}\n\ndata: {"delta":"Hel"}\n\ndata: {"delta":"lo"}\n\ndata: [DONE]\n\n';

  it('answers the same requests from the stub server with the same bytes', async () => {
    const pretty =
      '{\n  "id": "a1",\n  "price": 1.0,\n  "big": 12345678901234567890,\n  "text": "caf\u00e9 \u2028 \ud83d\ude00 \\u00e9"\n}\r\n';
    const bodies: Record<string, [string, string]> = {
      '/v1/compact': [
        'application/json',
        '{"id":"c1","choices":[{"text":"hi"}],"usage":{"total_tokens":3}}',
      ],
      '/v1/pretty': ['application/json; charset=utf-8', pretty],
      '/v1/text': ['text/plain', 'line one\r\nline two\t\u0000\u0085end\n'],
      '/v1/stream': ['text/event-stream', SSE],
      '/v1/empty': ['application/json', ''],
    };
    const up = await upstream((seen, res) => {
      const [type, body] = bodies[seen.url]!;
      res.writeHead(200, { 'content-type': type, date: 'Thu, 01 Jan 2026 00:00:00 GMT' });
      res.end(body);
    });
    const r = await recorder(up.origin);
    const live: Record<string, Buffer> = {};
    for (const p of Object.keys(bodies)) live[p] = await bytes(await post(`${r.url}${p}`, { p }));
    const url = await replay(r);
    expect(warnings).toEqual([]);

    const calls = up.seen.length;
    guard.seen.length = 0;
    for (const [p, [type, body]] of Object.entries(bodies)) {
      const res = await post(`${url}${p}`, { p });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe(type);
      const got = await bytes(res);
      expect(got.equals(Buffer.from(body))).toBe(true);
      expect(got.equals(live[p]!)).toBe(true);
    }
    // No request left this process, and none reached the upstream: only the stub server was called.
    expect(up.seen).toHaveLength(calls);
    expect(new Set(guard.seen)).toEqual(new Set([`127.0.0.1:${new URL(url).port}`]));
  });

  it('records an event stream as the chunk list of the stub format', async () => {
    const up = await upstream((_s, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      // In two writes with a pause: the timing is not recorded, the bytes are.
      res.write(SSE.slice(0, 40));
      setTimeout(() => res.end(SSE.slice(40)), 30);
    });
    const r = await recorder(up.origin);
    expect((await bytes(await post(`${r.url}/v1/stream`, { stream: true }))).toString()).toBe(SSE);
    await r.close();
    expect((await loadStubFile(r.file)).stubs[0]!.response).toEqual({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      sse: [
        { event: 'start', data: { type: 'start' } },
        { data: { delta: 'Hel' } },
        { data: { delta: 'lo' } },
        '[DONE]',
      ],
    });
  });

  it('keeps an event stream the chunk list cannot hold as text, byte for byte', async () => {
    const odd = ': ping\r\n\r\nid: 7\r\ndata: a\r\ndata: b\r\n\r\n';
    const up = await upstream((_s, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(odd);
    });
    const r = await recorder(up.origin);
    await (await post(`${r.url}/v1/stream`, {})).text();
    const url = await replay(r);
    expect((await loadStubFile(r.file)).stubs[0]!.response?.text).toBe(odd);
    const res = await post(`${url}/v1/stream`, {});
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(await res.text()).toBe(odd);
  });

  const echoBody: Answer = (seen, res) =>
    json({ for: JSON.parse(seen.body) as unknown })(seen, res);
  const answerOf = async (url: string, body: unknown): Promise<unknown> => {
    const res = await post(url, body);
    return res.status === 200 ? ((await res.json()) as { for: unknown }).for : res.status;
  };

  it('replays to each request its own answer when one body holds the other', async () => {
    const up = await upstream(echoBody);
    const r = await recorder(up.origin);
    const plain = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };
    const stream = { ...plain, stream: true };
    await answerOf(`${r.url}/c2`, plain);
    await answerOf(`${r.url}/c2`, stream);
    const url = await replay(r);
    expect(await answerOf(`${url}/c2`, stream)).toEqual(stream);
    expect(await answerOf(`${url}/c2`, plain)).toEqual(plain);
    expect(await answerOf(`${url}/c2`, { ...plain, stream: false })).toBe(404);
  });

  it('stores max_tokens, and does not answer another request with its recording', async () => {
    const up = await upstream(echoBody);
    const r = await recorder(up.origin);
    await answerOf(`${r.url}/c3`, { max_tokens: 1 });
    const url = await replay(r);
    expect((await loadStubFile(r.file)).stubs[0]!.body).toEqual({ max_tokens: 1 });
    expect(await answerOf(`${url}/c3`, { model: 'zzz' })).toBe(404);
    expect(await answerOf(`${url}/c3`, { max_tokens: 2 })).toBe(404);
    expect(await answerOf(`${url}/c3`, { max_tokens: 1 })).toEqual({ max_tokens: 1 });
  });

  it('matches a secret-named body key as present, whatever it holds', async () => {
    const up = await upstream((seen, res) =>
      json({ for: (JSON.parse(seen.body) as { q: string }).q })(seen, res),
    );
    const r = await recorder(up.origin);
    await answerOf(`${r.url}/v1/chat`, { q: 'with key', api_key: KEY });
    await answerOf(`${r.url}/v1/chat`, { q: 'without key' });
    const url = await replay(r);
    expect(await answerOf(`${url}/v1/chat`, { q: 'with key', api_key: 'another' })).toBe(
      'with key',
    );
    expect(await answerOf(`${url}/v1/chat`, { q: 'with key' })).toBe(404);
    expect(await answerOf(`${url}/v1/chat`, { q: 'without key' })).toBe('without key');
    expect(await answerOf(`${url}/v1/chat`, { q: 'without key', api_key: 'x' })).toBe(404);
    expect(await answerOf(`${url}/v1/other`, { q: 'without key' })).toBe(404);
    expect((await fetch(`${url}/v1/chat`)).status).toBe(404);
  });

  it('replays a path with * in it for that path only', async () => {
    const up = await upstream(json({ ok: true }));
    const r = await recorder(up.origin);
    await (await post(`${r.url}/v1/files/*/x`, {})).text();
    const url = await replay(r);
    expect((await loadStubFile(r.file)).stubs[0]!.path).toBe('/v1/files/*/x');
    expect((await post(`${url}/v1/files/abc/x`, {})).status).toBe(404);
    expect((await post(`${url}/v1/files/*/x`, {})).status).toBe(200);
  });

  it('replays a repeated request in the order recorded, and the last answer for every later repeat', async () => {
    let n = 0;
    const up = await upstream((seen, res) => json({ n: (n += 1) })(seen, res));
    const r = await recorder(up.origin);
    for (let i = 0; i < 3; i += 1) await (await post(`${r.url}/v1/chat`, { q: 'same' })).text();
    const url = await replay(r);
    expect((await loadStubFile(r.file)).stubs.map((s) => s.times)).toEqual([
      'once',
      'once',
      'always',
    ]);
    const got: unknown[] = [];
    for (let i = 0; i < 5; i += 1)
      got.push(await (await post(`${url}/v1/chat`, { q: 'same' })).json());
    expect(got).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }, { n: 3 }, { n: 3 }]);
  });
});

describe('mock · record · what is not recorded', () => {
  it('passes a body over the cap through and warns with the method and the status only', async () => {
    const big = JSON.stringify({ text: 'x'.repeat(5000), key: KEY });
    const up = await upstream((seen, res) =>
      json(seen.url === '/v1/small' ? '{}' : big)(seen, res),
    );
    const r = await recorder(up.origin, { maxBodyBytes: 1024 });
    const res = await post(`${r.url}/v1/big/${KEY}`, {}, { authorization: `Bearer ${KEY}` });
    expect(await res.text()).toBe(big);
    await (await post(`${r.url}/v1/small`, {})).text();
    await r.close();
    expect(warnings).toEqual(['not recorded: POST 200 (the body is over 1024 bytes)']);
    expect((await loadStubFile(r.file)).stubs.map((s) => s.path)).toEqual(['/v1/small']);
  });

  it('passes a body that is not UTF-8 text, or is compressed, through unrecorded', async () => {
    const binary = Buffer.from([0xff, 0xfe, 0x00, 0x80]);
    const up = await upstream((seen, res) => {
      if (seen.url === '/v1/binary') {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end(binary);
      } else {
        res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'br' });
        res.end('{}');
      }
    });
    const r = await recorder(up.origin);
    expect((await bytes(await post(`${r.url}/v1/binary`, {}))).equals(binary)).toBe(true);
    const packed = http.request({
      host: '127.0.0.1',
      port: r.port,
      method: 'POST',
      path: '/default/v1/packed',
    });
    packed.end('{}');
    const [res] = (await once(packed, 'response')) as [http.IncomingMessage];
    res.resume();
    await once(res, 'end');
    expect(up.seen.map((s) => s.headers['accept-encoding'])).toEqual(['identity', 'identity']);
    await r.close();
    expect(warnings).toEqual([
      'not recorded: POST 200 (the body is not UTF-8 text)',
      'not recorded: POST 200 (the body is compressed)',
    ]);
    expect((await loadStubFile(r.file)).stubs).toEqual([]);
  });

  it.each([
    ['a refused connection', 'http', {}],
    ['a TLS error', 'https', {}],
    ['a timeout', 'silent', { upstreamTimeoutMs: 150 }],
  ])(
    'answers %s of the upstream with a 502 that names no header or body',
    async (_name, kind, more) => {
      const up = await upstream(kind === 'silent' ? () => undefined : json({ ok: true }));
      let target = up.origin;
      if (kind === 'http') await up.close();
      if (kind === 'https') target = `https://127.0.0.1:${up.port}`;
      const r = await recorder(target, more);
      const res = await post(
        `${r.url}/v1/chat/${KEY}?api_key=${KEY}`,
        { prompt: 'a private prompt' },
        { 'x-api-key': KEY },
      );
      expect(res.status).toBe(502);
      const text = await res.text();
      const body = JSON.parse(text) as { error: { type: string; message: string } };
      expect(body.error.type).toBe('mock_upstream_failed');
      expect(body.error.message).toMatch(
        /^The target did not answer this POST request \([A-Z0-9_ a-z]+\); nothing was recorded$/,
      );
      expect(text).not.toContain(KEY_CORE);
      expect(text).not.toContain('private prompt');
      expect(text).not.toContain('x-api-key');
      await r.close();
      expect((await loadStubFile(r.file)).stubs).toEqual([]);
      expect(fs.readFileSync(r.file, 'utf8')).not.toContain(KEY_CORE);
    },
  );

  it('does not record an answer the upstream cut in the middle', async () => {
    const up = await upstream((_s, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': '100' });
      res.write('{"half":', () => res.destroy());
    });
    const r = await recorder(up.origin);
    await expect(post(`${r.url}/v1/chat`, {}).then((res) => res.text())).rejects.toThrow();
    await r.close();
    expect((await loadStubFile(r.file)).stubs).toEqual([]);
  });

  it('does not record a body with no declared length that the target cut with a reset', async () => {
    const head = 'HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\nconnection: close\r\n\r\n';
    const cut = await rawUpstream((socket) =>
      socket.write(`${head}half of the ans`, () => setTimeout(() => socket.resetAndDestroy(), 50)),
    );
    const whole = await rawUpstream((socket) => socket.end(`${head}the whole answer`));
    const r = await recorder(cut);
    await post(`${r.url}/v1/chat`, {})
      .then((res) => res.text())
      .catch(() => undefined);
    await r.close();
    expect((await loadStubFile(r.file)).stubs).toEqual([]);
    // The same body ended by the target in good order is an answer, and is recorded.
    const ok = await recorder(whole, { file: 'whole.yaml' });
    expect(await (await post(`${ok.url}/v1/chat`, {})).text()).toBe('the whole answer');
    await ok.close();
    expect((await loadStubFile(ok.file)).stubs[0]!.response?.text).toBe('the whole answer');
  });
});

describe('mock · record · stopping', () => {
  it('closes with a request in flight: the client is cut, nothing is recorded, the port is free', async () => {
    const up = await upstream(() => undefined);
    const r = await recorder(up.origin);
    const pending = post(`${r.url}/v1/chat`, {}).then(
      () => 'answered',
      () => 'cut',
    );
    await vi.waitFor(() => expect(up.seen).toHaveLength(1));
    await r.close();
    await r.close();
    expect(await pending).toBe('cut');
    expect((await loadStubFile(r.file)).stubs).toEqual([]);
    const again = await recorder(up.origin, { port: r.port, force: true });
    expect(again.port).toBe(r.port);
  });

  it('has every finished exchange in the file after close', async () => {
    const up = await upstream(json({ ok: true }));
    const r = await recorder(up.origin);
    await Promise.all(
      [1, 2, 3, 4, 5].map((i) => post(`${r.url}/v1/chat`, { i }).then((res) => res.text())),
    );
    await r.close();
    expect(r.recorded).toBe(5);
    expect((await loadStubFile(r.file)).stubs).toHaveLength(5);
    expect(fs.readdirSync(dir)).toEqual(['stubs.yaml']);
  });
});

describe('mock · record · credentials, second pass', () => {
  const HALF = Math.floor(KEY.length / 2);
  const H1 = KEY.slice(0, HALF);
  const H2 = KEY.slice(HALF);

  it('records on, and prints the key nowhere, when a secret-named body field holds 16 KiB', async () => {
    const up = await upstream(json({ ok: true }));
    const r = await recorder(up.origin);
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => void rejections.push(reason);
    process.on('unhandledRejection', onRejection);
    try {
      await (await post(`${r.url}/v1/a`, { n: 1 }, { authorization: `Bearer ${KEY}` })).text();
      const big = { n: 2, thinking: { signature: 'Q'.repeat(16384) } };
      await (await post(`${r.url}/v1/b`, big, { authorization: `Bearer ${KEY}` })).text();
      await (await post(`${r.url}/v1/c`, { n: 3 }, { authorization: `Bearer ${KEY}` })).text();
      await r.close();
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      process.off('unhandledRejection', onRejection);
    }
    expect(rejections).toEqual([]);
    expect(warnings).toEqual([]);
    expect(r.unwritten).toBe(0);
    const { stubs } = await loadStubFile(r.file);
    expect(stubs.map((s) => s.path)).toEqual(['/v1/a', '/v1/b', '/v1/c']);
    expect(stubs[1]!.body).toEqual({ n: 2, thinking: { signature: '[masked]' } });
    expect(fs.readFileSync(r.file, 'utf8')).not.toContain('QQQQ');
  });

  it('says in fixed words that a write failed, with nothing of the error in them', async () => {
    const up = await upstream(json({ ok: true }));
    const r = await recorder(up.origin);
    vi.spyOn(fs.promises, 'writeFile').mockRejectedValue(new Error(`boom with ${KEY} in it`));
    await (await post(`${r.url}/v1/a`, {}, { authorization: `Bearer ${KEY}` })).text();
    await vi.waitFor(() => expect(warnings.length).toBeGreaterThan(0));
    vi.restoreAllMocks();
    await r.close();
    expect(warnings).toEqual([
      'the file could not be written (error): 1 exchange waits in memory for the next write',
    ]);
    expect(r.unwritten).toBe(0);
  });

  it.each([
    [
      'events with a space after the colon of their JSON',
      'text/event-stream',
      `data: {"delta": "${H1}"}\n\ndata: {"delta": "${H2}"}\n\n`,
    ],
    [
      'events with CRLF, id lines and a comment',
      'text/event-stream',
      `: ping\r\n\r\nid: 1\r\ndata: {"delta":"${H1}"}\r\n\r\nid: 2\r\ndata: {"delta":"${H2}"}\r\n\r\n`,
    ],
    [
      'events that put the pieces at different places of an array',
      'text/event-stream',
      `data: {"id":"c1","choices":[{"delta":"${H1}"}]}\n\ndata: {"id":"c1","choices":[null,{"delta":"${H2}"}]}\n\n`,
    ],
    [
      'lines of JSON',
      'application/x-ndjson',
      `{"model":"m","response":"${H1}"}\n{"model":"m","response":"${H2}"}\n`,
    ],
    ['events of plain text', 'text/event-stream', `data: ${H1}\n\ndata: ${H2}\n\n`],
    [
      'compact events with other strings between the pieces',
      'text/event-stream',
      `data: {"id":"c1","d":"${H1}"}\n\ndata: {"id":"c1","d":"${H2}"}\n\n`,
    ],
  ])('does not record a credential that comes back split over %s', async (_name, type, body) => {
    const up = await upstream((seen, res) => {
      res.writeHead(200, { 'content-type': type });
      res.end(seen.url === '/v1/split' ? body : 'data: fine\n\n');
    });
    const r = await recorder(up.origin);
    const headers = { authorization: `Bearer ${KEY}` };
    expect(await (await post(`${r.url}/v1/split`, {}, headers)).text()).toBe(body);
    await (await post(`${r.url}/v1/whole`, {}, headers)).text();
    await r.close();
    expect(warnings).toEqual([
      'not recorded: POST 200 (a credential is split over the pieces of the answer)',
    ]);
    expect((await loadStubFile(r.file)).stubs.map((s) => s.path)).toEqual(['/v1/whole']);
    const text = fs.readFileSync(r.file, 'utf8');
    expect(text).not.toContain(H1);
    expect(text).not.toContain(H2);
  });

  it('leaves the keys of a body alone, and replays a request whose values name its keys', async () => {
    const body = {
      filter: { key: 'category' },
      sort: { key: 'messages' },
      messages: [{ role: 'user', content: 'what is the category of messages' }],
    };
    const answer = 'the category of messages is fine';
    const up = await upstream((_s, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(answer);
    });
    const r = await recorder(up.origin);
    await (await post(`${r.url}/v1/chat`, body)).text();
    const url = await replay(r);
    const [stub] = (await loadStubFile(r.file)).stubs;
    expect(stub!.body).toEqual(body);
    expect(stub!.response?.text).toBe(answer);
    const again = await post(`${url}/v1/chat`, body);
    expect(again.status).toBe(200);
    expect(await again.text()).toBe(answer);
  });

  it('does not search for a header value made of letters only, so a prompt with that word still matches exactly', async () => {
    const up = await upstream(json({ ok: true }));
    const r = await recorder(up.origin);
    const prompt = { messages: [{ role: 'user', content: 'my password is safe' }] };
    await (await post(`${r.url}/v1/chat`, prompt, { 'x-api-key': 'password' })).text();
    const url = await replay(r);
    expect((await loadStubFile(r.file)).stubs[0]!.body).toEqual(prompt);
    const other = { messages: [{ role: 'user', content: 'my dog is safe' }] };
    expect((await post(`${url}/v1/chat`, other)).status).toBe(404);
    expect((await post(`${url}/v1/chat`, prompt)).status).toBe(200);
  });

  it('masks a short or spaced value of a secret-named body field in place, and does not search for it', async () => {
    const up = await upstream(json({ said: 'hunter2 and a pass phrase of words' }));
    const r = await recorder(up.origin);
    await (
      await post(`${r.url}/v1/chat`, {
        password: 'hunter2',
        passphrase: 'a pass phrase of words',
        note: 'hunter2 is not a secret here',
      })
    ).text();
    await r.close();
    const [stub] = (await loadStubFile(r.file)).stubs;
    expect(stub!.body).toEqual({
      password: '[masked]',
      passphrase: '[masked]',
      note: 'hunter2 is not a secret here',
    });
    expect(stub!.response?.json).toEqual({ said: 'hunter2 and a pass phrase of words' });
  });

  it('masks what is already written when a later request that is not recorded brings the credential', async () => {
    const up = await upstream((seen, res) => {
      if (seen.url === '/v1/redirect') {
        res.writeHead(302, { location: '/elsewhere' });
        res.end();
      } else json({ leaked: KEY })(seen, res);
    });
    const r = await recorder(up.origin);
    await (await post(`${r.url}/v1/first`, {})).text();
    await vi.waitFor(() => expect(r.recorded).toBe(1));
    expect(fs.readFileSync(r.file, 'utf8')).toContain(KEY);
    expect((await post(`${r.url}/v1/redirect`, {}, { 'x-api-key': KEY })).status).toBe(302);
    await vi.waitFor(() => expect(fs.readFileSync(r.file, 'utf8')).not.toContain(KEY_CORE));
    await r.close();
    expect((await loadStubFile(r.file)).stubs[0]!.response?.json).toEqual({ leaked: '[masked]' });
  });

  it('masks in an answer a secret-named field that holds a credential-like string, in JSON of every form', async () => {
    const issued = `at-${'0123456789abcdef'.repeat(2)}-${KEY_CORE.slice(0, 4)}`;
    expect(issued).toHaveLength(40);
    const answers: Record<string, [string, string]> = {
      '/compact': ['application/json', `{"access_token":"${issued}","expires_in":3600}`],
      '/pretty': ['application/json', `{\n  "access_token": "${issued}",\n  "ok": true\n}\n`],
      '/stream': ['text/event-stream', `data: {"session":{"client_secret":"${issued}"},"n":1}\n\n`],
    };
    const up = await upstream((seen, res) => {
      const [type, body] = answers[seen.url]!;
      res.writeHead(200, { 'content-type': type });
      res.end(body);
    });
    const r = await recorder(up.origin);
    for (const p of Object.keys(answers)) await (await post(`${r.url}${p}`, {})).text();
    await r.close();
    expect(fs.readFileSync(r.file, 'utf8')).not.toContain(issued.slice(3, 20));
    const responses = (await loadStubFile(r.file)).stubs.map((s) => s.response);
    expect(responses[0]!.json).toEqual({ access_token: '[masked]', expires_in: 3600 });
    expect(responses[1]!.json).toEqual({ access_token: '[masked]', ok: true });
    expect(responses[2]!.sse).toEqual([{ data: { session: { client_secret: '[masked]' }, n: 1 } }]);
  });

  it('leaves in an answer a secret-named field that holds no credential: the answer replays byte for byte', async () => {
    const answers: Record<string, string> = {
      // Token probabilities: `token` is a piece of the answer, not a secret.
      '/logprobs':
        '{"choices":[{"logprobs":{"content":[{"token":"Hello","logprob":-0.1},{"token":" world","logprob":-0.25}]}}]}',
      '/page':
        '{"items":[1,2],"next_page_token":"p2","token":{"id":7,"text":"Hi"},"signature":null}',
    };
    const up = await upstream((seen, res) => json(answers[seen.url]!)(seen, res));
    const r = await recorder(up.origin);
    for (const p of Object.keys(answers)) await (await post(`${r.url}${p}`, {})).text();
    const url = await replay(r);
    expect(warnings).toEqual([]);
    for (const [p, body] of Object.entries(answers))
      expect(await (await post(`${url}${p}`, {})).text()).toBe(body);
  });

  it('never rewrites a key: an answer with a credential for a key is not recorded', async () => {
    // A key rewritten to the mask would change what the client reads on replay, and in a request body
    // which request the stub matches. So a key is left alone, and what cannot be written without the
    // credential is not written at all.
    const up = await upstream((seen, res) =>
      json(seen.url === '/v1/keyed' ? { [KEY]: 'the value under it' } : { ok: true })(seen, res),
    );
    const r = await recorder(up.origin);
    const headers = { authorization: `Bearer ${KEY}` };
    await (await post(`${r.url}/v1/keyed`, {}, headers)).text();
    await (await post(`${r.url}/v1/plain`, {}, headers)).text();
    await r.close();
    expect(warnings).toEqual(['not recorded: POST 200 (it cannot be written safely)']);
    expect((await loadStubFile(r.file)).stubs.map((s) => s.path)).toEqual(['/v1/plain']);
    expect(fs.readFileSync(r.file, 'utf8')).not.toContain(KEY_CORE);
  });

  it('finds a bearer token of 5,000 characters by its first 4,096, and masks all of it', async () => {
    const long = `tk-${KEY_CORE}-${'0123456789abcdefghij'.repeat(250)}`.slice(0, 5000);
    const up = await upstream(
      json({ echoed: `Bearer ${long}`, note: `the token ${long} was sent`, hex: 'unrelated' }),
    );
    const r = await recorder(up.origin);
    await (await post(`${r.url}/v1/chat`, {}, { authorization: `Bearer ${long}` })).text();
    await r.close();
    const text = fs.readFileSync(r.file, 'utf8');
    expect(text).not.toContain(KEY_CORE);
    // Nothing of the part after the first 4,096 characters is left either.
    expect(text).not.toContain(long.slice(4096, 4116));
    expect((await loadStubFile(r.file)).stubs[0]!.response?.json).toEqual({
      echoed: '[masked]',
      note: 'the token [masked] was sent',
      hex: 'unrelated',
    });
  });

  it('records a 2 MiB stream of 40,000 events about as fast with 50 credentials learnt as with none', async () => {
    const event = (i: number): string =>
      `data: {"id":"c1","choices":[{"index":0,"delta":{"content":"Word ${i} of the answer"}}]}\n\n`;
    let stream = '';
    for (let i = 0; i < 40_000; i += 1) stream += event(i);
    expect(Buffer.byteLength(stream)).toBeGreaterThan(2 * 1024 * 1024);
    const up = await upstream((seen, res) => {
      const big = seen.url === '/v1/stream';
      res.writeHead(200, { 'content-type': big ? 'text/event-stream' : 'text/plain' });
      res.end(big ? stream : 'ok');
    });
    /** Milliseconds from the request to the stream being in the file, with so many credentials learnt first. */
    const timed = async (credentials: number): Promise<number> => {
      const r = await recorder(up.origin, { file: `with-${credentials}.yaml` });
      for (let i = 0; i < credentials; i += 1)
        await (await post(`${r.url}/v1/warm`, { i }, { 'x-api-key': `key-${i}-${KEY}` })).text();
      await vi.waitFor(() => expect(r.recorded).toBe(credentials));
      const started = performance.now();
      expect(await (await post(`${r.url}/v1/stream`, {})).text()).toBe(stream);
      await vi.waitFor(() => expect(r.recorded).toBe(credentials + 1), {
        timeout: 60_000,
        interval: 10,
      });
      const elapsed = performance.now() - started;
      await r.close();
      return elapsed;
    };
    const none = await timed(0);
    const fifty = await timed(50);
    // Learnt credentials cost little: strings are looked at again only on a find.
    expect(fifty).toBeLessThan(2 * none + 500);
    // And the stream itself is cheap: about half a second where this test was written, and over four
    // when every stub was read back with the reader of stub files.
    expect(fifty).toBeLessThan(3000);
  }, 120_000);

  it('learns a credential from a form-encoded request body', async () => {
    const secret = `frm+Zx/${KEY_CORE}=F`;
    const up = await upstream((seen, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`you sent ${seen.body} and ${secret}`);
    });
    const r = await recorder(up.origin);
    const form = new URLSearchParams({ grant_type: 'client_credentials', client_secret: secret });
    await (
      await fetch(`${r.url}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      })
    ).text();
    await r.close();
    expect(fs.readFileSync(r.file, 'utf8')).not.toContain(KEY_CORE);
    expect((await loadStubFile(r.file)).stubs[0]!.response?.text).toBe(
      'you sent grant_type=client_credentials&client_secret=[masked] and [masked]',
    );
  });

  it('learns the password of Basic authorization', async () => {
    const password = `pw-${KEY_CORE}`;
    const up = await upstream(json({ user: 'john', password, hint: `it ends in ${password}` }));
    const r = await recorder(up.origin);
    const basic = Buffer.from(`john:${password}`).toString('base64');
    await (await post(`${r.url}/v1/me`, {}, { authorization: `Basic ${basic}` })).text();
    await r.close();
    expect(fs.readFileSync(r.file, 'utf8')).not.toContain(KEY_CORE);
    expect((await loadStubFile(r.file)).stubs[0]!.response?.json).toEqual({
      user: 'john',
      password: '[masked]',
      hint: 'it ends in [masked]',
    });
  });
});

describe('mock · record · housekeeping', () => {
  it('serialises each exchange once, however many writes follow it', async () => {
    const up = await upstream(json({ ok: true }));
    let serialised = 0;
    const r = await recorder(up.origin, { onSerialise: () => (serialised += 1) });
    for (let i = 1; i <= 25; i += 1) {
      await (await post(`${r.url}/v1/chat`, { i })).text();
      await vi.waitFor(() => expect(r.recorded).toBe(i));
    }
    await r.close();
    expect(serialised).toBe(25);
  });

  it('warns once when the file passes 1 MiB, the limit of a stub file in `plune run`', async () => {
    const big = 'x'.repeat(600 * 1024);
    const up = await upstream((_s, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(big);
    });
    const r = await recorder(up.origin);
    for (let i = 1; i <= 3; i += 1) {
      await (await post(`${r.url}/v1/chat`, { i })).text();
      await vi.waitFor(() => expect(r.recorded).toBe(i));
    }
    await r.close();
    expect(warnings).toEqual([
      'the recording is over 1 MiB: `plune run` refuses a stub file over 1 MiB, `plune mock` serves it',
    ]);
  });

  it('records the final answer that follows a 103', async () => {
    const origin = await rawUpstream((socket) =>
      socket.end(
        'HTTP/1.1 103 Early Hints\r\nlink: </a>\r\n\r\n' +
          'HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: 5\r\n\r\nfinal',
      ),
    );
    // No timeout near: without a final answer this test would not get its 200 in time.
    const r = await recorder(origin, { upstreamTimeoutMs: 60_000 });
    const res = await post(`${r.url}/v1/chat`, {});
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('final');
    await r.close();
    expect((await loadStubFile(r.file)).stubs[0]!.response?.text).toBe('final');
  });

  it('answers a 103 with nothing after it with a 502 when the timeout passes', async () => {
    const origin = await rawUpstream((socket) =>
      socket.write('HTTP/1.1 103 Early Hints\r\nlink: </a>\r\n\r\n'),
    );
    const r = await recorder(origin, { upstreamTimeoutMs: 200 });
    const res = await post(`${r.url}/v1/chat`, {});
    expect(res.status).toBe(502);
    expect(await res.text()).toContain('(ETIMEDOUT)');
  });

  it('refuses a second recorder on a file a live one is writing, also with --force', async () => {
    const up = await upstream(json({ ok: true }));
    const first = await recorder(up.origin);
    await (await post(`${first.url}/v1/chat`, {})).text();
    await vi.waitFor(() => expect(first.recorded).toBe(1));
    expect(fs.readdirSync(dir)).toEqual(['stubs.yaml', 'stubs.yaml.lock']);
    await expect(
      startRecorder({ target: up.origin, file: 'stubs.yaml', cwd: dir, force: true }),
    ).rejects.toThrow(
      `another recorder (process ${process.pid}) is writing this file: stop it first, or give another path. Its lock is ${first.file}.lock: if no recorder is running, delete that file`,
    );
    await (await post(`${first.url}/v1/chat`, { n: 2 })).text();
    await first.close();
    expect((await loadStubFile(first.file)).stubs).toHaveLength(2);
    expect(fs.readdirSync(dir)).toEqual(['stubs.yaml']);
  });

  it('takes over the lock of a process that is gone, with a warning', async () => {
    const up = await upstream(json({ ok: true }));
    const gone = spawn(process.execPath, ['-e', '']);
    await once(gone, 'exit');
    fs.writeFileSync(path.join(dir, 'stubs.yaml.lock'), `${gone.pid}\n`);
    const r = await recorder(up.origin);
    expect(warnings).toEqual([
      'a lock of a recorder that is no longer running was found and taken over',
    ]);
    expect(fs.readFileSync(path.join(dir, 'stubs.yaml.lock'), 'utf8')).toBe(`${process.pid}\n`);
    await r.close();
    expect(fs.readdirSync(dir)).toEqual(['stubs.yaml']);
  });

  it('removes its own temp files of an earlier run that are older than a minute', async () => {
    const up = await upstream(json({ ok: true }));
    const old = new Date(Date.now() - 5 * 60_000);
    const names = {
      stale: `stubs.yaml.${'a'.repeat(32)}.tmp`,
      fresh: `stubs.yaml.${'b'.repeat(32)}.tmp`,
      otherFile: `other.yaml.${'c'.repeat(32)}.tmp`,
      otherShape: 'stubs.yaml.backup.tmp',
    };
    for (const name of Object.values(names)) fs.writeFileSync(path.join(dir, name), 'x');
    for (const name of [names.stale, names.otherFile, names.otherShape])
      fs.utimesSync(path.join(dir, name), old, old);
    const r = await recorder(up.origin);
    await r.close();
    expect(fs.readdirSync(dir).sort()).toEqual(
      [names.fresh, names.otherFile, names.otherShape, 'stubs.yaml'].sort(),
    );
  });

  it.each([
    ['http://192.0.2.1', true],
    ['http://api.example.com:8080', true],
    ['https://192.0.2.1', false],
    ['http://127.0.0.1:9', false],
    ['http://localhost:9', false],
    ['http://[::1]:9', false],
  ])(
    'for the target %s, warns that the credential travels unencrypted: %s',
    async (target, warned) => {
      const r = await recorder(target);
      await r.close();
      expect(warnings).toEqual(
        warned
          ? [
              'the target is http: on another machine: every request, its credential included, travels unencrypted',
            ]
          : [],
      );
      expect(guard.seen).toEqual([]);
    },
  );
});
