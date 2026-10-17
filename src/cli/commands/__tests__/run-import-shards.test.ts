import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleRunImport } from '../run-import.js';

/**
 * `PLUNE_SHARD=k/N` (cli#110): the shard that finishes its upload tells the platform, and the platform
 * closes the run when N distinct shards have. The fake below keeps the set the way plune#1601 does.
 */

const TOKEN = 'tok-shards-never-print-me';
const REPORT = `<testsuites><testsuite name="cart"><testcase classname="cart" name="adds an item" time="0.1"/></testsuite></testsuites>`;

type Mode = 'shards' | 'old-400' | 'old-ignores' | 'mismatch' | 'down';

function platform(mode: Mode = 'shards') {
  const finishes: Record<string, unknown>[] = [];
  const reported = new Set<number>();
  let total: number | undefined;
  let closed = 0;
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url).replace('https://api.test', '');
    if (/\/v1\/files\/(uploads|complete|direct)-batch$/.test(target)) return new Response('404', { status: 404 });
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    if (target === '/v1/runs') return json(201, { run: { id: 'r-9' }, joined: false });
    if (target === '/v1/test-cases/resolve') {
      const keys = (body['keys'] ?? []) as { value: string }[];
      return json(200, { results: keys.map((key) => ({ key, testCaseId: 'tc-1' })) });
    }
    if (target.endsWith('/results')) {
      const results = (body['results'] ?? []) as { resultKey: string }[];
      return json(200, {
        items: results.map((r, index) => ({ index, resultKey: r.resultKey, status: 'accepted', id: `res-${index}` })),
        counts: { accepted: results.length, duplicate: 0, conflict: 0, rejected: 0 },
      });
    }
    if (target.endsWith('/events')) {
      finishes.push(body);
      const k = body['shardIndex'] as number | undefined;
      const n = body['shardsExpected'] as number | undefined;
      if (k === undefined) return json(200, { run: { statusEvent: 'finished' }, detached: 0 });
      if (mode === 'old-400') return json(400, { error: 'unrecognized keys: shardIndex, shardsExpected' });
      if (mode === 'old-ignores') return json(200, { run: { statusEvent: 'finished' }, detached: 0 });
      if (mode === 'down') return json(500, { error: 'boom' });
      if (mode === 'mismatch') return json(409, { error: 'run expects 4', code: 'shards_mismatch', shardsExpected: 4 });
      total ??= n;
      if (n !== total) return json(409, { error: 'mismatch', code: 'shards_mismatch', shardsExpected: total });
      const wasClosed = closed > 0;
      reported.add(k!);
      const done = reported.size === total;
      if (done && !wasClosed) closed += 1;
      return json(200, {
        run: { statusEvent: done ? 'finished' : 'launched' },
        ...(done && !wasClosed ? { summary: { total: 1 } } : {}),
        detached: 0,
        shardsReported: reported.size,
        shardsExpected: total,
      });
    }
    return json(200, {});
  }) as unknown as typeof fetch;
  return {
    fetchImpl,
    finishes,
    get closed() {
      return closed;
    },
  };
}

let dir = '';
let lines: string[] = [];
const run = (fetchImpl: typeof fetch, extra: { failOnFailures?: boolean } = {}) =>
  handleRunImport({
    apiUrl: 'https://api.test',
    token: TOKEN,
    fetchImpl,
    write: (l: string) => void lines.push(l),
    file: path.join(dir, 'results.xml'),
    ...extra,
  });
const shard = (value: string) => vi.stubEnv('PLUNE_SHARD', value);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plune-shards-'));
  fs.writeFileSync(path.join(dir, 'results.xml'), REPORT, 'utf8');
  lines = [];
  for (const name of ['GITHUB_ACTIONS', 'GITLAB_CI', 'JENKINS_URL', 'PLUNE_SHARED_RUN', 'PLUNE_PROCEED', 'PLUNE_SHARD']) {
    vi.stubEnv(name, '');
  }
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe('PLUNE_SHARD=k/N', () => {
  it('closes the run once, whatever order the shards arrive in', async () => {
    const p = platform();
    const reported = [1, 2, 3];
    for (const [i, k] of [3, 1, 2].entries()) {
      lines = [];
      shard(`${k}/3`);
      await run(p.fetchImpl);
      expect(lines.at(-1)).toBe(`plune: shard ${k} of 3 done — ${reported[i]} of 3 shards reported`);
      expect(lines.includes('plune: run closed')).toBe(i === 2);
    }
    expect(p.closed).toBe(1);
    expect(p.finishes[0]).toEqual({ event: 'finish', shardIndex: 3, shardsExpected: 3 });
    expect(p.finishes.map((f) => f['shardIndex'])).toEqual([3, 1, 2]);
  });

  it('counts a retried shard once and leaves a short run open, saying how far it got', async () => {
    const p = platform();
    shard('1/2');
    await run(p.fetchImpl);
    await run(p.fetchImpl);
    expect(lines.at(-1)).toBe('plune: shard 1 of 2 done — 1 of 2 shards reported');
    expect(lines.join('\n')).not.toContain('run closed');
    expect(lines.join('\n')).not.toContain('still open');
    expect(p.closed).toBe(0);
    lines = [];
    shard('2/2');
    await run(p.fetchImpl);
    expect(lines.at(-1)).toBe('plune: shard 2 of 2 done — 2 of 2 shards reported');
    expect(lines).toContain('plune: run closed');
    expect(p.closed).toBe(1);
  });

  it('puts the verdict of the closing shard through --fail-on-failures', async () => {
    const p = platform();
    shard('1/1');
    const out = await run(p.fetchImpl, { failOnFailures: true });
    expect(out.gate).toBeDefined();
    expect(lines.join('\n')).not.toContain('no verdict yet');
  });

  it.each(['old-400', 'old-ignores'] as const)('leaves the run open on a platform that predates it (%s)', async (mode) => {
    const p = platform(mode);
    shard('2/4');
    await expect(run(p.fetchImpl)).resolves.toBeDefined();
    expect(lines.filter((l) => l.includes('does not support shard auto-close yet'))).toHaveLength(1);
    expect(lines.some((l) => l.includes('plune run finish r-9'))).toBe(true);
    expect(lines.join('\n')).not.toContain('shards reported');
  });

  it('refuses a different N with a message naming both, and a non-zero exit', async () => {
    const p = platform('mismatch');
    shard('2/3');
    await expect(run(p.fetchImpl)).rejects.toThrow(/3 shards.*already expects 4/);
  });

  it('keeps the results and does not fail the run when the platform is down', async () => {
    const p = platform('down');
    shard('1/2');
    const out = await run(p.fetchImpl);
    expect(out.accepted).toBe(1);
    expect(lines.join('\n')).toContain('could not report shard 1 of 2');
  }, 120000);

  it.each(['0/3', '4/3', '1/1001', '2', 'a/b', '1/2/3', '1 / 2', '-1/2', '1.5/3', '0/0'])(
    'rejects %s as a configuration error before sending anything',
    async (bad) => {
      const p = platform();
      shard(bad);
      await expect(run(p.fetchImpl)).rejects.toThrow(/PLUNE_SHARD=.*is not "k\/N"/);
      expect(p.finishes).toEqual([]);
    },
  );

  it('behaves as before when unset: a plain finish, no shard fields', async () => {
    const p = platform();
    await run(p.fetchImpl);
    expect(p.finishes).toEqual([{ event: 'finish' }]);
  });

  it('never prints the token', async () => {
    for (const mode of ['shards', 'old-400', 'mismatch'] as const) {
      shard('1/2');
      await run(platform(mode).fetchImpl).catch((e: Error) => void lines.push(e.message));
    }
    expect(lines.join('\n')).not.toContain(TOKEN);
  });
});
