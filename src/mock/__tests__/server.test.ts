// The stub server from the client's side: every test talks to it over a real socket with Node's own `fetch`.

import { once } from 'node:events';
import { connect } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { matchesSubset, start, withServer, type MockServer } from '../server.js';

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
    socket.write('POST /a/v1/x HTTP/1.1\r\nhost: local\r\ncontent-length: 10\r\n\r\nhalf');
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
    expect(() => server!.scope('a/b')).toThrow(/Bad scope name/);
    expect(() => server!.scope('')).toThrow(/Bad scope name/);
  });
});

describe('mock · server · a request no stub matches', () => {
  it('gets a 404 JSON answer naming the method, the path and the scope, and is recorded', async () => {
    server = await start();
    const scope = server.scope('case-1', [{ path: '/v1/messages', response: { json: {} } }]);
    const res = await post(`${scope.url}/v1/other?x=1`, { q: 1 });
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await res.json()).toEqual({
      error: {
        type: 'mock_no_stub',
        message: 'No stub matches POST /v1/other in scope "case-1"',
        method: 'POST',
        path: '/v1/other',
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
      expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(
        /No open scope/,
      );
    }
    expect(server.unrouted.map((e) => [e.scope, e.method, e.path])).toEqual([
      ['nobody', 'GET', '/v1/messages'],
      ['', 'GET', '/'],
    ]);
  });
});

describe('mock · server · journal', () => {
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
