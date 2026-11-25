// The failure types from the client's side, over real sockets with Node's own `fetch` and `http` client.
// A slow stream is paced by a clock the test moves by hand; the tests marked «real time» are the only ones
// that wait on the real clock, and say why.

import * as http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { start, type MockServer, type MockTimers } from '../server.js';

let server: MockServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

/** A clock that moves only when the test says so. */
function manualClock() {
  let now = 0;
  let seq = 0;
  const queue = new Map<number, { at: number; fn: () => void }>();
  const timers: MockTimers = {
    now: () => now,
    setTimeout: (fn, ms) => {
      queue.set((seq += 1), { at: now + ms, fn });
      return seq;
    },
    clearTimeout: (handle) => void queue.delete(handle as number),
  };
  return {
    timers,
    pending: () => queue.size,
    advance(ms: number): void {
      const end = now + ms;
      for (;;) {
        const due = [...queue].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (due === undefined) break;
        queue.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = end;
    },
  };
}

/** Lets the event loop turn until `done()` holds: socket I/O is real even where the clock is not. */
async function until(done: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error('the condition never held');
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** One POST with Node's `http` client, on a connection of its own; everything the client observes. */
function send(url: string) {
  const seen = {
    status: undefined as number | undefined,
    headers: {} as http.IncomingHttpHeaders,
    bytes: 0,
    text: '',
    ended: false,
    error: undefined as NodeJS.ErrnoException | undefined,
    closed: false,
  };
  const req = http.request(url, { method: 'POST', agent: false }, (res) => {
    seen.status = res.statusCode;
    seen.headers = res.headers;
    res.on('data', (chunk: Buffer) => {
      seen.bytes += chunk.length;
      seen.text += chunk.toString('utf8');
    });
    res.on('end', () => (seen.ended = true));
    res.on('error', (err) => (seen.error = err));
    res.on('close', () => (seen.closed = true));
  });
  req.on('error', (err) => {
    seen.error ??= err;
    seen.closed = true;
  });
  req.end('{"q":1}');
  return { seen, req, closed: () => until(() => seen.closed) };
}

const post = (url: string) => fetch(url, { method: 'POST', body: '{"q":1}' });
const causeCode = (err: unknown) =>
  ((err as Error).cause as NodeJS.ErrnoException | undefined)?.code;

describe('mock · failures · timeout', () => {
  it('reads the request and never answers; the client gives up on its own', async () => {
    server = await start();
    const scope = server.scope('s', [{ path: '/v1/x', failure: { type: 'timeout' } }]);
    const call = send(`${scope.url}/v1/x`);
    await until(() => scope.journal.length === 1);
    expect(scope.journal[0]).toMatchObject({ matched: true, body: '{"q":1}' });
    // Some turns of the event loop later there is still no response and no error.
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
    expect(call.seen).toMatchObject({ status: undefined, error: undefined, closed: false });
    call.req.destroy();
    await call.closed();
    expect(call.seen.status).toBeUndefined();
    expect(call.seen.error?.code).toBe('ECONNRESET');
    // The server is unharmed: the next request to the scope is held the same way.
    const next = send(`${scope.url}/v1/x`);
    await until(() => scope.journal.length === 2);
    expect(next.seen.closed).toBe(false);
  });

  it('ends when the scope closes: the client sees the connection dropped, with no response', async () => {
    server = await start();
    const scope = server.scope('s', [{ path: '/v1/x', failure: { type: 'timeout' } }]);
    const other = server.scope('other', [{ path: '/v1/x', failure: { type: 'timeout' } }]);
    const held = send(`${scope.url}/v1/x`);
    const untouched = send(`${other.url}/v1/x`);
    await until(() => scope.journal.length === 1 && other.journal.length === 1);
    expect(scope.close()).toEqual([]);
    await held.closed();
    expect(held.seen.status).toBeUndefined();
    expect(held.seen.error?.code).toBe('ECONNRESET');
    // Closing one scope leaves a request held by another alone.
    expect(untouched.seen.closed).toBe(false);
    await server.close();
    await untouched.closed();
    expect(untouched.seen.error?.code).toBe('ECONNRESET');
  });

  it('ends when the server closes, and the port is free again', async () => {
    const closing = await start();
    const scope = closing.scope('s', [{ path: '/v1/x', failure: { type: 'timeout' } }]);
    const pending = post(`${scope.url}/v1/x`);
    const failed = pending.catch((err: unknown) => err);
    await until(() => scope.journal.length === 1);
    await closing.close();
    const err = await failed;
    expect(err).toBeInstanceOf(TypeError);
    expect((err as Error).message).toBe('fetch failed');
    server = await start({ port: closing.port });
  });
});

describe('mock · failures · reset', () => {
  it('resets the connection after the request is read: ECONNRESET, no response', async () => {
    server = await start();
    const scope = server.scope('s', [{ path: '/v1/x', failure: { type: 'reset' } }]);
    const call = send(`${scope.url}/v1/x`);
    await call.closed();
    expect(call.seen.status).toBeUndefined();
    expect(call.seen.error?.code).toBe('ECONNRESET');
    expect(scope.journal).toMatchObject([{ matched: true, body: '{"q":1}' }]);

    const err = await post(`${scope.url}/v1/x`).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TypeError);
    expect((err as Error).message).toBe('fetch failed');
    expect(['ECONNRESET', 'UND_ERR_SOCKET']).toContain(causeCode(err));
  });
});

describe('mock · failures · http_429 and http_500', () => {
  it('answers 429 with retry-after and an error body of the provider shape', async () => {
    server = await start();
    const scope = server.scope('s', [
      { path: '/default', failure: { type: 'http_429' } },
      { path: '/seven', failure: { type: 'http_429', retry_after_seconds: 7 } },
    ]);
    const res = await post(`${scope.url}/default`);
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('1');
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await res.json()).toEqual({
      type: 'error',
      error: {
        type: 'rate_limit_error',
        code: 'rate_limit_exceeded',
        message: 'Rate limit exceeded (stub)',
      },
    });
    expect((await post(`${scope.url}/seven`)).headers.get('retry-after')).toBe('7');
  });

  it('answers 500 with a JSON error body', async () => {
    server = await start();
    const scope = server.scope('s', [{ path: '/v1/x', failure: { type: 'http_500' } }]);
    const res = await post(`${scope.url}/v1/x`);
    expect(res.status).toBe(500);
    expect(res.headers.get('retry-after')).toBeNull();
    expect(await res.json()).toEqual({
      type: 'error',
      error: { type: 'api_error', code: 'internal_error', message: 'Internal server error (stub)' },
    });
  });
});

describe('mock · failures · the first N calls only', () => {
  it('fails twice, then answers: the retry case', async () => {
    server = await start();
    const scope = server.scope('s', [
      { path: '/v1/x', failure: { type: 'http_500', first: 2 }, response: { json: { ok: true } } },
    ]);
    const statuses: number[] = [];
    for (let i = 0; i < 4; i += 1) statuses.push((await post(`${scope.url}/v1/x`)).status);
    expect(statuses).toEqual([500, 500, 200, 200]);
    expect(scope.journal).toHaveLength(4);
  });

  it('counts failed calls in `times`, and works for a dropped connection too', async () => {
    server = await start();
    const scope = server.scope('s', [
      { path: '/v1/x', times: 2, failure: { type: 'reset', first: 1 }, response: { text: 'ok' } },
    ]);
    const first = await post(`${scope.url}/v1/x`).catch((e: unknown) => e);
    expect(first).toBeInstanceOf(TypeError);
    const second = await post(`${scope.url}/v1/x`);
    expect([second.status, await second.text()]).toEqual([200, 'ok']);
    expect((await post(`${scope.url}/v1/x`)).status).toBe(404);
  });
});

describe('mock · failures · slow_stream', () => {
  const body = 'x'.repeat(3000);

  it('has sent exactly rate × time at every moment (clock moved by hand)', async () => {
    const clock = manualClock();
    server = await start({ timers: clock.timers });
    const scope = server.scope('s', [
      {
        path: '/v1/x',
        failure: { type: 'slow_stream', bytes_per_sec: 1000 },
        response: { text: body },
      },
    ]);
    const call = send(`${scope.url}/v1/x`);
    // The head arrives at once, complete, and says how long the body is; no byte of the body yet.
    await until(() => call.seen.status !== undefined);
    expect(call.seen.status).toBe(200);
    expect(call.seen.headers['content-length']).toBe('3000');
    expect(call.seen.bytes).toBe(0);

    clock.advance(1000);
    await until(() => call.seen.bytes >= 1000);
    expect(call.seen.bytes).toBe(1000);
    clock.advance(1250);
    await until(() => call.seen.bytes >= 2250);
    expect(call.seen.bytes).toBe(2250);
    expect(call.seen.ended).toBe(false);

    clock.advance(750);
    await call.closed();
    expect(call.seen).toMatchObject({ bytes: 3000, text: body, ended: true, error: undefined });
    expect(clock.pending()).toBe(0);
  });

  it('paces an event stream the same way and keeps it whole', async () => {
    const clock = manualClock();
    server = await start({ timers: clock.timers });
    const scope = server.scope('s', [
      {
        path: '/v1/x',
        failure: { type: 'slow_stream', bytes_per_sec: 10 },
        response: { sse: ['{"delta":"a"}', '[DONE]'] },
      },
    ]);
    const expected = 'data: {"delta":"a"}\n\ndata: [DONE]\n\n';
    const call = send(`${scope.url}/v1/x`);
    await until(() => call.seen.status !== undefined);
    expect(call.seen.headers['content-type']).toBe('text/event-stream');
    clock.advance(500);
    await until(() => call.seen.bytes >= 5);
    expect(call.seen.text).toBe(expected.slice(0, 5));
    clock.advance(10_000);
    await call.closed();
    expect(call.seen).toMatchObject({ text: expected, ended: true });
  });

  // Real time, about 0.5 s: only a real clock can show that the real timers keep the configured rate.
  it('sends 10 KiB at the configured rate within 20 % (real time)', async () => {
    const bytes = 10 * 1024;
    const rate = 2 * bytes;
    server = await start();
    const scope = server.scope('s', [
      {
        path: '/v1/x',
        failure: { type: 'slow_stream', bytes_per_sec: rate },
        response: { text: 'y'.repeat(bytes) },
      },
    ]);
    const startedAt = performance.now();
    const res = await post(`${scope.url}/v1/x`);
    const received = (await res.arrayBuffer()).byteLength;
    const measured = received / ((performance.now() - startedAt) / 1000);
    expect(received).toBe(bytes);
    expect(measured).toBeGreaterThan(rate * 0.8);
    expect(measured).toBeLessThan(rate * 1.2);
  });

  it.each(['server', 'scope', 'client'] as const)(
    'stops cleanly when the %s ends it midway: no timer left',
    async (who) => {
      const clock = manualClock();
      const closing = await start({ timers: clock.timers });
      const scope = closing.scope('s', [
        {
          path: '/v1/x',
          failure: { type: 'slow_stream', bytes_per_sec: 1000 },
          response: { text: body },
        },
      ]);
      const call = send(`${scope.url}/v1/x`);
      clock.advance(0);
      await until(() => call.seen.status !== undefined);
      clock.advance(500);
      await until(() => call.seen.bytes === 500);
      expect(clock.pending()).toBe(1);

      if (who === 'server') await closing.close();
      else if (who === 'scope') scope.close();
      else call.req.destroy();
      await call.closed();
      await until(() => clock.pending() === 0);
      expect(call.seen.ended).toBe(false);
      expect(call.seen.bytes).toBe(500);
      if (who !== 'client') expect(call.seen.error?.code).toBe('ECONNRESET');

      await closing.close();
      server = await start({ port: closing.port });
    },
  );
});

describe('mock · failures · truncated_json', () => {
  const json = { id: 'msg_1', content: 'Hello John Doe', usage: { input: 3, output: 4 } };
  const full = JSON.stringify(json);
  const half = full.slice(0, Math.floor(full.length / 2));

  it('by default declares the full length and drops the connection after half: the read fails', async () => {
    server = await start();
    const scope = server.scope('s', [
      { path: '/v1/x', failure: { type: 'truncated_json' }, response: { json } },
    ]);
    const call = send(`${scope.url}/v1/x`);
    await call.closed();
    expect(call.seen.status).toBe(200);
    expect(call.seen.headers['content-type']).toBe('application/json');
    expect(call.seen.headers['content-length']).toBe(String(full.length));
    expect(call.seen.text).toBe(half);
    expect(call.seen.ended).toBe(false);
    expect(call.seen.error?.code).toBe('ECONNRESET');

    const res = await post(`${scope.url}/v1/x`);
    expect(res.status).toBe(200);
    await expect(res.json()).rejects.toBeInstanceOf(TypeError);
  });

  it('with content_length: cut declares the half: the response is whole and only parsing fails', async () => {
    server = await start();
    const scope = server.scope('s', [
      {
        path: '/v1/x',
        failure: { type: 'truncated_json', content_length: 'cut' },
        response: { json },
      },
    ]);
    const call = send(`${scope.url}/v1/x`);
    await call.closed();
    expect(call.seen).toMatchObject({ status: 200, text: half, ended: true, error: undefined });
    expect(call.seen.headers['content-length']).toBe(String(half.length));

    const res = await post(`${scope.url}/v1/x`);
    await expect(res.json()).rejects.toBeInstanceOf(SyntaxError);
  });
});
