// The executor behind every tool: how a call becomes HTTP against the platform, and what the caller is
// told back. A fake fetch stands in for the platform and answers the way the routes on master do.

import { describe, expect, it } from 'vitest';
import { createPluneToolExecutor, pluneTool, type PluneToolExecutor } from '../index.js';

interface Seen {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: unknown;
}

type Responder = (req: Seen) => { status: number; body?: unknown } | undefined;

function fakePlatform(responder: Responder = () => undefined) {
  const seen: Seen[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const req: Seen = {
      method: init?.method ?? 'GET',
      url: new URL(String(input)),
      headers,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    seen.push(req);
    const answer = responder(req) ?? { status: 200, body: {} };
    return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), {
      status: answer.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { seen, fetchImpl };
}

function executor(responder?: Responder, extra: { scope?: 'read' | 'write' } = {}) {
  const platform = fakePlatform(responder);
  const exec = createPluneToolExecutor({
    token: 'plt_test',
    apiUrl: 'https://api.test',
    projectId: 'proj-1',
    fetchImpl: platform.fetchImpl,
    ...extra,
  });
  return { ...platform, exec };
}

async function ok(exec: PluneToolExecutor, name: string, input: unknown) {
  const out = await exec.execute(name, input);
  if (!out.ok) throw new Error(`${name} failed: ${out.error.code} ${out.error.message}`);
  // What the executor hands back is what the contract promises.
  pluneTool(name).output.parse(out.data);
  return out.data;
}

const MISSION = {
  id: 'm1',
  projectId: 'proj-1',
  name: 'Checkout',
  summary: '',
  url: null,
  state: 'draft',
  documentation: 'unknown',
  createdBy: 'u1',
  createdAt: '2026-11-07T00:00:00Z',
  updatedAt: '2026-11-07T00:00:00Z',
  sources: [],
};

describe('every request', () => {
  it('carries the token, the project and ONE X-Plune-Session per executor', async () => {
    const { exec, seen } = executor((r) => (r.url.pathname === '/v1/missions/m1' ? { status: 200, body: MISSION } : undefined));
    await ok(exec, 'plune_mission_get', { missionId: 'm1' });
    await ok(exec, 'plune_mission_get', { missionId: 'm1' });
    expect(seen).toHaveLength(2);
    for (const r of seen) {
      expect(r.headers['authorization']).toBe('Bearer plt_test');
      expect(r.headers['x-plune-project']).toBe('proj-1');
      expect(r.headers['x-plune-session']).toBe(exec.sessionId);
    }
    expect(exec.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(exec.sessionId.length).toBeLessThanOrEqual(128);
  });

  it('gives two executors two sessions', () => {
    expect(executor().exec.sessionId).not.toBe(executor().exec.sessionId);
  });
});

describe('a token with only the read scope', () => {
  it('is refused every write tool before any request when the scope is known', async () => {
    const { exec, seen } = executor(undefined, { scope: 'read' });
    const out = await exec.execute('plune_mission_create', { name: 'Checkout' });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe('read_only_token');
    expect(out.error.message).toMatch(/read scope/);
    expect(seen).toHaveLength(0);
  });

  it('still reads', async () => {
    const { exec } = executor((r) => (r.url.pathname === '/v1/missions/m1' ? { status: 200, body: MISSION } : undefined), { scope: 'read' });
    await ok(exec, 'plune_mission_get', { missionId: 'm1' });
  });

  it('surfaces the server 403 clearly, then refuses further writes without asking again', async () => {
    const { exec, seen } = executor((r) => (r.method !== 'GET' ? { status: 403, body: { error: 'read-only token' } } : undefined));
    const first = await exec.execute('plune_question_ask', { template: 'plain', text: 'Is there a staging host?' });
    expect(first.ok).toBe(false);
    if (first.ok) return;
    expect(first.error.status).toBe(403);
    expect(first.error.code).toBe('read_only_token');
    expect(first.error.message).toMatch(/read scope/);
    expect(exec.scope()).toBe('read');
    const second = await exec.execute('plune_mission_create', { name: 'Checkout' });
    expect(second.ok).toBe(false);
    expect(seen).toHaveLength(1);
  });

  it('cannot write through the escape hatch either', async () => {
    const { exec, seen } = executor(undefined, { scope: 'read' });
    const out = await exec.execute('plune_api_request', { method: 'POST', path: '/v1/suites', body: { name: 'x' } });
    expect(out.ok).toBe(false);
    expect(seen).toHaveLength(0);
  });

  it('hides the write tools from discovery', async () => {
    const { exec } = executor(undefined, { scope: 'read' });
    const data = await ok(exec, 'plune_discover_tools', {});
    const names = (data['available'] as { name: string }[]).map((t) => t.name);
    expect(names).not.toContain('plune_cases_update');
    expect(exec.visibleTools()).not.toContain('plune_mission_create');
    expect(exec.visibleTools()).toContain('plune_mission_get');
  });
});

describe('dry_run', () => {
  it('describes the request and sends nothing', async () => {
    const { exec, seen } = executor();
    const data = await ok(exec, 'plune_mission_create', { name: 'Checkout', dry_run: true });
    expect(seen).toHaveLength(0);
    expect(data).toMatchObject({ dryRun: true, request: { method: 'POST', path: '/v1/missions', body: { name: 'Checkout' } } });
  });

  it('sends nothing for a batch either, and counts what it would send', async () => {
    const { exec, seen } = executor();
    const data = await ok(exec, 'plune_cases_update', { cases: [{ id: 'a', changes: { title: 'A' } }, { id: 'b', changes: { title: 'B' } }], dry_run: true });
    expect(seen).toHaveLength(0);
    expect(data).toMatchObject({ dryRun: true, requested: 2, applied: 0 });
  });
});

describe('mission tools', () => {
  it('creates, reads and updates a mission', async () => {
    const { exec, seen } = executor((r) => ({ status: r.method === 'POST' ? 201 : 200, body: MISSION }));
    expect(await ok(exec, 'plune_mission_create', { name: 'Checkout', url: 'https://shop.example' })).toMatchObject({ dryRun: false, result: { id: 'm1' } });
    await ok(exec, 'plune_mission_update', { missionId: 'm1', state: 'active' });
    expect(seen.map((r) => `${r.method} ${r.url.pathname}`)).toEqual(['POST /v1/missions', 'PATCH /v1/missions/m1']);
    expect(seen[1]?.body).toEqual({ state: 'active' });
  });

  it('adds a link source and a file source through their two routes', async () => {
    const { exec, seen } = executor(() => ({ status: 201, body: { id: 's1', kind: 'url', ref: 'https://docs.example', title: null, version: null, addedBy: 'u1', createdAt: 'now' } }));
    await ok(exec, 'plune_source_add', { missionId: 'm1', kind: 'url', ref: 'https://docs.example' });
    await ok(exec, 'plune_source_add', { missionId: 'm1', kind: 'file', name: 'README.md', text: '# Shop' });
    expect(seen.map((r) => `${r.method} ${r.url.pathname}`)).toEqual(['POST /v1/missions/m1/sources', 'POST /v1/missions/m1/files']);
    expect(seen[1]?.body).toEqual({ name: 'README.md', text: '# Shop' });
  });

  it('asks a question and lists only questions, narrowed to a mission', async () => {
    const q = (id: string, missionId: string) => ({ id, kind: 'question', state: 'pending', question: { template: 'plain', text: 'Why?', missionId } });
    const { exec, seen } = executor((r) =>
      r.method === 'POST' ? { status: 201, body: q('q1', 'm1') } : { status: 200, body: { items: [q('q1', 'm1'), q('q2', 'm2')], nextCursor: null } },
    );
    await ok(exec, 'plune_question_ask', { template: 'plain', text: 'Why?', missionId: 'm1' });
    const listed = await ok(exec, 'plune_question_list', { missionId: 'm1' });
    expect(seen[0]?.url.pathname).toBe('/v1/review-items/questions');
    expect(seen[1]?.url.searchParams.get('kind')).toBe('question');
    expect((listed['questions'] as { id: string }[]).map((x) => x.id)).toEqual(['q1']);
  });

  it('proposes a strategy and requests a report', async () => {
    const { exec, seen } = executor(() => ({ status: 201, body: { id: 'r1', kind: 'strategy', state: 'pending' } }));
    const item = (text: string) => ({ text, assumption: true as const });
    await ok(exec, 'plune_strategy_propose', {
      missionId: 'm1',
      content: {
        objectives: [item('Checkout works')],
        scope: { in: [item('Cart')], out: [item('Admin')] },
        approach: [item('Risk-based')],
        profile: { levels: ['system'], characteristics: ['security'], techniques: ['boundary-value'], split: { api: 50, ui: 30, manual: 20 }, notes: [item('Web shop')] },
        risks: [{ ...item('Payment fails'), likelihood: 'medium', impact: 'high' }],
        entryCriteria: [item('Staging is up')],
        exitCriteria: [item('No open high risk')],
      },
    });
    await ok(exec, 'plune_report_request', { missionId: 'm1' });
    expect(seen.map((r) => `${r.method} ${r.url.pathname}`)).toEqual(['POST /v1/missions/m1/strategy', 'POST /v1/missions/m1/report']);
    expect(seen[1]?.body).toEqual({});
  });

  it('refuses a strategy split that does not add up to 100 before sending', async () => {
    const out = await executor().exec.execute('plune_strategy_propose', { missionId: 'm1', content: { split: 1 } });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe('invalid_input');
  });
});

describe('plune_case_propose', () => {
  const one = { title: 'Cart keeps items', steps: ['Add an item', 'Reload'], expected: 'The item is still there' };

  it('queues up to 100 proposals through the ingest, a fresh run id each call, and says how many were proposed', async () => {
    const { exec, seen } = executor((r) => ({ status: 201, body: { runId: 'run-x', linked: 0, proposed: (r.body as { cases: unknown[] }).cases.length, skipped: 0 } }));
    const data = await ok(exec, 'plune_case_propose', { target: 'https://shop.example', cases: [one, one] });
    await ok(exec, 'plune_case_propose', { target: 'https://shop.example', cases: [one] });
    expect(seen[0]?.url.pathname).toBe('/v1/ingest/cairn');
    const body = seen[0]?.body as { schemaVersion: number; run: { runId: string; mode: string; target: string }; cases: { stableId: string; execution: string }[] };
    expect(body.schemaVersion).toBe(1);
    expect(body.run).toMatchObject({ mode: 'design', target: 'https://shop.example' });
    expect(body.run.runId).toContain(exec.sessionId);
    expect((seen[1]?.body as { run: { runId: string } }).run.runId).not.toBe(body.run.runId);
    expect(body.cases[0]).toMatchObject({ execution: 'manual' });
    expect(body.cases[0]?.stableId).toMatch(/^[0-9a-f]{16,}$/);
    expect(data).toMatchObject({ dryRun: false, requested: 2, applied: 2 });
  });
});

describe('batch writes report how many were applied', () => {
  it('updates cases one by one and counts the refusals', async () => {
    const { exec, seen } = executor((r) => (r.url.pathname.endsWith('/b') ? { status: 404, body: { error: "test case 'b' not found" } } : { status: 200, body: { id: 'a' } }));
    const data = await ok(exec, 'plune_cases_update', { cases: [{ id: 'a', changes: { title: 'A' } }, { id: 'b', changes: { title: 'B' } }] });
    expect(seen.map((r) => `${r.method} ${r.url.pathname}`)).toEqual(['PATCH /v1/test-cases/a', 'PATCH /v1/test-cases/b']);
    expect(data).toMatchObject({ requested: 2, applied: 1 });
    expect((data['results'] as { ok: boolean; status: number }[])[1]).toMatchObject({ ok: false, status: 404 });
  });

  it('writes results into a run in one request and reads the counts back', async () => {
    const { exec, seen } = executor(() => ({ status: 200, body: { items: [], counts: { accepted: 2, duplicate: 0, conflict: 0, rejected: 1 } } }));
    const data = await ok(exec, 'plune_results_write', { runId: 'r1', results: [{ a: 1 }, { a: 2 }, { a: 3 }] });
    expect(seen[0]?.url.pathname).toBe('/v1/runs/r1/results');
    expect(seen[0]?.body).toEqual({ results: [{ a: 1 }, { a: 2 }, { a: 3 }] });
    expect(data).toMatchObject({ requested: 3, applied: 2 });
  });
});

describe('plune_review_decide — preview, then confirm (#1280)', () => {
  it('passes the server preview through, then repeats with ?confirm', async () => {
    const { exec, seen } = executor((r) =>
      r.url.searchParams.get('confirm') === null
        ? { status: 200, body: { preview: { action: 'review-items/decide', total: 2, sample: ['i1', 'i2'], confirm: 'tok', expiresInSeconds: 300 } } }
        : { status: 200, body: { applied: 2, casesCreated: 2, skipped: [], duplicates: [] } },
    );
    const first = await ok(exec, 'plune_review_decide', { itemIds: ['i1', 'i2'], verdict: 'approved' });
    expect(first).toMatchObject({ applied: 0, preview: { confirm: 'tok', total: 2 } });
    const second = await ok(exec, 'plune_review_decide', { itemIds: ['i1', 'i2'], verdict: 'approved', confirm: 'tok' });
    expect(second).toMatchObject({ requested: 2, applied: 2 });
    expect(seen[0]?.body).toEqual({ itemIds: ['i1', 'i2'], state: 'approved' });
    expect(seen[1]?.url.searchParams.get('confirm')).toBe('tok');
  });

  it('takes at most 100 items', () => {
    expect(pluneTool('plune_review_decide').input.safeParse({ itemIds: Array(101).fill('i'), verdict: 'approved' }).success).toBe(false);
  });
});

describe('plune_api_request — the escape hatch keeps every guard', () => {
  it('previews any DELETE first and sends nothing', async () => {
    const { exec, seen } = executor();
    const data = await ok(exec, 'plune_api_request', { method: 'DELETE', path: '/v1/test-cases/c1' });
    expect(seen).toHaveLength(0);
    expect(data).toMatchObject({ preview: { method: 'DELETE', path: '/v1/test-cases/c1' } });
  });

  it('sends the confirmed DELETE with the session, and surfaces 403 agent_cannot_delete', async () => {
    const { exec, seen } = executor((r) =>
      r.method === 'DELETE' && r.headers['x-plune-session'] ? { status: 403, body: { error: 'an agent cannot delete - a person does it from the dashboard', code: 'agent_cannot_delete' } } : undefined,
    );
    const preview = await ok(exec, 'plune_api_request', { method: 'DELETE', path: '/v1/test-cases/c1' });
    const confirm = (preview['preview'] as { confirm: string }).confirm;
    const out = await exec.execute('plune_api_request', { method: 'DELETE', path: '/v1/test-cases/c1', confirm });
    expect(seen).toHaveLength(1);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error).toMatchObject({ status: 403, code: 'agent_cannot_delete' });
      expect(out.error.message).toMatch(/person/);
    }
  });

  it('returns the same refusal as HTTP for a bulk delete: 403 bulk_delete_needs_person', async () => {
    const refusal = { error: 'an agent cannot delete in bulk — a person does it from the dashboard', code: 'bulk_delete_needs_person' };
    const { exec, seen } = executor((r) => (r.url.pathname === '/v1/test-cases/bulk' && r.headers['x-plune-session'] ? { status: 403, body: refusal } : undefined));
    const call = { method: 'POST', path: '/v1/test-cases/bulk', body: { ids: ['a', 'b'], action: { kind: 'delete' } } };
    const preview = await ok(exec, 'plune_api_request', call);
    expect(seen).toHaveLength(0);
    const out = await exec.execute('plune_api_request', { ...call, confirm: (preview['preview'] as { confirm: string }).confirm });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatchObject({ status: 403, code: 'bulk_delete_needs_person', message: expect.stringContaining(refusal.error) });
  });

  it('refuses a confirm value it never issued, or one issued for another request', async () => {
    const { exec, seen } = executor();
    const preview = await ok(exec, 'plune_api_request', { method: 'DELETE', path: '/v1/test-cases/c1' });
    const confirm = (preview['preview'] as { confirm: string }).confirm;
    const other = await exec.execute('plune_api_request', { method: 'DELETE', path: '/v1/test-cases/c2', confirm });
    expect(other.ok).toBe(false);
    if (!other.ok) expect(other.error.code).toBe('confirm_invalid');
    const forged = await exec.execute('plune_api_request', { method: 'DELETE', path: '/v1/test-cases/c1', confirm: 'made-up' });
    expect(forged.ok).toBe(false);
    expect(seen).toHaveLength(0);
  });

  it('stays on the configured host: only /v1 paths, nothing absolute', async () => {
    const { exec, seen } = executor();
    for (const path of ['https://evil.example/v1/runs', '//evil.example/v1/runs', '/v1/../admin', '/health', 'v1/runs']) {
      const out = await exec.execute('plune_api_request', { method: 'GET', path });
      expect(out.ok, path).toBe(false);
    }
    expect(seen).toHaveLength(0);
  });

  it('passes a GET through and returns status and body', async () => {
    const { exec, seen } = executor(() => ({ status: 200, body: { suites: [] } }));
    const data = await ok(exec, 'plune_api_request', { method: 'GET', path: '/v1/suites', query: { a: 'b' } });
    expect(seen[0]?.url.toString()).toBe('https://api.test/v1/suites?a=b');
    expect(data).toMatchObject({ status: 200, body: { suites: [] } });
  });
});

describe('plune_discover_tools (AC-02)', () => {
  it('lists the hidden tools, and reveals the asked ones for the rest of the session', async () => {
    const { exec } = executor();
    const before = exec.visibleTools();
    expect(before).not.toContain('plune_cases_update');
    const listing = await ok(exec, 'plune_discover_tools', {});
    expect((listing['available'] as { name: string }[]).map((t) => t.name)).toContain('plune_cases_update');
    expect(exec.visibleTools()).toEqual(before);
    const revealed = await ok(exec, 'plune_discover_tools', { names: ['plune_cases_update'] });
    expect(revealed['revealed']).toEqual(['plune_cases_update']);
    expect(exec.visibleTools()).toContain('plune_cases_update');
    // And it stays.
    await ok(exec, 'plune_discover_tools', {});
    expect(exec.visibleTools()).toContain('plune_cases_update');
  });

  it('finds tools by words of their task', async () => {
    const data = await ok(executor().exec, 'plune_discover_tools', { query: 'results run' });
    expect((data['available'] as { name: string }[]).map((t) => t.name)).toContain('plune_results_write');
  });

  it('refuses an unknown name', async () => {
    const out = await executor().exec.execute('plune_discover_tools', { names: ['plune_nope'] });
    expect(out.ok).toBe(false);
  });
});

describe('errors', () => {
  it('names a rejected token and where to get one', async () => {
    const out = await executor(() => ({ status: 401, body: { error: 'invalid or revoked token' } })).exec.execute('plune_mission_get', { missionId: 'm1' });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toMatchObject({ status: 401, code: 'token_rejected' });
  });

  it('says the platform is unreachable on a network failure', async () => {
    const exec = createPluneToolExecutor({ token: 't', apiUrl: 'https://api.test', fetchImpl: (async () => { throw new TypeError('fetch failed'); }) as typeof fetch });
    const out = await exec.execute('plune_mission_get', { missionId: 'm1' });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe('network');
  });

  it('refuses an unknown tool and a malformed input without a request', async () => {
    const { exec, seen } = executor();
    expect((await exec.execute('plune_nope', {})).ok).toBe(false);
    const bad = await exec.execute('plune_mission_create', { name: '' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe('invalid_input');
    expect(seen).toHaveLength(0);
  });
});

describe('plune_project_context', () => {
  it('returns the structure of the project in one call', async () => {
    const { exec } = executor((r) => {
      switch (r.url.pathname) {
        case '/v1/projects':
          return { status: 200, body: { projects: [{ id: 'proj-1', name: 'Shop' }] } };
        case '/v1/suites':
          return { status: 200, body: { suites: [{ id: 's1', name: 'Cart', children: [] }] } };
        case '/v1/test-cases':
          return { status: 200, body: { testCases: [], total: 41, matching: 41, nextCursor: null } };
        case '/v1/missions':
          return { status: 200, body: { missions: [{ ...MISSION, sources: 0 }] } };
        case '/v1/review-items':
          return { status: 200, body: { items: [{ id: 'i1' }, { id: 'i2' }], nextCursor: 'more' } };
        default:
          return { status: 404, body: { error: 'nope' } };
      }
    });
    const data = await ok(exec, 'plune_project_context', {});
    expect(data).toMatchObject({ projectId: 'proj-1', cases: { total: 41 }, reviewQueue: { pending: 2, more: true } });
    expect((data['missions'] as unknown[]).length).toBe(1);
  });
});
