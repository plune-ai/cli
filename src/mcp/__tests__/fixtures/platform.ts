// The Plune platform as the tests of `plune mcp serve` and the agent scenarios (mcp-evals/) see it: one set of
// answers, served two ways. `fakeFetch` hands them to the in-memory server of server.test.ts; `startPlatformStub`
// serves them on 127.0.0.1 to the real process the scenarios start. Reads answer from the recorded live answers of the
// beta demo project (plune-budget.fixtures.ts); writes answer a fixed, well-defined result; a deletion is refused as
// the platform refuses an agent. People in the sample data are John Doe, user@plune.ai. Nothing leaves the machine.
//
// As a script, `tsx src/mcp/__tests__/fixtures/platform.ts [port]` serves the stub until it is stopped and prints its
// URL on stdout.

import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIVE, LIVE_MISSION } from '../../../mcp-testing/__tests__/plune-budget.fixtures.js';

export type Answer = { status: number; body?: unknown };
export type AnswerFn = (method: string, url: URL, headers: Headers, body?: unknown) => Answer | undefined;

/** A fetch that answers with `answer`; what it leaves unanswered is a 200 with `{}`. Every request is kept in `calls`. */
export function fakeFetch(answer: AnswerFn) {
  const calls: { method: string; url: URL; headers: Headers }[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const call = { method: init?.method ?? 'GET', url: new URL(String(input)), headers: new Headers(init?.headers) };
    calls.push(call);
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    const a = answer(call.method, call.url, call.headers, body) ?? { status: 200, body: {} };
    return new Response(a.body === undefined ? null : JSON.stringify(a.body), { status: a.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

/** The confirm value every decision preview gives; a decision with any other one is refused. */
export const STUB_CONFIRM = 'confirm-stub-1';

/** The ids the writes answer with. */
export const CREATED = { mission: 'mission-2', source: 'source-new-1', question: 'question-1', run: 'run-1', generation: 'generation-1' } as const;

/** The platform's refusals, as it sends them. */
export const REFUSAL = {
  readOnly: { status: 403, body: { error: 'read-only token' } },
  bulkDelete: { status: 403, body: { error: 'an agent cannot delete in bulk — a person does it from the dashboard', code: 'bulk_delete_needs_person' } },
  delete: { status: 403, body: { error: 'an agent cannot delete — a person does it from the dashboard', code: 'agent_cannot_delete' } },
} as const;

type Item = Record<string, unknown>;
const RECORDED = LIVE.answers['/v1/test-cases?limit=100&stability=0'] as { testCases: Item[]; total: number };
/**
 * The recorded cases carry no tags and none is deprecated. Three get the `smoke` tag and the withdrawn coupon case is
 * deprecated, so a search by tag or by state finds a few cases, as it would on a project that uses them, and its answer
 * fits the 4 KiB excerpt of a call (src/orchestrator/agent.ts) instead of sending the model on to read every case.
 */
const SMOKE = ['e43e1a95-e2a2-42a1-93b6-62b04756fba6', '3021acf3-2318-4c6a-9598-125c15f01600', 'c7665d5b-c571-431f-b05c-d92423ce954d'];
const DEPRECATED = '6bfec5b1-3382-448a-ac78-01225c6a045e';
const CASES = {
  ...RECORDED,
  testCases: RECORDED.testCases.map((c) => ({
    ...c,
    ...(SMOKE.includes(String(c['id'])) ? { tags: ['smoke'] } : {}),
    ...(c['id'] === DEPRECATED ? { state: 'deprecated', status: 'deprecated' } : {}),
  })),
};
const QUEUE = LIVE.answers['/v1/review-items?state=pending&limit=100'] as { items: Item[]; nextCursor: string | null };

const ok = (body: unknown, status = 200): Answer => ({ status, body });
const notFound = (what: string): Answer => ({ status: 404, body: { error: `${what} not found` } });
const record = (v: unknown): Item => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Item) : {});
const count = (v: unknown) => (Array.isArray(v) ? v.length : 0);

/** The texts `q` looks in, as the platform's case list does: title, description, precondition, steps, expected. */
const textsOf = (c: Item): unknown[] => [
  c['title'],
  c['description'],
  c['precondition'],
  c['expected'],
  ...(Array.isArray(c['steps']) ? (c['steps'] as Item[]).flatMap((s) => [s['action'], s['expected']]) : []),
];

/** A filter of the case list: the field equals one of the values (a list field holds one); `tag` reads `tags`; `q` is a case-insensitive part of a text. */
function caseMatches(c: Item, key: string, values: string[]): boolean {
  if (key === 'q') {
    const needle = values.find((v) => v !== '')?.toLowerCase();
    return needle === undefined || textsOf(c).some((t) => typeof t === 'string' && t.toLowerCase().includes(needle));
  }
  const field = key === 'tag' ? c['tags'] : c[key];
  return Array.isArray(field) ? field.some((f) => values.includes(String(f))) : field !== undefined && values.includes(String(field));
}

/** One page, as the platform pages: `limit` clamped to 1..max (`fallback` when none is sent), `cursor` the offset the previous page gave. */
function page<T>(items: T[], q: URLSearchParams, max: number, fallback: number): { page: T[]; nextCursor: string | null } {
  const asked = Number.parseInt(q.get('limit') ?? '', 10);
  const limit = Math.min(Math.max(Number.isNaN(asked) ? fallback : asked, 1), max);
  const offset = Math.max(Number.parseInt(q.get('cursor') ?? '', 10) || 0, 0);
  return { page: items.slice(offset, offset + limit), nextCursor: offset + limit < items.length ? String(offset + limit) : null };
}

function read(url: URL): Answer {
  const q = url.searchParams;
  const p = url.pathname;
  if (p === '/v1/test-cases') {
    const keys = [...new Set(q.keys())].filter((k) => !['limit', 'cursor', 'stability'].includes(k));
    const found = CASES.testCases.filter((c) => keys.every((k) => caseMatches(c, k, q.getAll(k))));
    const { page: testCases, nextCursor } = page(found, q, 200, 200);
    return ok({ testCases, stability: {}, total: CASES.total, matching: found.length, nextCursor });
  }
  if (p === '/v1/review-items') {
    // Questions are a kind of their own, and the recorded queue holds none; nor anything but pending entries.
    const none = q.get('kind') === 'question' || (q.get('state') ?? 'pending') !== 'pending';
    const { page: items, nextCursor } = page(none ? [] : QUEUE.items, q, 200, 50);
    return ok({ items, nextCursor });
  }
  const exact = LIVE.answers[p + url.search];
  if (exact !== undefined) return ok(exact);
  const one = (items: Item[], what: string) => {
    const id = decodeURIComponent(p.slice(p.lastIndexOf('/') + 1));
    const item = items.find((i) => i['id'] === id);
    return item === undefined ? notFound(what) : ok(item);
  };
  if (p.startsWith('/v1/test-cases/')) return one(CASES.testCases, 'test case');
  if (p.startsWith('/v1/review-items/')) return one(QUEUE.items, 'review item');
  if (p.startsWith('/v1/missions/')) return one([LIVE_MISSION], 'mission');
  if (p.startsWith('/v1/runs/')) return one([{ id: CREATED.run, name: 'Nightly checkout', state: 'open' }], 'run');
  if (/^\/v1\/projects\/[^/]+\/case-generations\//.test(p)) return one([{ id: CREATED.generation, state: 'done', proposed: 3, skipped: 0 }], 'case generation');
  return notFound(p);
}

/** Writes, each with one fixed answer. A path not listed is a 404, so a call the scenarios did not foresee shows. */
const WRITES: [method: string, path: RegExp, answer: (body: Item, url: URL) => Answer][] = [
  ['POST', /^\/v1\/missions$/, (b) => ok({ id: CREATED.mission, state: 'draft', sources: [], createdBy: 'John Doe', ...b }, 201)],
  ['PATCH', /^\/v1\/missions\/[^/]+$/, (b, u) => ok({ id: path.posix.basename(u.pathname), ...b })],
  ['POST', /^\/v1\/missions\/[^/]+\/(sources|files)$/, (b) => ok({ id: CREATED.source, addedBy: 'John Doe', ...b }, 201)],
  ['POST', /^\/v1\/missions\/[^/]+\/strategy$/, () => ok({ id: 'strategy-1', state: 'pending' }, 201)],
  ['POST', /^\/v1\/missions\/[^/]+\/report$/, () => ok({ id: 'report-1', state: 'queued' }, 202)],
  ['POST', /^\/v1\/review-items\/questions$/, () => ok({ id: CREATED.question, kind: 'question', state: 'pending', askedBy: 'John Doe' }, 201)],
  [
    'POST',
    /^\/v1\/review-items\/decisions$/,
    (b, u) => {
      const confirm = u.searchParams.get('confirm');
      if (confirm === null)
        return ok({ preview: { action: 'review-items/decide', total: count(b['itemIds']), sample: b['itemIds'], confirm: STUB_CONFIRM, expiresInSeconds: 300 } });
      if (confirm !== STUB_CONFIRM) return { status: 409, body: { error: 'confirm is unknown or expired: ask for a new preview', code: 'confirm_invalid' } };
      return ok({ applied: count(b['itemIds']), skipped: [] });
    },
  ],
  ['POST', /^\/v1\/ingest\/cairn$/, (b) => ok({ proposed: count(b['cases']), skipped: 0 })],
  ['POST', /^\/v1\/projects\/[^/]+\/case-generations$/, () => ok({ id: CREATED.generation, state: 'queued' }, 202)],
  ['POST', /^\/v1\/runs$/, () => ok({ id: CREATED.run }, 201)],
  // Every result accepted: the counts and the per-result verdicts the CLI's reporter reads from this route. As on the
  // platform, a result without the case it is of (testCaseId) is a 400 for the whole batch; nothing else is checked.
  [
    'POST',
    /^\/v1\/runs\/[^/]+\/results$/,
    (b) => {
      const results = Array.isArray(b['results']) ? (b['results'] as unknown[]) : [];
      const bare = results.findIndex((r) => typeof record(r)['testCaseId'] !== 'string' || record(r)['testCaseId'] === '');
      if (bare !== -1) return { status: 400, body: { error: `validation failed — results.${bare}.testCaseId: Required` } };
      return ok({
        items: results.map((_, i) => ({ status: 'accepted', id: `result-${i + 1}` })),
        counts: { accepted: results.length, duplicate: 0, conflict: 0, rejected: 0 },
      });
    },
  ],
];

/** What the platform answers: a read from the recording, a write its fixed result, a deletion by an agent refused. */
export const platformAnswer: AnswerFn = (method, url, headers, body) => {
  if (method === 'GET') return read(url);
  const agent = headers.get('x-plune-session') !== null;
  if (method === 'DELETE') return agent ? REFUSAL.delete : ok({ deleted: 1 });
  const b = record(body);
  if (method === 'POST' && url.pathname === '/v1/test-cases/bulk' && record(b['action'])['kind'] === 'delete')
    return agent ? REFUSAL.bulkDelete : ok({ deleted: count(b['ids']) });
  const write = WRITES.find(([m, p]) => m === method && p.test(url.pathname));
  return write === undefined ? notFound(`${method} ${url.pathname}`) : write[2](b, url);
};

export interface PlatformStub {
  url: string;
  /** Every request, in order: method, path and query. */
  requests: string[];
  close(): Promise<void>;
}

/** The platform on 127.0.0.1 (port 0: any free one), answering with `platformAnswer`. */
export async function startPlatformStub(port = 0): Promise<PlatformStub> {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => (raw += chunk));
    req.on('end', () => {
      const method = req.method ?? 'GET';
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
      let body: unknown;
      try {
        body = raw === '' ? undefined : JSON.parse(raw);
      } catch {
        body = undefined;
      }
      requests.push(`${method} ${url.pathname}${url.search}`);
      const a = platformAnswer(method, url, headers, body) ?? notFound(url.pathname);
      res.writeHead(a.status, { 'content-type': 'application/json' });
      res.end(a.body === undefined ? '' : JSON.stringify(a.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void startPlatformStub(Number(process.argv[2] ?? 0)).then((stub) => process.stdout.write(`${stub.url}\n`));
}
