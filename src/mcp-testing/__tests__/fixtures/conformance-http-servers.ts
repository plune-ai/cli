// Plain HTTP servers for the conformance tests, on 127.0.0.1 and port 0, written with node:http and no MCP library so
// each behaviour can be broken on its own. `serve` is the legacy (2025-11-25) Streamable HTTP endpoint; `serveHttp`
// wraps modern-server.mjs in the header rules of 2026-07-28. A test closes what it opened with `closeServed`.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Fixture } from './http-servers.js';
// @ts-expect-error a plain .mjs fixture, without types
import { answer } from './modern-server.mjs';

const open: { close(): Promise<void> }[] = [];
export async function closeServed(): Promise<void> {
  for (const s of open.splice(0)) await s.close();
}

export interface Opts {
  /** Session ids by number, or none at all. */
  sessions?: false | ((n: number) => string);
  notification?: 'ok' | 'body' | 'body202' | 'refuse' | number;
  answer?: 'json' | 'text' | 'sse';
  badUtf8?: boolean;
  keepOpen?: boolean;
  eventIds?: 'unique' | 'repeat' | 'none';
  accel?: boolean;
  serverRequest?: boolean;
  wrongId?: boolean;
  /** No session required, no version checked, a DELETE that ends nothing. */
  lax?: boolean;
  get?: 'sse' | 'json' | '405' | number;
  del?: 'ends' | '405' | number;
  /** The status of every refusal (a foreign Origin or Host, no session, an ended one, a bad version) instead of its own: 429, 503... */
  refuse?: number;
  /** Every JSON answer carries the session id of the request in its body, too. */
  echoSession?: boolean;
  /** A `ping` that carries a session is answered with this status: a server whose valid request is refused too. */
  pingStatus?: number;
  /** A `ping` is answered with an SSE stream that sends no event and stays open. */
  silent?: boolean;
  origin?: 'check' | 'ignore' | 'any403';
  host?: 'check' | 'ignore';
  broadcast?: boolean;
  /** Every POST but the handshake answered with a 307 to this origin. */
  redirect?: string;
  bind?: string;
  /** server/discover answered with a DiscoverResult that names 2025-11-25 as well: the dual-era server of a modern run. */
  discover?: boolean | 'modern-only';
  /** Every request after the handshake answered 404 with no body: nothing is served at the endpoint. */
  noEndpoint?: boolean;
}

export interface Served extends Fixture {
  url: string;
  bodies: { headers: IncomingMessage['headers']; body: string }[];
}

export async function serve(o: Opts = {}): Promise<Served> {
  const sessions = new Map<string, { alive: boolean; streams: ServerResponse[] }>();
  const sessionIds = o.sessions === undefined ? (n: number) => `s-${n}` : o.sessions;
  let count = 0;
  let eventId = 0;
  let notes = 0;
  const requests: Served['requests'] = [];
  const bodies: Served['bodies'] = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method ?? '', path: req.url ?? '', headers: req.headers });
    const host = req.headers.host ?? '';
    if (o.host === 'check' && !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host))
      return res.writeHead(o.refuse ?? 403).end();
    const origin = req.headers.origin;
    if (origin !== undefined) {
      if (o.origin === 'any403') return res.writeHead(403).end();
      if (o.origin !== 'ignore' && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin))
        return res.writeHead(o.refuse ?? 403).end();
    }
    const sid = req.headers['mcp-session-id'] as string | undefined;
    const state = sid === undefined ? undefined : sessions.get(sid);
    if (req.method === 'GET') {
      const get = o.get ?? '405';
      if (typeof get === 'number') return res.writeHead(get).end();
      if (get === '405') return res.writeHead(405).end();
      if (get === 'json')
        return res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.flushHeaders();
      state?.streams.push(res);
      return;
    }
    if (req.method === 'DELETE') {
      if (typeof o.del === 'number') return res.writeHead(o.del).end();
      if ((o.del ?? 'ends') === '405') return res.writeHead(405).end();
      if (state !== undefined && o.lax !== true) state.alive = false;
      return res.writeHead(200).end();
    }
    let body = '';
    req.on('data', (c: Buffer) => (body += String(c)));
    req.on('end', () => {
      bodies.push({ headers: req.headers, body });
      let msg: { id?: string | number; method: string; params?: Record<string, unknown> };
      try {
        msg = JSON.parse(body) as typeof msg;
      } catch {
        return res.writeHead(400).end();
      }
      if (msg.method === 'initialize') {
        const id = sessionIds === false ? undefined : sessionIds(++count);
        if (id !== undefined) sessions.set(id, { alive: true, streams: [] });
        res.writeHead(200, {
          'content-type': 'application/json',
          ...(id === undefined ? {} : { 'mcp-session-id': id }),
        });
        return res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              protocolVersion: msg.params?.['protocolVersion'],
              capabilities: { tools: {} },
              serverInfo: { name: 'raw', version: '1' },
            },
          }),
        );
      }
      if (msg.method === 'ping' && o.silent === true) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        return res.flushHeaders();
      }
      if (o.noEndpoint === true && msg.id !== undefined && msg.method !== 'server/discover')
        return res.writeHead(404).end();
      if (o.redirect !== undefined && msg.id !== undefined)
        return res.writeHead(307, { location: `${o.redirect}${req.url ?? '/'}` }).end();
      if (sessionIds !== false && o.lax !== true) {
        if (sid === undefined) return res.writeHead(o.refuse ?? 400).end();
        if (state?.alive !== true) return res.writeHead(o.refuse ?? 404).end();
      }
      if (
        msg.method === 'ping' &&
        o.pingStatus !== undefined &&
        (sid !== undefined || sessionIds === false)
      )
        return res.writeHead(o.pingStatus).end();
      const version = req.headers['mcp-protocol-version'] as string | undefined;
      if (o.lax !== true && version !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(version))
        return res.writeHead(o.refuse ?? 400).end();
      if (msg.id === undefined) {
        const n = o.notification ?? 'ok';
        if (typeof n === 'number') return res.writeHead(++notes > 1 ? n : 202).end();
        if (n === 'ok') return res.writeHead(202).end();
        // The modern notification (it carries Mcp-Method) is refused; the SDK client's own handshake is not.
        if (n === 'refuse' && req.headers['mcp-method'] !== undefined)
          return res.writeHead(400).end();
        if (n === 'refuse') return res.writeHead(202).end();
        if (n === 'body202')
          return res
            .writeHead(202, { 'content-type': 'application/json' })
            .end('{"accepted":true}');
        return res.writeHead(200, { 'content-type': 'application/json' }).end('{"accepted":true}');
      }
      if (msg.method === 'tools/call' && state !== undefined) {
        const note = `data: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'hi' } })}\n\n`;
        for (const s of o.broadcast === true ? state.streams : state.streams.slice(0, 1))
          s.write(note);
      }
      const result =
        msg.method === 'tools/list'
          ? { tools: [] }
          : msg.method === 'tools/call'
            ? { content: [] }
            : msg.method === 'server/discover' && o.discover !== undefined && o.discover !== false
              ? {
                  resultType: 'complete',
                  supportedVersions:
                    o.discover === 'modern-only' ? ['2026-07-28'] : ['2026-07-28', '2025-11-25'],
                  capabilities: { tools: {} },
                  ttlMs: 0,
                  cacheScope: 'public',
                }
              : {};
      const frame = JSON.stringify({
        jsonrpc: '2.0',
        id: o.wrongId === true ? 'not-yours' : msg.id,
        result,
        ...(o.echoSession === true && sid !== undefined ? { session: sid } : {}),
      });
      const answer = o.answer ?? 'json';
      if (answer === 'json')
        return res.writeHead(200, { 'content-type': 'application/json' }).end(frame);
      if (answer === 'text') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        return res.end(
          o.badUtf8 === true
            ? Buffer.concat([Buffer.from(frame), Buffer.from([0xff, 0xfe])])
            : frame,
        );
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        ...(o.accel === true ? { 'x-accel-buffering': 'no' } : {}),
      });
      const id = () =>
        o.eventIds === 'none' ? '' : `id: ${o.eventIds === 'repeat' ? 1 : ++eventId}\n`;
      if (o.serverRequest === true)
        res.write(
          `${id()}data: ${JSON.stringify({ jsonrpc: '2.0', id: 'srv-1', method: 'sampling/createMessage', params: {} })}\n\n`,
        );
      res.write(`${id()}data: ${frame}\n\n`);
      if (o.keepOpen !== true) res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, o.bind ?? '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const fixture: Served = {
    origin: `http://127.0.0.1:${port}`,
    url: `http://127.0.0.1:${port}/mcp`,
    requests,
    bodies,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  open.push(fixture);
  return fixture;
}

/** The header rules the HTTP wrapper keeps; each one off is a server that breaks it. */
export interface Rules {
  mode?: string;
  validate?: boolean;
  decode?: boolean;
  /** Mcp-Name compared without regard to case. */
  nameAnyCase?: boolean;
  /** Header names read only as written in lower case. */
  namesExact?: boolean;
  echoSession?: boolean;
  statuses?: boolean;
}

const decoded = (v: string | undefined) => {
  const m = v === undefined ? null : /^=\?base64\?(.*)\?=$/.exec(v);
  return m === null ? v : Buffer.from(m[1] ?? '', 'base64').toString('utf8');
};

export async function serveHttp(rules: Rules = {}) {
  const r = { mode: 'good', validate: true, decode: true, statuses: true, ...rules };
  const state = { http: true, discovered: true, connection: 'http' };
  const bodies: { headers: IncomingMessage['headers']; body: string }[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += String(c)));
    req.on('end', () => {
      bodies.push({ headers: req.headers, body });
      const exact = (name: string) => {
        if (r.namesExact !== true) return req.headers[name] as string | undefined;
        const i = req.rawHeaders.indexOf(name);
        return i < 0 ? undefined : req.rawHeaders[i + 1];
      };
      if (req.method !== 'POST') return res.writeHead(405).end();
      let msg: { id?: string | number; method: string; params?: Record<string, unknown> };
      try {
        msg = JSON.parse(body) as typeof msg;
      } catch {
        return res.writeHead(400).end();
      }
      if (msg.id === undefined) return res.writeHead(202).end();
      const session = req.headers['mcp-session-id'];
      const extra: Record<string, string> =
        r.echoSession === true && typeof session === 'string' ? { 'mcp-session-id': session } : {};
      const reply = (frame: { error?: { code: number } }) => {
        const code = frame.error?.code;
        const status =
          r.statuses && code !== undefined
            ? code === -32601
              ? 404
              : [-32602, -32020, -32021, -32022].includes(code)
                ? 400
                : 200
            : 200;
        res
          .writeHead(status, { 'content-type': 'application/json', ...extra })
          .end(JSON.stringify(frame));
      };
      const mismatch = (why: string) =>
        reply({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32020, message: `Header mismatch: ${why}` },
        } as never);
      if (r.validate) {
        const params = msg.params ?? {};
        const meta = (params['_meta'] ?? {}) as Record<string, unknown>;
        const version = exact('mcp-protocol-version');
        const method = exact('mcp-method');
        if (version === undefined || method === undefined)
          return mismatch('a required header is missing');
        const v = meta['io.modelcontextprotocol/protocolVersion'];
        if (typeof v === 'string' && v !== version) return mismatch('MCP-Protocol-Version');
        if (method !== msg.method) return mismatch('Mcp-Method');
        if (['tools/call', 'resources/read', 'prompts/get'].includes(msg.method)) {
          const raw = exact('mcp-name');
          const name = r.decode ? decoded(raw) : raw;
          const body = String(msg.method === 'resources/read' ? params['uri'] : params['name']);
          const same =
            r.nameAnyCase === true ? name?.toLowerCase() === body.toLowerCase() : name === body;
          if (raw === undefined || !same) return mismatch('Mcp-Name');
        }
        if (msg.method === 'tools/call' && params['name'] === 'region') {
          const region = (params['arguments'] as Record<string, unknown> | undefined)?.['region'];
          const h = decoded(exact('mcp-param-region'));
          if (region !== undefined && h !== String(region)) return mismatch('Mcp-Param-Region');
        }
      }
      if (msg.method === 'subscriptions/listen') {
        res.writeHead(200, { 'content-type': 'text/event-stream', ...extra });
        return answer(
          r.mode,
          state,
          msg,
          (f: unknown) => res.write(`data: ${JSON.stringify(f)}\n\n`),
          () => res.end(),
        );
      }
      let sent = false;
      answer(r.mode, state, msg, (f: { id?: unknown; error?: { code: number } }) => {
        if (sent || f.id === undefined) return;
        sent = true;
        reply(f);
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  open.push({
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  });
  return { url: `http://127.0.0.1:${port}/mcp`, bodies };
}
