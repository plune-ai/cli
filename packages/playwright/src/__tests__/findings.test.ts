import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  FINDINGS_MAX,
  FINDINGS_TYPE,
  OMITTED_MAX,
  createCollector,
  toWire,
  watch,
} from '../findings.js';

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

  it('does not wait for a response that never ends: what is collected is there at once', async () => {
    const context = new EventEmitter();
    const c = watch(context, 0);
    const req = request('http://h/stream', { startTime: T0, responseEnd: -1 });
    context.emit('request', req);
    context.emit('response', {
      ...response(req, 200),
      finished: () => new Promise(() => undefined),
    });
    await settle();
    expect(c.result()).toEqual({ items: [], omitted: 0 });
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

describe('toWire — what the reporter sends of an attachment', () => {
  const STEPS = [
    { title: 'open the shop', start: T0, end: T0 + 100 },
    { title: 'load the cart', start: T0 + 100, end: T0 + 300 },
    { title: 'pay', start: T0 + 500, end: T0 + 600 },
  ];
  const at = (time: number) =>
    toWire({ items: [{ kind: 'console', text: 'x', at: time }], omitted: 0 }, STEPS)?.items[0];

  it('gives a finding the top-level step its time falls in: the start is in, the end is out', () => {
    expect(at(T0)).toEqual({
      kind: 'console',
      text: 'x',
      step: { index: 1, title: 'open the shop' },
    });
    expect(at(T0 + 99.9)).toMatchObject({ step: { index: 1 } });
    // Two steps share the millisecond: it is the later one's.
    expect(at(T0 + 100)).toMatchObject({ step: { index: 2, title: 'load the cart' } });
    expect(at(T0 + 599)).toMatchObject({ step: { index: 3 } });
  });

  it('gives no step before the first, between two, at the end of the last, or with no steps at all', () => {
    for (const time of [T0 - 1, T0 + 300, T0 + 400, T0 + 600]) {
      expect(at(time)).toEqual({ kind: 'console', text: 'x' });
    }
    expect(toWire({ items: [{ kind: 'console', text: 'x', at: T0 }], omitted: 0 }, [])).toEqual({
      items: [{ kind: 'console', text: 'x' }],
      omitted: 0,
    });
  });

  it('clips a step title to 300 and leaves out a step with no title', () => {
    const long = [{ title: 'y'.repeat(400), start: T0, end: T0 + 1 }];
    const wire = toWire({ items: [{ kind: 'console', text: 'x', at: T0 }], omitted: 0 }, long);
    expect((wire?.items[0] as { step: { title: string } }).step.title).toHaveLength(300);
    const untitled = [{ title: '', start: T0, end: T0 + 1 }];
    expect(
      toWire({ items: [{ kind: 'console', text: 'x', at: T0 }], omitted: 0 }, untitled)?.items[0],
    ).toEqual({ kind: 'console', text: 'x' });
  });

  it('sends only the keys of the contract: no time, nothing a newer fixture added', () => {
    const wire = toWire(
      {
        items: [
          {
            kind: 'request_failed',
            method: 'GET',
            path: '/a',
            status: 500,
            durationMs: 7,
            at: T0,
            headers: { a: 'b' },
          },
          { kind: 'request_failed', method: 'POST', path: '/b', at: T0 },
          { kind: 'page_error', text: 'boom', at: T0, stack: 'at x' },
        ],
        omitted: 2,
        extra: true,
      },
      [],
    );
    expect(wire).toEqual({
      items: [
        { kind: 'request_failed', method: 'GET', path: '/a', status: 500, durationMs: 7 },
        { kind: 'request_failed', method: 'POST', path: '/b' },
        { kind: 'page_error', text: 'boom' },
      ],
      omitted: 2,
    });
  });

  it('drops and counts every item that would refuse the batch', () => {
    const bad = [
      { kind: 'other', text: 'x', at: T0 },
      { kind: 'console', text: '', at: T0 },
      { kind: 'console', text: 'x'.repeat(301), at: T0 },
      { kind: 'console', text: 7, at: T0 },
      { kind: 'console', text: 'x' },
      { kind: 'request_failed', method: 'get', path: '/a', at: T0 },
      { kind: 'request_failed', method: 'GET', path: '/a?b=1', at: T0 },
      { kind: 'request_failed', method: 'GET', path: '//h/a', at: T0 },
      { kind: 'request_failed', method: 'GET', path: `/${'a'.repeat(300)}`, at: T0 },
      { kind: 'request_failed', method: 'GET', path: '/a', status: 99, at: T0 },
      { kind: 'request_slow', method: 'GET', path: '/a', durationMs: -1, at: T0 },
      { kind: 'request_slow', method: 'GET', path: '/a', durationMs: 1.5, at: T0 },
      null,
      'console',
    ];
    expect(
      toWire({ items: [...bad, { kind: 'console', text: 'ok', at: T0 }], omitted: 1 }, []),
    ).toEqual({
      items: [{ kind: 'console', text: 'ok' }],
      omitted: bad.length + 1,
    });
  });

  it('sends the first 20 and counts the rest, never past the ceiling', () => {
    const items = Array.from({ length: 23 }, (_, i) => ({
      kind: 'console',
      text: `line ${i}`,
      at: T0 + i,
    }));
    const wire = toWire({ items, omitted: 4 }, []);
    expect(wire?.items).toHaveLength(20);
    expect(wire?.items[19]).toEqual({ kind: 'console', text: 'line 19' });
    expect(wire?.omitted).toBe(7);
    expect(toWire({ items, omitted: OMITTED_MAX }, [])?.omitted).toBe(OMITTED_MAX);
  });

  it('reads a count that is no count as zero', () => {
    for (const omitted of [-1, 1.5, '3', null, undefined]) {
      expect(toWire({ items: [], omitted }, [])).toEqual({ items: [], omitted: 0 });
    }
  });

  it('says nothing for what is not the attachment', () => {
    for (const raw of [null, undefined, 'x', 7, [], { items: 'x', omitted: 0 }, { omitted: 0 }]) {
      expect(toWire(raw, [])).toBeUndefined();
    }
  });
});

describe('an address inside a text keeps its host and path, and nothing after them', () => {
  const said = (raw: string): string => {
    const c = createCollector(3000);
    c.console(raw, T0);
    c.pageError(raw, T0 + 1);
    const [first, second] = c.result().items as { text: string }[];
    expect(second?.text).toBe(first?.text);
    return first?.text ?? '';
  };

  it('cuts the query of an absolute address', () => {
    expect(said('GET https://api.x/y?email=anna@x.io&id=5 failed')).toBe(
      'GET https://api.x/y failed',
    );
    expect(said('ws closed wss://h/socket?session=abc')).toBe('ws closed wss://h/socket');
    expect(said('no path http://h?x=1')).toBe('no path http://h');
  });

  it('cuts every address of a text, each at its own mark', () => {
    expect(said('a http://h/a?x=1 then https://h2/b#frag and http://h3/c?y=2#z end')).toBe(
      'a http://h/a then https://h2/b and http://h3/c end',
    );
  });

  it('cuts to the end of the address, the punctuation after it too', () => {
    expect(said('failed: https://h/a?x=1.')).toBe('failed: https://h/a');
    expect(said('at "https://h/a?x=1", line 3')).toBe('at "https://h/a", line 3');
  });

  it('cuts a fragment, which can hold a token as well', () => {
    expect(said('redirected to https://h/cb#access_token=abc123')).toBe(
      'redirected to https://h/cb',
    );
  });

  it('removes the user and the password of an address', () => {
    expect(said('proxy https://anna:hunter2@h/x refused')).toBe('proxy https://h/x refused');
    expect(said('mail the owner of https://h/users/anna@x.io')).toBe(
      'mail the owner of https://h/users/anna@x.io',
    );
  });

  it('cuts the query of a path written without its host', () => {
    expect(said('widget broke at /api/widget?token=secret')).toBe('widget broke at /api/widget');
    expect(said('load("/api/cart?id=5&email=a@b.c") failed')).toBe('load("/api/cart") failed');
  });

  it('leaves alone a question mark that is no address', () => {
    for (const plain of [
      'what? no',
      'ready?yes',
      'and/or? maybe',
      'a/b?c',
      'is 3 > 2 ? yes : no',
    ]) {
      expect(said(plain)).toBe(plain);
    }
  });
});

describe('a step title at the cut', () => {
  it('is not left with half of a character pair', () => {
    const steps = [{ title: `${'y'.repeat(299)}\u{1F600}`, start: T0, end: T0 + 1 }];
    const wire = toWire({ items: [{ kind: 'console', text: 'x', at: T0 }], omitted: 0 }, steps);
    expect((wire?.items[0] as { step: { title: string } }).step.title).toBe('y'.repeat(299));
  });
});

describe('a text is cleaned in an order that loses nothing to an earlier step', () => {
  const said = (raw: string): string => {
    const c = createCollector(3000);
    c.console(raw, T0);
    return (c.result().items[0] as { text: string } | undefined)?.text ?? '';
  };

  it('masks a header written on a line of its own, before the lines are joined', () => {
    expect(said('request failed\nCookie: sid=abc123')).toBe('request failed Cookie: ‹header›');
    const later = said('request failed\nGET /cart\nAuthorization: Zm9vOmJhcg==\nbye');
    expect(later).not.toContain('Zm9vOmJhcg');
    expect(later).toContain('request failed GET /cart Authorization:');
  });

  it('cuts a path written without its host at a fragment as well as at a query', () => {
    expect(said('redirected to /cb#access_token=abc123')).toBe('redirected to /cb');
    expect(said('opened /a?x=1#y twice')).toBe('opened /a twice');
    expect(said('href=/a#tok and (/b?c)')).toBe('href=/a and (/b');
  });

  it('leaves alone a number sign and a question mark that are no address', () => {
    for (const plain of ['issue #3 in /docs', 'see #3', 'what? no', 'really?=)', 'a/b#c']) {
      expect(said(plain)).toBe(plain);
    }
  });

  it('cuts a query with a named value wherever its token starts', () => {
    expect(said('GET ./api?x=1 failed')).toBe('GET ./api failed');
    expect(said('GET ../api?x=1 failed')).toBe('GET ../api failed');
    expect(said('GET localhost:3000/a?x=1&y=2 failed')).toBe('GET localhost:3000/a failed');
    expect(said('GET api.x/y?id=5 failed')).toBe('GET api.x/y failed');
    expect(said('load("api.x/y?id=5&mail=a@b.c") failed')).toBe('load("api.x/y") failed');
  });

  it('cleans a megabyte of anything in no time: only the head of a text is ever read', () => {
    const lines = [
      ':/'.repeat(500_000),
      '?a'.repeat(500_000),
      `/${',/x'.repeat(300_000)}`,
      `https://${'a@'.repeat(400_000)}`,
      `${'x'.repeat(999_000)} https://h/a?token=secret`,
      'password = "'.repeat(80_000),
    ];
    const started = performance.now();
    const out = lines.map(said);
    // A wide bound on purpose: the unbounded cleaning took minutes on this input, a loaded runner takes milliseconds.
    expect(performance.now() - started).toBeLessThan(2000);
    for (const text of out) expect(text.length).toBeLessThanOrEqual(300);
    expect(out.join(' ')).not.toContain('secret');
  });

  it('drops the word the working length cut through, so half a credential is never taken for a plain word', () => {
    const token = ['ghp', 'Zq7Xw2Lp9Rt4Vb6Nm1Kc8Hd3Jf5Gs0Ya2Ue7'].join('_');
    // The query is cut away, so the tail of the working text moves into the 300 that are kept.
    const text = said(`/a?x=${'y'.repeat(3970)} ${token}`);
    expect(text).toBe('/a');
  });
});

describe('the word the working length cuts through', () => {
  const token = ['ghp', 'Zq7Xw2Lp9Rt4Vb6Nm1Kc8Hd3Jf5Gs0Ya2Ue7'].join('_');
  const collected = (raw: string) => {
    const c = createCollector(3000);
    c.console(raw, T0);
    return c.result();
  };

  it('is found by the same separators that split the words: a quote ends a word as a space does', () => {
    // The token starts right after the closing quote and the cut falls inside it.
    const out = collected(`"/a?x=${'y'.repeat(3959)}"${token} and more`);
    expect(out.items).toEqual([{ kind: 'console', text: '"/a"', at: T0 }]);
    expect(JSON.stringify(out)).not.toContain('ghp_');
  });

  it('is the whole text when there is no separator before the cut: dropped and counted', () => {
    expect(collected('z'.repeat(5000))).toEqual({ items: [], omitted: 1 });
    expect(collected('z'.repeat(4000)).items).toHaveLength(1);
  });

  it('is no word at all when the cut falls on a separator: the last whole word stays', () => {
    const out = collected(`/a?x=${'y'.repeat(3980)} lastword123456 tail`);
    expect(out.items).toEqual([{ kind: 'console', text: '/a lastword123456', at: T0 }]);
  });
});

describe('the name of a query parameter', () => {
  it('may hold a hyphen, a dot, square brackets and a percent sign', () => {
    const c = createCollector(3000);
    for (const [i, query] of ['?user-id=5', '?a.b=5', '?ids[]=5', '?user%20id=5'].entries()) {
      c.console(`GET api.x/y${query}&z=1 failed`, T0 + i);
    }
    expect(c.result().items.map((f) => (f as { text: string }).text)).toEqual(
      Array.from({ length: 4 }, () => 'GET api.x/y failed'),
    );
  });
});
