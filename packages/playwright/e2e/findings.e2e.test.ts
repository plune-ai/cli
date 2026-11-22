import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The fixture against a real browser: that a browser context emits what `watch` listens for, that overriding
 * `context` opens no browser for a test that asked for none, and that what leaves the worker is already reduced.
 *
 * Unlike `reporter.e2e.test.ts` this needs Chromium (`playwright install chromium`). What is read is the
 * attachment, from Playwright's own JSON report.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const FINDINGS_TYPE = 'application/plune.findings+json';

const PAGE = `<!doctype html><title>shop</title><link rel="icon" href="data:,"><script>
console.error('widget broke at /api/widget?token=secret');
setTimeout(() => { throw new Error('boom from the page'); }, 0);
</script>`;

interface Item {
  kind: string;
  text?: string;
  method?: string;
  path?: string;
  status?: number;
  durationMs?: number;
  at: number;
}

/** The shop, and a platform that refuses the token so the reporter goes quiet at once. */
function serve(): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    const url = req.url ?? '';
    if (url.startsWith('/v1/')) return void res.writeHead(401).end('{}');
    if (url === '/') return void res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE);
    if (url.startsWith('/api/fail')) return void res.writeHead(500).end('no');
    if (url === '/api/slow') return void setTimeout(() => res.writeHead(200).end('late'), 600);
    if (url === '/api/drop') return void req.socket.destroy();
    res.writeHead(204).end();
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        url: `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`,
        server,
      });
    }),
  );
}

describe('the findings fixture in a real browser', () => {
  let server: Server;
  let dir: string;
  let stderr = '';
  let startedAt = 0;
  /** Test title → the findings attachments of its one attempt, parsed. */
  const attached = new Map<string, { items: Item[]; omitted: number }[]>();

  beforeAll(async () => {
    const site = await serve();
    server = site.server;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plune-findings-'));
    const report = path.join(dir, 'report.json');
    startedAt = Date.now();
    await new Promise<void>((resolve, reject) => {
      const child = spawn('npx', ['playwright', 'test'], {
        cwd: path.join(here, 'fixture'),
        shell: process.platform === 'win32',
        env: {
          ...process.env,
          CI: '1',
          PLUNE_STUB_URL: site.url,
          PLUNE_FINDINGS_SITE: site.url,
          PLUNE_TEST_DIR: './findings',
          PLUNE_JSON_REPORT: report,
          PLUNE_FALLBACK: path.join(dir, 'pending.jsonl'),
        },
      });
      child.stderr.on('data', (c) => (stderr += String(c)));
      child.on('close', () => resolve());
      child.on('error', reject);
    });

    interface Suite {
      suites?: Suite[];
      specs?: {
        title: string;
        tests: { results: { attachments: { contentType: string; body?: string }[] }[] }[];
      }[];
    }
    const walk = (suite: Suite): void => {
      for (const spec of suite.specs ?? []) {
        attached.set(
          spec.title,
          spec.tests
            .flatMap((t) => t.results)
            .flatMap((r) => r.attachments)
            .filter((a) => a.contentType === FINDINGS_TYPE)
            .map(
              (a) =>
                JSON.parse(Buffer.from(a.body ?? '', 'base64').toString('utf8')) as {
                  items: Item[];
                  omitted: number;
                },
            ),
        );
      }
      for (const inner of suite.suites ?? []) walk(inner);
    };
    walk(JSON.parse(fs.readFileSync(report, 'utf8')) as Suite);
  }, 240_000);

  afterAll(() => {
    server?.close();
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
  });

  const found = (): { items: Item[]; omitted: number } => {
    const all = attached.get('a page that goes wrong in every way') ?? [];
    expect(all, stderr).toHaveLength(1);
    return all[0]!;
  };

  it('collects the four kinds, each reduced to what may be sent', () => {
    const { items, omitted } = found();
    expect(omitted).toBe(0);
    const kept = items.map(({ at: _at, durationMs: _ms, ...rest }) => rest);
    expect(kept).toContainEqual({
      kind: 'console',
      text: 'widget broke at /api/widget?token=‹credential›',
    });
    expect(kept).toContainEqual({ kind: 'page_error', text: 'boom from the page' });
    expect(kept).toContainEqual({
      kind: 'request_failed',
      method: 'GET',
      path: '/api/fail',
      status: 500,
    });
    expect(kept).toContainEqual({
      kind: 'request_slow',
      method: 'GET',
      path: '/api/slow',
      status: 200,
    });
    expect(kept).toContainEqual({ kind: 'request_failed', method: 'GET', path: '/api/drop' });
    expect(items).toHaveLength(5);
  });

  it('times a slow request, and gives a request that never answered no duration', () => {
    const { items } = found();
    expect(items.find((f) => f.path === '/api/slow')?.durationMs).toBeGreaterThanOrEqual(600);
    expect(items.find((f) => f.path === '/api/drop')).not.toHaveProperty('durationMs');
  });

  it('stamps every finding inside the run, in order', () => {
    const { items } = found();
    const times = items.map((f) => f.at);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    for (const at of times) {
      expect(at).toBeGreaterThanOrEqual(startedAt);
      expect(at).toBeLessThanOrEqual(Date.now());
    }
  });

  it('lets no query string and no browser echo out of the worker', () => {
    const raw = JSON.stringify(found());
    expect(raw).not.toContain('secret');
    expect(raw).not.toContain('Failed to load resource');
  });

  it('attaches nothing for a test that opened no browser', () => {
    expect(attached.get('a test that opens no browser')).toEqual([]);
  });

  it('attaches nothing when collection is switched off', () => {
    expect(attached.get('a page nobody listens to')).toEqual([]);
  });
});
