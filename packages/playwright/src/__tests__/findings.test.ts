import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { FINDINGS_MAX, FINDINGS_TYPE, OMITTED_MAX, createCollector, watch } from '../findings.js';

const T0 = 1_700_000_000_000;

describe('the attachment a reporter reads', () => {
  it('has a content type of its own, beside the metadata one', () => {
    expect(FINDINGS_TYPE).toBe('application/plune.findings+json');
  });

  it('is «collected, nothing found» when nothing happened', () => {
    expect(createCollector(3000).result()).toEqual({ items: [], omitted: 0 });
  });
});

describe('a request is reduced to a method and a path', () => {
  const one = (url: string, method = 'get') => {
    const c = createCollector(3000);
    c.response({ url, method, status: 500, at: T0, durationMs: 12 });
    return c.result();
  };

  it('upper-cases the method and drops the origin, the query and the fragment', () => {
    expect(one('https://shop.example:8443/api/cart?token=secret&x=1#frag')).toEqual({
      items: [
        {
          kind: 'request_failed',
          method: 'GET',
          path: '/api/cart',
          status: 500,
          durationMs: 12,
          at: T0,
        },
      ],
      omitted: 0,
    });
  });

  it('drops and counts a method the contract refuses', () => {
    expect(one('http://h/a', 'm-search')).toEqual({ items: [], omitted: 1 });
    expect(one('http://h/a', 'A'.repeat(17))).toEqual({ items: [], omitted: 1 });
  });

  it('drops and counts a path that starts with two slashes', () => {
    expect(one('http://h//evil.example/x')).toEqual({ items: [], omitted: 1 });
  });

  it('drops and counts a path longer than 300, and keeps one of exactly 300', () => {
    expect(one(`http://h/${'a'.repeat(300)}`)).toEqual({ items: [], omitted: 1 });
    expect(one(`http://h/${'a'.repeat(299)}`).items).toHaveLength(1);
  });

  it('masks a credential that sits in the path', () => {
    const token = ['ghp', 'Zq7Xw2Lp9Rt4Vb6Nm1Kc8Hd3Jf5Gs0Ya2Ue7'].join('_');
    const out = one(`http://h/reset/${token}`);
    expect(JSON.stringify(out)).not.toContain(token);
    expect(out.items).toHaveLength(1);
  });

  it('neither reports nor counts what is not http or https', () => {
    for (const url of [
      'data:text/plain,hi',
      'blob:http://h/1',
      'about:blank',
      'chrome-extension://abc/x.js',
      'not a url',
    ]) {
      expect(one(url)).toEqual({ items: [], omitted: 0 });
    }
  });
});

describe('a text is cleaned before it is kept', () => {
  it('collapses control characters and clips to 300', () => {
    const c = createCollector(3000);
    c.console('one\r\n\ttwo\u0000three\u001b[31m red', T0);
    c.pageError('x'.repeat(400), T0 + 1);
    const [first, second] = c.result().items;
    expect(first).toEqual({ kind: 'console', text: 'one two three red', at: T0 });
    expect(second).toMatchObject({ kind: 'page_error' });
    expect((second as { text: string }).text).toHaveLength(300);
  });

  it('masks a credential and stays within 300', () => {
    const c = createCollector(3000);
    c.console(`${'x'.repeat(280)} GET http://h/a?token=secret-value-1234567890`, T0);
    const text = (c.result().items[0] as { text: string }).text;
    expect(text).not.toContain('secret');
    expect(text.length).toBeLessThanOrEqual(300);
  });

  it('drops and counts a text with nothing left in it', () => {
    const c = createCollector(3000);
    c.console(' \n\t ', T0);
    expect(c.result()).toEqual({ items: [], omitted: 1 });
  });

  it('drops the browser echo of a failed resource load, uncounted', () => {
    const c = createCollector(3000);
    c.console(
      'Failed to load resource: the server responded with a status of 500 (Internal Server Error)',
      T0,
    );
    c.console('Failed to load resource: net::ERR_EMPTY_RESPONSE', T0);
    expect(c.result()).toEqual({ items: [], omitted: 0 });
  });
});

describe('which kind a request becomes', () => {
  const kindOf = (status: number, durationMs: number) => {
    const c = createCollector(3000);
    c.response({ url: 'http://h/a', method: 'POST', status, at: T0, durationMs });
    return c.result().items;
  };

  it('a 4xx and a 5xx are failed, with the status and the duration', () => {
    expect(kindOf(404, 5)).toEqual([
      { kind: 'request_failed', method: 'POST', path: '/a', status: 404, durationMs: 5, at: T0 },
    ]);
    expect(kindOf(503, 5)).toMatchObject([{ kind: 'request_failed', status: 503 }]);
  });

  it('a 2xx at or over the threshold is slow; under it, nothing', () => {
    expect(kindOf(200, 3000)).toEqual([
      { kind: 'request_slow', method: 'POST', path: '/a', status: 200, durationMs: 3000, at: T0 },
    ]);
    expect(kindOf(200, 2999)).toEqual([]);
    expect(kindOf(302, 4000)).toMatchObject([{ kind: 'request_slow', status: 302 }]);
  });

  it('a slow 5xx is failed with its duration, once', () => {
    expect(kindOf(500, 9000.4)).toEqual([
      { kind: 'request_failed', method: 'POST', path: '/a', status: 500, durationMs: 9000, at: T0 },
    ]);
  });

  it('a request with no answer is failed, with no status and no duration', () => {
    const c = createCollector(3000);
    c.failed({
      url: 'http://h/a?x=1',
      method: 'GET',
      errorText: 'net::ERR_EMPTY_RESPONSE',
      at: T0,
    });
    expect(c.result().items).toEqual([
      { kind: 'request_failed', method: 'GET', path: '/a', at: T0 },
    ]);
  });

  it('an aborted request is not a finding and is not counted', () => {
    const c = createCollector(3000);
    c.failed({ url: 'http://h/a', method: 'GET', errorText: 'net::ERR_ABORTED', at: T0 });
    expect(c.result()).toEqual({ items: [], omitted: 0 });
  });
});

describe('the limit', () => {
  it('keeps the first 20 by time, whatever order they arrived in, and counts the rest', () => {
    const c = createCollector(3000);
    for (let i = 24; i >= 0; i--) c.console(`line ${i}`, T0 + i);
    const out = c.result();
    expect(FINDINGS_MAX).toBe(20);
    expect(out.omitted).toBe(5);
    expect(out.items.map((f) => f.at)).toEqual(Array.from({ length: 20 }, (_, i) => T0 + i));
  });

  it('never counts past the ceiling', () => {
    const c = createCollector(3000);
    for (let i = 0; i < OMITTED_MAX + 30; i++) c.console('', T0);
    expect(c.result().omitted).toBe(OMITTED_MAX);
  });
});

describe('watch — the listeners on a browser context', () => {
  const request = (
    url: string,
    timing: { startTime: number; responseEnd: number },
    errorText?: string,
  ) => ({
    url: () => url,
    method: () => 'GET',
    timing: () => timing,
    failure: () => (errorText === undefined ? null : { errorText }),
  });
  const response = (req: ReturnType<typeof request>, status: number) => ({
    request: () => req,
    status: () => status,
    finished: () => Promise.resolve(null),
  });
  const settle = () => new Promise((r) => setImmediate(r));

  it('takes only console errors, and page errors by their message', async () => {
    const context = new EventEmitter();
    const c = watch(context, 3000);
    context.emit('console', { type: () => 'log', text: () => 'fine' });
    context.emit('console', { type: () => 'error', text: () => 'bad' });
    context.emit('weberror', { error: () => new Error('boom') });
    expect(c.result().items.map((f) => [f.kind, 'text' in f ? f.text : ''])).toEqual([
      ['console', 'bad'],
      ['page_error', 'boom'],
    ]);
  });

  it('times an answered request from its own start to the end of the response', async () => {
    const context = new EventEmitter();
    const c = watch(context, 100);
    const req = request('http://h/slow', { startTime: T0, responseEnd: 250.6 });
    context.emit('request', req);
    context.emit('response', response(req, 200));
    await settle();
    expect(c.result().items).toEqual([
      { kind: 'request_slow', method: 'GET', path: '/slow', status: 200, durationMs: 251, at: T0 },
    ]);
  });

  it('stamps a request that never answered itself: its timing is empty', async () => {
    const context = new EventEmitter();
    const c = watch(context, 3000);
    const before = Date.now();
    const req = request(
      'http://h/gone',
      { startTime: 0, responseEnd: -1 },
      'net::ERR_EMPTY_RESPONSE',
    );
    context.emit('request', req);
    context.emit('requestfailed', req);
    const [item] = c.result().items;
    expect(item).toMatchObject({ kind: 'request_failed', path: '/gone' });
    expect(item).not.toHaveProperty('durationMs');
    expect(item!.at).toBeGreaterThanOrEqual(before);
  });

  it('reports a request once when it both answered and failed', async () => {
    const context = new EventEmitter();
    const c = watch(context, 3000);
    const req = request(
      'http://h/half',
      { startTime: T0, responseEnd: -1 },
      'net::ERR_CONNECTION_RESET',
    );
    context.emit('request', req);
    context.emit('response', response(req, 500));
    context.emit('requestfailed', req);
    await settle();
    expect(c.result().items).toHaveLength(1);
  });

  it('never throws out of a listener, and never out of a context that cannot be listened to', async () => {
    const context = new EventEmitter();
    const c = watch(context, 3000);
    const bad = () => {
      throw new Error('gone');
    };
    expect(() => context.emit('console', { type: bad, text: bad })).not.toThrow();
    expect(() => context.emit('weberror', { error: bad })).not.toThrow();
    expect(() => context.emit('request', null)).not.toThrow();
    expect(() =>
      context.emit('requestfailed', { url: bad, method: bad, timing: bad, failure: bad }),
    ).not.toThrow();
    context.emit('response', {
      request: bad,
      status: bad,
      finished: () => Promise.reject(new Error('gone')),
    });
    await settle();
    expect(c.result()).toEqual({ items: [], omitted: 0 });
    expect(() => watch({ on: bad }, 3000).result()).not.toThrow();
  });
});
