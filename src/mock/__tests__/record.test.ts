// The recording proxy from the client's side. Every upstream is a fake server on 127.0.0.1, and a guard
// on the sockets of this process fails any connection to an address that is not loopback.

import { once } from 'node:events';
import * as fs from 'node:fs';
import * as http from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadStubFile } from '../schema.js';
import { parseTarget, startRecorder, type Recorder, type RecordOptions } from '../record.js';
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

  it('takes nothing from Host, X-Forwarded-* or Forwarded, and sends none of them on', async () => {
    const up = await upstream(json({ ok: true }));
    const r = await recorder(up.origin);
    const req = http.request({
      host: '127.0.0.1',
      port: r.port,
      method: 'POST',
      path: '/default/v1/chat',
      headers: {
        host: 'evil.example',
        'x-forwarded-host': 'evil.example',
        'x-forwarded-proto': 'https',
        'x-forwarded-for': '10.0.0.1',
        forwarded: 'host=evil.example;proto=https',
      },
    });
    req.end('{}');
    const [res] = (await once(req, 'response')) as [http.IncomingMessage];
    res.resume();
    await once(res, 'end');
    expect(res.statusCode).toBe(200);
    expect(up.seen).toHaveLength(1);
    const names = Object.keys(up.seen[0]!.headers);
    expect(up.seen[0]!.headers.host).toBe(`127.0.0.1:${up.port}`);
    expect(names.filter((n) => /forwarded/.test(n))).toEqual([]);
    // Only the client's connection to the recorder and the recorder's to the fake.
    expect(new Set(guard.seen)).toEqual(new Set([`127.0.0.1:${r.port}`, `127.0.0.1:${up.port}`]));
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
    const socket = connect(r.port, '127.0.0.1');
    let text = '';
    socket.on('data', (c: Buffer) => (text += c.toString('utf8')));
    socket.write(`GET ${target} HTTP/1.1\r\nhost: evil.example\r\nconnection: close\r\n\r\n`);
    await once(socket, 'close');
    expect(text).toMatch(/^HTTP\/1\.1 400 /);
    expect(text).toContain('mock_bad_target');
    expect(text).not.toContain('evil');
    expect(up.seen).toEqual([]);
    expect(guard.seen).toEqual([`127.0.0.1:${r.port}`]);
  });

  it('keeps a path that looks like another host on the target', async () => {
    const up = await upstream(json({ ok: true }));
    const r = await recorder(up.origin);
    const socket = connect(r.port, '127.0.0.1');
    socket.resume();
    socket.write('GET /default//evil.example/x HTTP/1.1\r\nhost: a\r\nconnection: close\r\n\r\n');
    await once(socket, 'close');
    expect(up.seen.map((s) => s.url)).toEqual(['//evil.example/x']);
  });

  it('passes a redirect back to the client, does not follow it and does not record it', async () => {
    const elsewhere = await upstream(json({ followed: true }));
    const up = await upstream((_s, res) => {
      res.writeHead(302, { location: `${elsewhere.origin}/v1/moved` });
      res.end();
    });
    const r = await recorder(up.origin);
    const res = await post(`${r.url}/v1/chat`, {});
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${elsewhere.origin}/v1/moved`);
    expect(elsewhere.seen).toEqual([]);
    await r.close();
    expect((await loadStubFile(r.file)).stubs).toEqual([]);
    expect(warnings).toEqual(['not recorded: POST 302 (a redirect is passed back, not followed)']);
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
    expect(Object.keys({ ...({} as RecordOptions) })).not.toContain('host');
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
      path: '/v1/keys/*/chat',
      // `api_key` and `max_tokens` look like credentials by name and are left out; the query is not stored.
      body: { model: 'm', messages: [{ role: 'user', content: 'my key is [masked]' }] },
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

  it('finds a credential in its URL-encoded and JSON-escaped forms, and one learnt from a later request', async () => {
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
    await (await post(`${r.url}/v1/b`, {}, { 'x-api-key': odd })).text();
    await r.close();
    const text = fs.readFileSync(r.file, 'utf8');
    expect(text).not.toContain(KEY_CORE);
    expect((await loadStubFile(r.file)).stubs.map((s) => s.response?.text)).toEqual([
      'raw [masked] url [masked] json "[masked]" n=5',
      'raw [masked] url [masked] json "[masked]" n=5',
    ]);
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

  it('starts the file with the date and the origin, and says what it holds', async () => {
    const up = await upstream(json({ ok: true }));
    const r = await recorder(up.origin);
    await post(`${r.url}/v1/chat?q=1`, {});
    await r.close();
    const lines = fs.readFileSync(r.file, 'utf8').split('\n');
    expect(lines[0]).toBe(`# Recorded by \`plune mock --record\` on 2026-01-02 from ${up.origin}`);
    expect(lines[1]).toMatch(/may hold personal or confidential text/);
    expect(lines[2]).toMatch(/Keep this file local/);
  });
});

describe('mock · record · the file', () => {
  it('is a valid empty stub file from the start, and whole after every exchange with no temp file left', async () => {
    const up = await upstream(json({ ok: true }));
    const r = await recorder(up.origin);
    expect((await loadStubFile(r.file)).stubs).toEqual([]);
    for (let i = 1; i <= 3; i += 1) {
      await (await post(`${r.url}/v1/chat`, { i })).text();
      await vi.waitFor(() => expect(r.recorded).toBe(i));
      expect((await loadStubFile(r.file)).stubs).toHaveLength(i);
      expect(fs.readdirSync(dir)).toEqual(['stubs.yaml']);
    }
  });

  it('replaces the file by renaming a temp file beside it', async () => {
    const up = await upstream(json({ ok: true }));
    const r = await recorder(up.origin);
    const rename = vi.spyOn(fs.promises, 'rename');
    try {
      await (await post(`${r.url}/v1/chat`, {})).text();
      await r.close();
      expect(rename.mock.calls).toEqual([[`${r.file}.${process.pid}.tmp`, r.file]]);
    } finally {
      rename.mockRestore();
    }
  });

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
    fs.writeFileSync(path.join(dir, 'stubs.yaml'), 'mine');
    await expect(
      startRecorder({ target: up.origin, file: 'stubs.yaml', cwd: dir }),
    ).rejects.toThrow(/exists already.*--force/);
    expect(fs.readFileSync(path.join(dir, 'stubs.yaml'), 'utf8')).toBe('mine');
    const r = await recorder(up.origin, { force: true });
    expect((await loadStubFile(r.file)).stubs).toEqual([]);
  });

  it('leaves no file behind when the port is taken', async () => {
    const up = await upstream(json({ ok: true }));
    await expect(
      startRecorder({ target: up.origin, file: 'stubs.yaml', cwd: dir, port: up.port }),
    ).rejects.toThrow(/Cannot listen on 127\.0\.0\.1: EADDRINUSE/);
    expect(fs.readdirSync(dir)).toEqual([]);
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

  it('matches by method, path and the stored body, whatever the credential-looking keys hold', async () => {
    const up = await upstream((seen, res) =>
      json({ for: (JSON.parse(seen.body) as { q: string }).q })(seen, res),
    );
    const r = await recorder(up.origin);
    await (await post(`${r.url}/v1/chat`, { q: 'one', max_tokens: 5, api_key: KEY })).text();
    await (await post(`${r.url}/v1/chat`, { q: 'two', max_tokens: 5 })).text();
    const url = await replay(r);
    expect(await (await post(`${url}/v1/chat`, { q: 'two', max_tokens: 99 })).json()).toEqual({
      for: 'two',
    });
    expect(await (await post(`${url}/v1/chat`, { q: 'one', api_key: 'another' })).json()).toEqual({
      for: 'one',
    });
    expect((await post(`${url}/v1/chat`, { q: 'three' })).status).toBe(404);
    expect((await post(`${url}/v1/other`, { q: 'one' })).status).toBe(404);
    expect((await fetch(`${url}/v1/chat`)).status).toBe(404);
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
      const body = JSON.parse(text) as { error: { type: string; message: string; method: string } };
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
