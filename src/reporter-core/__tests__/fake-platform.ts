import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** What a limiter answers for the n-th file request (from 1): a 429 with this `Retry-After` (`null`: none), or nothing. */
export type Limiter = (n: number, path: string) => { retryAfter: string | null } | undefined;

export interface FakeOptions {
  /** Every request waits this long before it is answered — the round trip of the network. */
  latencyMs?: number;
  /** Asked for every file request (`…/files/uploads`, `…/files?name=`, `…/complete`). */
  limiter?: Limiter;
}

/**
 * A platform on a real socket that takes any result and any picture by the direct route, and counts what
 * the uploads did to it: how many were ever in flight at once, and when each one arrived.
 */
export async function fakePlatform(opts: FakeOptions = {}) {
  const arrivals: { at: number; path: string; status: number }[] = [];
  let inflight = 0;
  let maxInflight = 0;
  let fileRequests = 0;
  let stored = 0;

  const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const path = req.url ?? '';
      // A platform older than the bulk routes: the CLI falls back to one request per file.
      if (/\/v1\/files\/(uploads|complete|direct)-batch$/.test(path)) return send(res, 404, {});
      const isFile = /\/files(\/uploads|\?name=)|\/complete$/.test(path);
      if (isFile) {
        inflight += 1;
        maxInflight = Math.max(maxInflight, inflight);
      }
      const at = Date.now();
      setTimeout(() => {
        if (isFile) inflight -= 1;
        const raw = Buffer.concat(chunks).toString();
        const isJson = req.headers['content-type'] === 'application/json';
        const body = isJson && raw !== '' ? (JSON.parse(raw) as Record<string, unknown>) : {};
        if (isFile) {
          fileRequests += 1;
          const limited = opts.limiter?.(fileRequests, path);
          if (limited !== undefined) {
            arrivals.push({ at, path, status: 429 });
            return send(res, 429, { error: 'slow down' }, limited.retryAfter === null ? {} : { 'retry-after': limited.retryAfter });
          }
          arrivals.push({ at, path, status: 200 });
          if (path.endsWith('/files/uploads')) {
            const files = (body['files'] as { name: string }[]).map((f) => ({ name: f.name, direct: true }));
            return send(res, 200, { files });
          }
          stored += 1;
          return send(res, 201, { id: `f-${stored}`, size: 1 });
        }
        if (path.endsWith('/v1/test-cases/resolve')) {
          const keys = body['keys'] as { value: string }[];
          return send(res, 200, { results: keys.map((k) => ({ key: k, testCaseId: `tc-${k.value}`, matchedKind: null })) });
        }
        if (path.endsWith('/v1/runs')) return send(res, 201, { run: { id: 'r-1' }, joined: false });
        if (/\/v1\/runs\/[^/]+\/results$/.test(path)) {
          const list = body['results'] as { resultKey: string }[];
          const items = list.map((r, index) => ({ index, resultKey: r.resultKey, status: 'accepted', id: `id-${r.resultKey}` }));
          return send(res, 200, { items, counts: { accepted: list.length, duplicate: 0, conflict: 0, rejected: 0 } });
        }
        if (path.endsWith('/events')) return send(res, 200, { run: { id: 'r-1' }, changed: true });
        return send(res, 500, { error: `unexpected ${path}` });
      }, opts.latencyMs ?? 0);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    arrivals,
    get maxInflight() {
      return maxInflight;
    },
    get stored() {
      return stored;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
