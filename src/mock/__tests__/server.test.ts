// The stub server from the client's side: every test talks to it over a real socket with Node's own `fetch`.

import { once } from 'node:events';
import { request } from 'node:http';
import { connect } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  JOURNAL_MAX_ENTRIES,
  MAX_CONNECTIONS,
  maskedTextMatches,
  matchesSubset,
  pathMatcher,
  start,
  withServer,
  type MockServer,
} from '../server.js';

let server: MockServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

interface RawAnswer {
  status: number;
  json: unknown;
  text: string;
}

/** One request written byte for byte, as no HTTP client would send it, and all the server sent back. */
function raw(port: number, target: string, method = 'GET'): Promise<RawAnswer> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    let text = '';
    socket.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
    socket.on('error', reject);
    socket.on('close', () => {
      try {
        resolve({
          status: Number(/^HTTP\/1\.1 (\d+)/.exec(text)?.[1]),
          json: JSON.parse(text.slice(text.indexOf('\r\n\r\n') + 4)),
          text,
        });
      } catch {
        reject(new Error(`not an HTTP answer with a JSON body: ${JSON.stringify(text)}`));
      }
    });
    socket.write(
      `${method} ${target} HTTP/1.1\r\nhost: 127.0.0.1:${port}\r\nconnection: close\r\n\r\n`,
    );
  });
}

describe('mock · server · start and close', () => {
  it('listens on 127.0.0.1 and an ephemeral port by default', async () => {
    server = await start();
    expect(server.port).toBeGreaterThan(0);
    expect(server.url).toBe(`http://127.0.0.1:${server.port}`);
  });

  it('releases the port on close: a second server binds it, and close is safe twice', async () => {
    const first = await start();
    const scope = first.scope('a', [{ path: '/v1/x', response: { json: { ok: true } } }]);
    // A kept-alive client connection is open when the server closes.
    expect((await post(`${scope.url}/v1/x`, {})).status).toBe(200);
    await first.close();
    await first.close();
    server = await start({ port: first.port });
    expect(server.port).toBe(first.port);
  });

  it('destroys a socket that is in the middle of a request', async () => {
    const closing = await start();
    const socket = connect(closing.port, '127.0.0.1');
    await once(socket, 'connect');
    socket.write(
      `POST /a/v1/x HTTP/1.1\r\nhost: 127.0.0.1:${closing.port}\r\ncontent-length: 10\r\n\r\nhalf`,
    );
    // The server has the socket once it has read the head; the body never completes.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const closed = once(socket, 'close');
    await closing.close();
    await closed;
    expect(socket.destroyed).toBe(true);
  });

  it('rejects when the port is taken', async () => {
    server = await start();
    await expect(start({ port: server.port })).rejects.toThrow(/EADDRINUSE/);
  });

  it('withServer closes the server when the body throws', async () => {
    let port = 0;
    await expect(
      withServer((s) => {
        port = s.port;
        throw new Error('body failed');
      }),
    ).rejects.toThrow('body failed');
    server = await start({ port });
    expect(await withServer((s) => s.url)).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });
});

describe('mock · server · matching', () => {
  it('matches a method and an exact path, ignoring the query string', async () => {
    server = await start();
    const scope = server.scope('case-1', [
      { path: '/v1/chat/completions', response: { json: { id: 'chat' } } },
      { method: 'get', path: '/v1/models', response: { json: { id: 'models' } } },
    ]);
    const chat = await post(`${scope.url}/v1/chat/completions?api-version=1`, { model: 'm' });
    expect(chat.status).toBe(200);
    expect(chat.headers.get('content-type')).toBe('application/json');
    expect(await chat.json()).toEqual({ id: 'chat' });
    expect(await (await fetch(`${scope.url}/v1/models`)).json()).toEqual({ id: 'models' });
    // The method is part of the match.
    expect((await fetch(`${scope.url}/v1/chat/completions`)).status).toBe(404);
    expect((await post(`${scope.url}/v1/chat/completions/extra`, {})).status).toBe(404);
  });

  it('matches `*` inside one segment and `**` across segments', async () => {
    server = await start();
    const scope = server.scope('s', [
      { path: '/deployments/*/chat/completions', response: { json: { via: 'segment' } } },
      { path: '/v1beta/models/*:generate', response: { json: { via: 'suffix' } } },
      { path: '/v1/**', response: { json: { via: 'prefix' } } },
    ]);
    const via = async (path: string) => {
      const res = await post(`${scope.url}${path}`, {});
      return res.status === 200 ? ((await res.json()) as { via: string }).via : res.status;
    };
    expect(await via('/deployments/my-model/chat/completions')).toBe('segment');
    expect(await via('/deployments/a/b/chat/completions')).toBe(404);
    expect(await via('/v1beta/models/small-1.5:generate')).toBe('suffix');
    expect(await via('/v1/messages')).toBe('prefix');
    expect(await via('/v1/chat/completions')).toBe('prefix');
    // A dot in a path is a dot, not «any character».
    expect(await via('/v1betaXmodels/a:generate')).toBe(404);
  });

  it('matches a JSON subset of the body', async () => {
    server = await start();
    const scope = server.scope('s', [
      {
        path: '/v1/messages',
        body: { model: 'small', messages: [{ role: 'user' }], options: { stream: false } },
        response: { json: { for: 'small' } },
      },
      { path: '/v1/messages', response: { json: { for: 'any' } } },
    ]);
    const ask = async (body: unknown) =>
      ((await (await post(`${scope.url}/v1/messages`, body)).json()) as { for: string }).for;
    const full = {
      model: 'small',
      max_tokens: 5,
      messages: [{ role: 'user', content: 'hi' }],
      options: { stream: false, seed: 1 },
    };
    expect(await ask(full)).toBe('small');
    expect(await ask({ ...full, model: 'large' })).toBe('any');
    // An array matches whole: one more message is another request.
    expect(
      await ask({ ...full, messages: [...full.messages, { role: 'user', content: 'more' }] }),
    ).toBe('any');
    expect(await ask({ ...full, options: { seed: 1 } })).toBe('any');
    // A body that is not JSON matches no stub with a `body`.
    const raw = await fetch(`${scope.url}/v1/messages`, { method: 'POST', body: 'not json' });
    expect(await raw.json()).toEqual({ for: 'any' });
  });

  it('compares subsets by value, type and array length', () => {
    expect(matchesSubset({ a: null }, { a: null, b: 1 })).toBe(true);
    expect(matchesSubset({ a: 1 }, { a: '1' })).toBe(false);
    expect(matchesSubset({ a: {} }, { a: [] })).toBe(false);
    expect(matchesSubset({ a: {} }, { a: null })).toBe(false);
    expect(matchesSubset([1], [1, 2])).toBe(false);
    expect(matchesSubset([1], { 0: 1 })).toBe(false);
    expect(matchesSubset({ a: 1 }, 'text')).toBe(false);
    expect(matchesSubset({ a: 1 }, {})).toBe(false);
  });

  it('answers once, N times or always, then lets the next stub answer', async () => {
    server = await start();
    const scope = server.scope('s', [
      { path: '/v1/x', times: 'once', response: { json: { n: 'first' } } },
      { path: '/v1/x', times: 2, response: { json: { n: 'second' } } },
      { path: '/v1/x', response: { json: { n: 'rest' } } },
    ]);
    const seen: string[] = [];
    for (let i = 0; i < 5; i += 1)
      seen.push(((await (await post(`${scope.url}/v1/x`, {})).json()) as { n: string }).n);
    expect(seen).toEqual(['first', 'second', 'second', 'rest', 'rest']);
  });

  it('sends a status, headers, text and a stream of server-sent events', async () => {
    server = await start();
    const scope = server.scope('s', [
      {
        path: '/text',
        response: { status: 201, headers: { 'X-Request-Id': 'r-1' }, text: 'héllo' },
      },
      {
        path: '/sse',
        response: {
          sse: [
            '{"delta":"a"}',
            { event: 'message_stop', data: { type: 'message_stop' } },
            '[DONE]',
          ],
        },
      },
      { path: '/empty', response: { status: 204 } },
    ]);
    const text = await post(`${scope.url}/text`, {});
    expect(text.status).toBe(201);
    expect(text.headers.get('x-request-id')).toBe('r-1');
    expect(text.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(text.headers.get('content-length')).toBe('6');
    expect(await text.text()).toBe('héllo');

    const sse = await post(`${scope.url}/sse`, {});
    expect(sse.headers.get('content-type')).toBe('text/event-stream');
    expect(sse.headers.get('content-length')).toBeNull();
    expect(await sse.text()).toBe(
      'data: {"delta":"a"}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\ndata: [DONE]\n\n',
    );

    const empty = await post(`${scope.url}/empty`, {});
    expect(empty.status).toBe(204);
    expect(await empty.text()).toBe('');
  });

  it('refuses a stub that is not valid, naming the field', async () => {
    server = await start();
    const scope = server.scope('s');
    expect(() => scope.add({ path: 'v1/x', response: {} })).toThrow(/path: must start with "\/"/);
    expect(() => scope.add({ path: '/x', response: { json: {}, text: 'both' } })).toThrow(
      /response\.text: give one body/,
    );
  });

  it('refuses a header Node would not send when the stub is added, not at the first request', async () => {
    server = await start();
    const scope = server.scope('s');
    expect(() =>
      scope.add({ path: '/x', response: { headers: { 'x-a': 'v\r\nset-cookie: z=1' } } }),
    ).toThrow(/response\.headers\.x-a: not a valid header value/);
    expect(() => scope.add({ path: '/x', response: { headers: { 'bad name': 'v' } } })).toThrow(
      /response\.headers\.bad name: not a valid header name/,
    );
    expect((await post(`${scope.url}/x`, {})).status).toBe(404);
  });

  it.each([
    ['/v1/chat/completions', '/v1/chat/completions', true],
    ['/v1/chat/completions', '/v1/chat/completions/extra', false],
    ['/deployments/*/chat', '/deployments/my-model/chat', true],
    ['/deployments/*/chat', '/deployments//chat', true],
    ['/deployments/*/chat', '/deployments/a/b/chat', false],
    ['/models/*:generate', '/models/small-1.5:generate', true],
    ['/models/*:generate', '/models/a/b:generate', false],
    ['/v1/**', '/v1/', true],
    ['/v1/**', '/v1/a/b/c', true],
    ['/v1/**', '/v1', false],
    ['/**/x', '/a/b/x', true],
    ['/**/x', '/x', false],
    ['/a.b', '/aXb', false],
    ['/a+(b)[c]{d}|^$', '/a+(b)[c]{d}|^$', true],
    ['/***', '/a/b', true],
    ['/*', '/', true],
    ['/*', '/a/b', false],
  ])('pattern %s against %s: %s', (pattern, path, expected) => {
    expect(pathMatcher(pattern)(path)).toBe(expected);
  });

  it('matches in time linear in the path, whatever the pattern', () => {
    const matches = pathMatcher(`/${'**/'.repeat(12)}x`);
    const startedAt = performance.now();
    expect(matches(`/${'a/'.repeat(40)}y`)).toBe(false);
    expect(matches(`/${'a/'.repeat(40)}x`)).toBe(true);
    expect(performance.now() - startedAt).toBeLessThan(1000);
  });
});

describe('mock · server · scopes', () => {
  it('keeps two scopes apart while their requests interleave', async () => {
    server = await start();
    const a = server.scope('case-a', [{ path: '/v1/messages', response: { json: { from: 'a' } } }]);
    const b = server.scope('case-b', [
      { path: '/v1/messages', response: { json: { from: 'b' } } },
      { path: '/v1/only-b', response: { json: { from: 'b' } } },
    ]);
    const calls = await Promise.all(
      Array.from({ length: 20 }, async (_, i) => {
        const scope = i % 2 === 0 ? a : b;
        const res = await post(`${scope.url}/v1/messages`, { i });
        return [scope.name, ((await res.json()) as { from: string }).from];
      }),
    );
    for (const [name, from] of calls) expect(`case-${from}`).toBe(name);
    // A stub of scope B does not answer a request of scope A.
    expect((await post(`${a.url}/v1/only-b`, {})).status).toBe(404);
    expect(a.journal).toHaveLength(11);
    expect(b.journal).toHaveLength(10);
    expect(a.journal.every((e) => e.scope === 'case-a')).toBe(true);
    expect(b.journal.map((e) => (JSON.parse(e.body) as { i: number }).i % 2)).toEqual(
      Array(10).fill(1),
    );
  });

  it('reports the stubs never called when a scope closes, and removes the scope', async () => {
    server = await start();
    const scope = server.scope('s', [
      { path: '/used', response: { json: 1 } },
      { path: '/unused', times: 'once', response: { json: 2 } },
    ]);
    await post(`${scope.url}/used`, {});
    expect(scope.close().map((s) => s.path)).toEqual(['/unused']);
    expect(scope.close()).toEqual([]);
    expect((await post(`${scope.url}/used`, {})).status).toBe(404);
    expect(server.unrouted).toHaveLength(1);
    // The name is free again, and the new scope starts empty.
    expect(server.scope('s').journal).toEqual([]);
  });

  it('refuses a scope name that is open or cannot be a path segment', async () => {
    server = await start();
    server.scope('s');
    expect(() => server!.scope('s')).toThrow(/already open/);
    for (const name of ['a/b', '', '.', '..', 'a%2fb', 'a?b', 'a#b', 'a b'])
      expect(() => server!.scope(name), name).toThrow(/Bad scope name/);
    expect(server.scope('v1.2_a-b').name).toBe('v1.2_a-b');
  });

  it('refuses a new scope once the server is closed', async () => {
    const closed = await start();
    await closed.close();
    expect(() => closed.scope('s')).toThrow(/closed/);
  });
});

describe('mock · server · a request no stub matches', () => {
  it('gets a 404 JSON answer naming the method and the scope, and is recorded', async () => {
    server = await start();
    const scope = server.scope('case-1', [{ path: '/v1/messages', response: { json: {} } }]);
    const res = await post(`${scope.url}/v1/other?x=1`, { q: 1 });
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await res.json()).toEqual({
      error: {
        type: 'mock_no_stub',
        message:
          'No stub matches this POST request in scope "case-1": compare its path and body in the journal of the scope with the stubs',
        method: 'POST',
        scope: 'case-1',
      },
    });
    expect(scope.journal).toMatchObject([
      { path: '/v1/other', query: 'x=1', matched: false, body: '{"q":1}' },
    ]);
  });

  it('records a request that names no open scope on the server', async () => {
    server = await start();
    for (const path of ['/nobody/v1/messages', '/']) {
      const res = await fetch(`${server.url}${path}`);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({
        error: {
          type: 'mock_no_stub',
          message: 'No open scope for this GET request: the first path segment names the scope',
          method: 'GET',
        },
      });
    }
    expect(server.unrouted.map((e) => [e.scope, e.method, e.path])).toEqual([
      ['nobody', 'GET', '/v1/messages'],
      ['', 'GET', '/'],
    ]);
  });
});

describe('mock · server · a malformed request', () => {
  it('answers 400 to a target no URL parser accepts, records it and stays up', async () => {
    server = await start();
    const scope = server.scope('s', [{ method: 'get', path: '/x', response: { json: {} } }]);
    const bad = await raw(server.port, '//[');
    expect(bad.status).toBe(400);
    expect(bad.json).toEqual({
      error: {
        type: 'mock_bad_target',
        message: 'Bad request target: it starts with "/<scope>" and holds no "." or ".." segment',
        method: 'GET',
      },
    });
    expect(server.unrouted).toMatchObject([{ scope: '', method: 'GET', matched: false }]);
    expect((await fetch(`${scope.url}/x`)).status).toBe(200);
  });

  it.each([
    '/a/../b/x',
    '//evil/b/x',
    '//b/x',
    '/b/./x',
    '/b/x/..',
    '/b/%2e%2e/x',
    '/b/x/%2E',
    '/./b/x',
    '/../b/x',
    'http://local/b/x',
    '/b/../x?q=1',
  ])('refuses %s instead of taking it to another scope', async (target) => {
    server = await start();
    const a = server.scope('a', [{ method: 'get', path: '/**', response: { json: {} } }]);
    const b = server.scope('b', [{ method: 'get', path: '/**', response: { json: {} } }]);
    expect((await raw(server.port, target)).status).toBe(400);
    expect([a.journal.length, b.journal.length, server.unrouted.length]).toEqual([0, 0, 1]);
    // The scope is read from the target as written.
    expect((await raw(server.port, '/b/x')).status).toBe(200);
    expect((await raw(server.port, '/b//x')).status).toBe(200);
    expect([a.journal.length, b.journal.length]).toEqual([0, 2]);
  });
});

describe('mock · server · limits', () => {
  it('keeps the newest entries of a journal and counts the dropped ones', async () => {
    server = await start();
    const scope = server.scope('s', [{ method: 'get', path: '/x', response: { json: {} } }]);
    expect([scope.dropped, server.unroutedDropped]).toEqual([0, 0]);
    for (let i = 0; i < JOURNAL_MAX_ENTRIES + 5; i += 1) {
      await (await fetch(`${scope.url}/x?i=${i}`)).arrayBuffer();
      if (i < JOURNAL_MAX_ENTRIES + 3)
        await (await fetch(`${server.url}/gone?i=${i}`)).arrayBuffer();
    }
    expect(JOURNAL_MAX_ENTRIES).toBe(1000);
    expect(scope.journal).toHaveLength(JOURNAL_MAX_ENTRIES);
    expect(scope.dropped).toBe(5);
    expect(scope.journal[0]!.query).toBe('i=5');
    expect(scope.journal.at(-1)!.query).toBe(`i=${JOURNAL_MAX_ENTRIES + 4}`);
    expect(server.unrouted).toHaveLength(JOURNAL_MAX_ENTRIES);
    expect(server.unroutedDropped).toBe(3);
    expect(server.unrouted[0]!.query).toBe('i=3');
  }, 60_000);

  it('drops a connection over the limit and takes one again when another closes', async () => {
    server = await start();
    expect(MAX_CONNECTIONS).toBe(256);
    // One after another: a burst of this many at once can overrun the listen queue of the system.
    const sockets = [];
    for (let i = 0; i < MAX_CONNECTIONS; i += 1) {
      const socket = connect(server.port, '127.0.0.1');
      await once(socket, 'connect');
      socket.on('error', () => undefined);
      sockets.push(socket);
    }
    const extra = connect(server.port, '127.0.0.1');
    extra.on('error', () => undefined);
    await once(extra, 'close');
    expect(sockets.every((s) => !s.destroyed)).toBe(true);
    for (const socket of sockets.slice(0, 8)) {
      socket.destroy();
      await once(socket, 'close');
    }
    expect((await fetch(`${server.url}/nobody`)).status).toBe(404);
    for (const socket of sockets) socket.destroy();
  });
});

describe('mock · server · journal', () => {
  // Header names real services use for a credential or a signed request, and query names of the same kind.
  const SECRET_HEADERS = [
    'authorization',
    'proxy-authorization',
    'x-api-key',
    'api-key',
    'cookie',
    'x-auth-token',
    'x-amz-security-token',
    'x-amz-signature',
    'X-Amz-Signature',
    'x-goog-signature',
    'x-hub-signature-256',
    'x-jwt-assertion',
    'x-session-id',
    'x-csrf-token',
    'x-xsrf-sig',
    'x-otp',
    'x-passwd',
    'x-pwd',
    'x-client-secret',
    'x-access-code',
  ];
  const SECRET_QUERY = [
    'key',
    'api_key',
    'access_token',
    'sig',
    'signature',
    'X-Amz-Signature',
    'jwt',
    'session',
    'csrf',
    'passwd',
    'pwd',
    'otp',
    'code',
    'client_assertion',
  ];

  it.each(SECRET_HEADERS)('masks the header %s', async (name) => {
    server = await start();
    const scope = server.scope('s', [{ path: '/x', response: { json: {} } }]);
    await post(`${scope.url}/x`, {}, { [name]: 'SECRET-0123456789', 'x-request-id': 'visible' });
    await post(`${server.url}/gone/x`, {}, { [name]: 'SECRET-0123456789' });
    expect(scope.journal[0]!.headers).toMatchObject({
      [name.toLowerCase()]: '[masked]',
      'x-request-id': 'visible',
      'content-type': 'application/json',
    });
    expect(server.unrouted[0]!.headers[name.toLowerCase()]).toBe('[masked]');
  });

  it.each(SECRET_QUERY)('masks the query parameter %s', async (name) => {
    server = await start();
    const scope = server.scope('s', [{ path: '/x', response: { json: {} } }]);
    await post(`${scope.url}/x?${name}=SECRET-0123456789&v=2`, {});
    expect(scope.journal[0]!.query).toBe(`${name}=[masked]&v=2`);
  });

  it('echoes nothing of the request target in an answer to a request it cannot serve', async () => {
    server = await start();
    const scope = server.scope('s', [{ path: '/v1/messages', response: { json: {} } }]);
    const texts = [
      await (await post(`${scope.url}/v1/SECRET-in-path?note=SECRET-in-query`, {})).text(),
      await (await post(`${server.url}/SECRET-scope/v1/SECRET-in-path?note=SECRET`, {})).text(),
      (await raw(server.port, '/s/../SECRET-in-path?note=SECRET')).text,
    ];
    expect(texts.join(' ')).not.toContain('SECRET');
    expect(texts.join(' ')).not.toContain('note');
    // The journal is where the path is: it keeps paths and bodies as they came.
    expect(scope.journal[0]).toMatchObject({ path: '/v1/SECRET-in-path', matched: false });
  });

  it('never keeps a secret sent in a header or in the query, nor shows it in an error', async () => {
    server = await start();
    const scope = server.scope('s', [{ path: '/v1/messages', response: { json: {} } }]);
    const secret = 'sk-SECRET-0123456789';
    const headers = {
      authorization: `Bearer ${secret}`,
      'x-api-key': secret,
      'api-key': secret,
      cookie: `session=${secret}`,
      'x-request-id': 'visible',
    };
    const ok = await post(`${scope.url}/v1/messages?key=${secret}&v=2`, { a: 1 }, headers);
    const refused = await post(`${scope.url}/v1/none?key=${secret}`, {}, headers);
    const stray = await post(`${server.url}/gone/v1/none?key=${secret}`, {}, headers);
    const texts = [await ok.text(), await refused.text(), await stray.text()];
    expect(refused.status).toBe(404);
    expect(stray.status).toBe(404);

    expect(scope.journal).toHaveLength(2);
    expect(scope.journal[0]).toMatchObject({
      method: 'POST',
      path: '/v1/messages',
      query: 'key=[masked]&v=2',
      matched: true,
      body: '{"a":1}',
      bodyTruncated: false,
    });
    expect(scope.journal[0]!.headers).toMatchObject({
      authorization: '[masked]',
      'x-api-key': '[masked]',
      'api-key': '[masked]',
      cookie: '[masked]',
      'x-request-id': 'visible',
      'content-type': 'application/json',
    });
    expect(JSON.stringify([scope.journal, server.unrouted, texts])).not.toContain('SECRET');
  });

  it('keeps a body up to the cap and says when it was cut', async () => {
    server = await start({ journalBodyCap: 10 });
    const scope = server.scope('s', [
      { path: '/x', body: { tail: 'end' }, response: { json: {} } },
    ]);
    // The match reads the whole body; only the journal is capped.
    expect((await post(`${scope.url}/x`, { pad: 'x'.repeat(100), tail: 'end' })).status).toBe(200);
    expect(scope.journal[0]).toMatchObject({
      body: '{"pad":"xx',
      bodyTruncated: true,
      matched: true,
    });
  });

  it('answers 413 to a body over 16 MiB without keeping it', async () => {
    server = await start();
    const scope = server.scope('s', [{ path: '/x', response: { json: {} } }]);
    const res = await fetch(`${scope.url}/x`, {
      method: 'POST',
      body: Buffer.alloc(16 * 1024 * 1024 + 1),
    });
    expect(res.status).toBe(413);
    expect(scope.journal).toEqual([]);
  });
});

describe('mock · server · exact stubs', () => {
  const answerOf = async (url: string, body: unknown): Promise<unknown> => {
    const res = await post(url, body);
    return res.status === 200 ? ((await res.json()) as { is: string }).is : res.status;
  };

  it('matches the whole body: a request with one more key is another request', async () => {
    server = await start();
    const scope = server.scope('s', [
      { path: '/c', match: 'exact', body: { model: 'm' }, response: { json: { is: 'plain' } } },
      {
        path: '/c',
        match: 'exact',
        body: { model: 'm', stream: true },
        response: { json: { is: 'stream' } },
      },
      { path: '/c', match: 'exact', body: {}, response: { json: { is: 'empty' } } },
      { path: '/c', match: 'exact', response: { json: { is: 'no json' } } },
    ]);
    expect(await answerOf(`${scope.url}/c`, { model: 'm', stream: true })).toBe('stream');
    expect(await answerOf(`${scope.url}/c`, { model: 'm' })).toBe('plain');
    expect(await answerOf(`${scope.url}/c`, {})).toBe('empty');
    expect(await answerOf(`${scope.url}/c`, { model: 'zzz' })).toBe(404);
    expect(await answerOf(`${scope.url}/c`, { model: 'm', stream: false })).toBe(404);
    const bare = await fetch(`${scope.url}/c`, { method: 'POST', body: 'not json' });
    expect(((await bare.json()) as { is: string }).is).toBe('no json');
  });

  it('reads [masked] as any text in a string or the path, and alone as any value that is there', async () => {
    server = await start();
    const scope = server.scope('s', [
      {
        path: '/keys/[masked]/chat',
        match: 'exact',
        body: { api_key: '[masked]', note: 'my key is [masked], keep it', n: [1, 2] },
        response: { json: { is: 'masked' } },
      },
    ]);
    const url = `${scope.url}/keys/abc/chat`;
    const note = 'my key is k1, keep it';
    expect(await answerOf(url, { api_key: 'k1', note, n: [1, 2] })).toBe('masked');
    expect(await answerOf(url, { api_key: 7, note: 'my key is , keep it', n: [1, 2] })).toBe(
      'masked',
    );
    expect(await answerOf(url, { note, n: [1, 2] })).toBe(404);
    expect(await answerOf(url, { api_key: 'k1', note: 'my key was k1, keep it', n: [1, 2] })).toBe(
      404,
    );
    expect(await answerOf(url, { api_key: 'k1', note, n: [1] })).toBe(404);
    expect(await answerOf(`${scope.url}/keys/abc/other`, { api_key: 'k1', note, n: [1, 2] })).toBe(
      404,
    );
  });

  it('takes * in the path of an exact stub as a character', async () => {
    server = await start();
    const scope = server.scope('s', [
      { path: '/files/*/x', match: 'exact', body: {}, response: { json: { is: 'star' } } },
    ]);
    expect(await answerOf(`${scope.url}/files/abc/x`, {})).toBe(404);
    expect(await answerOf(`${scope.url}/files/*/x`, {})).toBe('star');
  });

  it.each([
    ['a[masked]c', 'abc', true],
    ['a[masked]c', 'ac', true],
    ['a[masked]c', 'abd', false],
    ['[masked]', '', true],
    ['a[masked]b[masked]c', 'a1b2c', true],
    ['a[masked]b[masked]c', 'a1c', false],
    ['ab[masked]ba', 'aba', false],
    ['plain', 'plain', true],
    ['plain', 'plain2', false],
  ])('maskedTextMatches(%j, %j) is %s', (expected, actual, result) => {
    expect(maskedTextMatches(expected, actual)).toBe(result);
  });
});

describe('mock · server · only local requests', () => {
  const stubs = [{ method: 'GET', path: '/x', response: { json: { ok: true } } }];
  interface Got {
    status: number;
    headers: Record<string, unknown>;
    body: string;
  }
  const get = (port: number, headers: Record<string, string>) =>
    new Promise<Got>((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port, path: '/s/x', method: 'GET', headers, agent: false },
        (res) => {
          let body = '';
          res.on('data', (c: Buffer) => (body += c.toString('utf8')));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
        },
      );
      req.on('error', reject);
      req.end();
    });

  it('serves a request addressed by a loopback name and the port of the server', async () => {
    server = await start();
    const { port } = server;
    server.scope('s', stubs);
    for (const name of ['127.0.0.1', 'localhost', '[::1]', 'LOCALHOST'])
      expect((await get(port, { host: `${name}:${port}` })).status).toBe(200);
    const sameOrigin = { host: `127.0.0.1:${port}`, origin: `http://localhost:${port}` };
    expect((await get(port, sameOrigin)).status).toBe(200);
    // What a browser sends for a request of the page itself, and for an address typed by the user.
    for (const site of ['same-origin', 'none', 'Same-Origin', 'None'])
      expect((await get(port, { host: `127.0.0.1:${port}`, 'sec-fetch-site': site })).status).toBe(
        200,
      );
  });

  it.each([
    ['another name', (port: number) => ({ host: `evil.example:${port}` })],
    ['another port', (port: number) => ({ host: `127.0.0.1:${port + 1}` })],
    ['no port', () => ({ host: '127.0.0.1' })],
    [
      'a page of another origin',
      (port: number) => ({ host: `127.0.0.1:${port}`, origin: 'https://evil.example' }),
    ],
    ['an opaque origin', (port: number) => ({ host: `127.0.0.1:${port}`, origin: 'null' })],
    // A browser sends no Origin with a plain GET (an image, a link), and still says where it came from.
    [
      'a request a browser marked as cross-site, with no Origin',
      (port: number) => ({ host: `127.0.0.1:${port}`, 'sec-fetch-site': 'cross-site' }),
    ],
    [
      'a request a browser marked as same-site, with no Origin',
      (port: number) => ({ host: `127.0.0.1:${port}`, 'sec-fetch-site': 'Same-Site' }),
    ],
    [
      'an empty Sec-Fetch-Site',
      (port: number) => ({ host: `127.0.0.1:${port}`, 'sec-fetch-site': '' }),
    ],
    [
      'a Sec-Fetch-Site value that is not one of the four',
      (port: number) => ({ host: `127.0.0.1:${port}`, 'sec-fetch-site': 'cross-site, none' }),
    ],
  ])('refuses %s with a 403, and no journal sees it', async (_name, headers) => {
    server = await start();
    const scope = server.scope('s', stubs);
    const answer = await get(server.port, headers(server.port));
    expect(answer.status).toBe(403);
    expect(answer.body).toContain('mock_not_local');
    expect(answer.body).toContain('none a browser marks as sent from another origin');
    expect(answer.body).not.toContain('evil');
    expect(scope.journal).toEqual([]);
    expect(server.unrouted).toEqual([]);
  });

  it('sends no CORS header, on an answer or on a refusal', async () => {
    server = await start();
    const { port } = server;
    server.scope('s', stubs);
    const answers = [
      await get(port, { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` }),
      await get(port, { host: `127.0.0.1:${port}`, origin: 'https://evil.example' }),
    ];
    expect(answers.map((a) => a.status)).toEqual([200, 403]);
    for (const answer of answers)
      expect(Object.keys(answer.headers).filter((n) => n.startsWith('access-control'))).toEqual([]);
  });
});
