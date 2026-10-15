import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';

/**
 * A platform on a real socket for the tests that import a report with files: it knows every test, stores
 * every result under an id, and — with a bucket (platform ADR 0041) — hands out links back to itself, where
 * a PUT is the file arriving. Not a test file: the in-process and the binary tests share it.
 */
export interface Put {
  /** The file's name as the link carried it, decoded. */
  name: string;
  type: string;
  bytes: Buffer;
  sha256: string;
}

export interface BucketPlatform {
  url: string;
  /** Files that reached the bucket, in arrival order. */
  puts: Put[];
  /** Files sent to the platform's own route (a project without a bucket). */
  direct: { name: string; type: string; bytes: Buffer }[];
  /** Every request to a file route, as `METHOD path`, in arrival order: what the bulk routes save is counted here. */
  calls: string[];
  /** Every result the platform stored, as sent. */
  results: { resultKey: string; title?: string; rawStatus?: string }[];
  close(): Promise<void>;
}

export const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');

export async function startBucketPlatform(options: { bucket?: boolean; known?: boolean; batch?: boolean } = {}): Promise<BucketPlatform> {
  const bucket = options.bucket ?? true;
  const known = options.known ?? true;
  /** `false` models a platform older than the bulk routes (ADR 0051): they answer a bare 404. */
  const batch = options.batch ?? true;
  const calls: string[] = [];
  /** What each announced file is, by id; and which ones a `complete` has finished. */
  const announced = new Map<string, { resultId: string; name: string; type: string; sha256?: string }>();
  const finished = new Set<string>();
  const puts: Put[] = [];
  const direct: BucketPlatform['direct'] = [];
  const results: BucketPlatform['results'] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const reply = (status: number, payload: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      const url = req.url ?? '';
      if (req.method === 'POST' && /^\/v1\/(files|results)\//.test(url) && /(files|-batch|complete)/.test(url)) calls.push(`POST ${url.split('?')[0]}`);
      if (/^\/v1\/files\/(uploads|complete|direct)-batch$/.test(url)) {
        if (!batch) return reply(404, {});
        const input = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
        if (url.endsWith('/uploads-batch')) {
          const items = input['items'] as { resultId: string; name: string; contentType: string; sha256?: string }[];
          return reply(200, {
            items: items.map((f, index) => {
              const key = `${f.resultId}|${f.name}|${f.contentType}|${f.sha256}`;
              if (f.sha256 !== undefined && finished.has(key)) return { index, status: 'exists', id: `f-${f.name}`, name: f.name };
              if (!bucket) return { index, status: 'direct', name: f.name };
              announced.set(`f-${f.name}`, { resultId: f.resultId, name: f.name, type: f.contentType, ...(f.sha256 !== undefined ? { sha256: f.sha256 } : {}) });
              return {
                index,
                status: 'upload',
                id: `f-${f.name}`,
                name: f.name,
                url: `http://${req.headers.host}/bucket/${encodeURIComponent(f.name)}?sig=SECRET_SIG`,
                method: 'PUT',
                headers: { 'content-type': f.contentType },
                expiresAt: '2099-01-01T00:00:00.000Z',
              };
            }),
          });
        }
        if (url.endsWith('/complete-batch')) {
          const ids = input['ids'] as string[];
          return reply(200, {
            items: ids.map((id, index) => {
              const a = announced.get(id);
              if (a === undefined) return { index, status: 'refused', code: 'not_found', error: 'no such file', httpStatus: 404 };
              finished.add(`${a.resultId}|${a.name}|${a.type}|${a.sha256}`);
              return { index, id, status: 'ready', name: a.name, contentType: a.type, size: 1, storage: 'bucket' };
            }),
          });
        }
        const items = input['items'] as { resultId: string; name: string; contentType: string; data: string }[];
        return reply(200, {
          items: items.map((f, index) => {
            direct.push({ name: f.name, type: f.contentType, bytes: Buffer.from(f.data, 'base64') });
            return { index, status: 'stored', id: `f-${direct.length}`, name: f.name, contentType: f.contentType, size: 1 };
          }),
        });
      }
      if (req.method === 'PUT' && url.startsWith('/bucket/')) {
        const name = decodeURIComponent(url.slice('/bucket/'.length).split('?')[0] ?? '');
        puts.push({ name, type: String(req.headers['content-type']), bytes: raw, sha256: sha256(raw) });
        return reply(200, {});
      }
      if (/^\/v1\/results\/[^/]+\/files\?name=/.test(url)) {
        const name = decodeURIComponent(url.split('name=')[1] ?? '');
        direct.push({ name, type: String(req.headers['content-type']), bytes: raw });
        return reply(201, { id: `f-${direct.length}`, size: raw.length });
      }
      const body = raw.length === 0 ? {} : (JSON.parse(raw.toString('utf8')) as Record<string, unknown>);
      if (url.endsWith('/files/uploads')) {
        const { files } = body as { files: { name: string; contentType: string }[] };
        return reply(200, {
          files: files.map((f) =>
            bucket
              ? {
                  id: `f-${f.name}`,
                  name: f.name,
                  url: `http://${req.headers.host}/bucket/${encodeURIComponent(f.name)}?sig=SECRET_SIG`,
                  method: 'PUT',
                  headers: { 'content-type': f.contentType },
                  expiresAt: '2099-01-01T00:00:00.000Z',
                }
              : { name: f.name, direct: true },
          ),
        });
      }
      if (/^\/v1\/files\/[^/]+\/complete$/.test(url)) return reply(200, {});
      if (url === '/v1/runs') return reply(201, { run: { id: 'r-9' }, joined: false });
      if (url === '/v1/test-cases/resolve') {
        const keys = (body['keys'] ?? []) as { value: string }[];
        return reply(200, { results: keys.map((key) => ({ key, testCaseId: known ? 'tc-1' : null })) });
      }
      if (url.endsWith('/results')) {
        const sent = (body['results'] ?? []) as { resultKey: string; title?: string; rawStatus?: string }[];
        results.push(...sent);
        return reply(200, {
          items: sent.map((r, index) => ({ index, resultKey: r.resultKey, status: 'accepted', id: `res-${results.length - sent.length + index}` })),
          counts: { accepted: sent.length, duplicate: 0, conflict: 0, rejected: 0 },
        });
      }
      if (url.endsWith('/events')) return reply(200, { run: { id: 'r-9' }, changed: true });
      return reply(500, { error: `unexpected ${url}` });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    puts,
    direct,
    calls,
    results,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
