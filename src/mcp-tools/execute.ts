import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createPluneApi, PluneApiError, PluneNetworkError, type ApiRequest, type ApiResponse } from './client.js';
import { PLUNE_TOOLS, defaultVisibleTools, isPluneToolName, pluneTool, type PluneToolName } from './contract.js';
import { fileSource, linkSource } from './schemas.js';

/**
 * Runs a tool of the contract against the platform's HTTP API. Transport-free: the MCP server wraps it, and so can the
 * platform's built-in agent. One executor is one agent session — one `X-Plune-Session`, one set of revealed tools, one
 * set of issued confirm values.
 */

export type TokenScope = 'read' | 'write';

export interface ToolError {
  status?: number;
  code: string;
  message: string;
  details?: unknown;
}

export type ToolOutcome = { ok: true; data: Record<string, unknown> } | { ok: false; error: ToolError };

export interface PluneToolExecutorOptions {
  token: string;
  apiUrl: string;
  projectId?: string | undefined;
  /** Defaults to a fresh UUID: one session per executor. */
  sessionId?: string | undefined;
  /** The token's scope when it is known. `read` refuses every write before a request is made. */
  scope?: TokenScope | undefined;
  fetchImpl?: typeof fetch | undefined;
  userAgent?: string | undefined;
  now?: (() => number) | undefined;
  /**
   * The client's tool list never changes: discover_tools switches nothing on and describes the hidden tools with their
   * input schemas, and a hidden tool is called by its name. MCP 2026-07-28 asks this of tools/list.
   */
  fixedToolList?: boolean | undefined;
}

export interface PluneToolExecutor {
  readonly sessionId: string;
  /** The token's scope as known now: given, or learned from the platform's 403. */
  scope(): TokenScope | undefined;
  /** The tools a client should be shown now. */
  visibleTools(): PluneToolName[];
  execute(name: string, input: unknown): Promise<ToolOutcome>;
}

/** How long a confirm value of the escape hatch lives — the platform's own five minutes (#1280). */
export const CONFIRM_TTL_MS = 5 * 60 * 1000;

const READ_ONLY_REFUSAL = 'read-only token';

const NO_PROJECT = 'projectId is needed: the server was started without a project (--project or PLUNE_PROJECT). plune_project_context lists the projects.';

const readScopeMessage = (what: string) =>
  `This token has the read scope, so ${what}. Use a token with the write scope (Plune → Account → API tokens) and restart the server.`;

const fail = (code: string, message: string, extra: Omit<ToolError, 'code' | 'message'> = {}): ToolOutcome => ({
  ok: false,
  error: { code, message, ...extra },
});

/**
 * The platform's structured details of a 4xx answer (`findings` of a refused strategy, `details` of other routes), one line each,
 * so the agent reads them in the message itself and not only in `details`.
 */
function detailLines(body: unknown): string {
  const b = asRecord(body);
  const lines = [...asArray(b['findings']), ...asArray(b['details'])].map((d) => {
    if (typeof d === 'string') return `- ${d}`;
    const f = asRecord(d);
    const where = [f['rule'], f['path']].filter((x) => typeof x === 'string').join(' at ');
    const said = typeof f['message'] === 'string' ? f['message'] : where === '' ? JSON.stringify(d) : '';
    return `- ${[where, said].filter(Boolean).join(': ')}`;
  });
  return lines.length === 0 ? '' : '\n' + lines.join('\n');
}

function errorOf(err: unknown): ToolError {
  if (err instanceof PluneApiError) {
    if (err.status === 401)
      return { status: 401, code: 'token_rejected', message: `Plune rejected the token (401): ${err.message}. Run \`plune login\` or set PLUNE_TOKEN to a live token.` };
    if (err.status === 403 && err.message === READ_ONLY_REFUSAL)
      return { status: 403, code: 'read_only_token', message: `Plune refused (403): ${readScopeMessage('it cannot write')}` };
    const code = err.code ?? `http_${err.status}`;
    return { status: err.status, code, message: `Plune refused (${err.status} ${code}): ${err.message}${detailLines(err.body)}`, details: err.body };
  }
  if (err instanceof PluneNetworkError) return { code: 'network', message: `${err.message}. Check PLUNE_API_URL and the network.` };
  throw err;
}

const zodMessage = (error: z.ZodError) =>
  error.issues.map((i) => `${i.path.join('.') || '(input)'}: ${i.message}`).join('; ');

const path = (template: string, ...ids: string[]) => {
  let i = 0;
  return template.replace(/:[a-z]+/gi, () => encodeURIComponent(ids[i++] ?? ''));
};

const withoutUndefined = <T extends Record<string, unknown>>(o: T): Partial<T> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

const asRecord = (v: unknown): Record<string, unknown> => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const cursorOf = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** A deletion, by method or by what the body asks for — the escape hatch previews it before anything is sent. */
function isDeletion(req: ApiRequest): boolean {
  if (req.method === 'DELETE') return true;
  if (asRecord(asRecord(req.body)['action'])['kind'] === 'delete') return true;
  return /\/(bulk-delete|purge|empty)$/.test(req.path);
}

/** The escape hatch writes unless it reads: GET, and the one POST that only reads. */
const rawWrites = (method: string, p: string) => method !== 'GET' && !(method === 'POST' && p === '/v1/test-cases/resolve');

/** A path under /v1 on the configured host: no scheme, no host, no dot segments, no encoded ones either. */
function safePath(apiUrl: string, raw: string): string | undefined {
  if (!/^\/v1\/[^\\\s]*$/.test(raw) || raw.startsWith('//') || raw.includes('?') || raw.includes('#')) return undefined;
  if (raw.split('/').some((s) => s === '.' || s === '..' || /^%2e/i.test(s))) return undefined;
  const base = new URL(apiUrl);
  const url = new URL(raw, base);
  return url.origin === base.origin && url.pathname.startsWith('/v1/') ? raw : undefined;
}

export function createPluneToolExecutor(opts: PluneToolExecutorOptions): PluneToolExecutor {
  const sessionId = opts.sessionId ?? randomUUID();
  const now = opts.now ?? Date.now;
  const request = createPluneApi({ ...opts, sessionId });
  let scope: TokenScope | undefined = opts.scope;
  const revealed = new Set<PluneToolName>();
  const confirms = new Map<string, { fingerprint: string; expires: number }>();
  let proposals = 0;

  const visibleTools = (): PluneToolName[] => {
    const core = defaultVisibleTools(scope);
    const extra = [...revealed].filter((n) => !(scope === 'read' && pluneTool(n).write) && !core.includes(n));
    return [...core, ...extra];
  };

  /** One request; a 403 «read-only token» is remembered, so the next write is refused without asking. */
  async function call(req: ApiRequest): Promise<ApiResponse> {
    try {
      return await request(req);
    } catch (err) {
      if (err instanceof PluneApiError && err.status === 403 && err.message === READ_ONLY_REFUSAL) scope = 'read';
      throw err;
    }
  }

  const planned = (req: ApiRequest) => withoutUndefined({ method: req.method, path: req.path, query: req.query, body: req.body });

  async function write(req: ApiRequest, dry: boolean | undefined): Promise<Record<string, unknown>> {
    if (dry === true) return { dryRun: true, request: planned(req) };
    const res = await call(req);
    return { dryRun: false, result: asRecord(res.body) };
  }

  /** Each request on its own: a refusal is that item's answer and the rest go on (AC-03). A dead token stops the batch. */
  async function batch(reqs: ApiRequest[], dry: boolean | undefined, idOf: (body: unknown, i: number) => string | undefined) {
    if (dry === true) return { dryRun: true, requested: reqs.length, applied: 0, requests: reqs.map(planned) };
    const results: Record<string, unknown>[] = [];
    for (const [i, req] of reqs.entries()) {
      try {
        const res = await call(req);
        results.push(withoutUndefined({ ok: true, status: res.status, id: idOf(res.body, i) }));
      } catch (err) {
        const e = errorOf(err);
        if (e.code === 'token_rejected' || e.code === 'read_only_token' || e.code === 'network') throw err;
        results.push(withoutUndefined({ ok: false, status: e.status, error: e.message, code: e.code }));
      }
    }
    return { dryRun: false, requested: reqs.length, applied: results.filter((r) => r['ok'] === true).length, results };
  }

  const fingerprint = (req: ApiRequest) => JSON.stringify([req.method, req.path, req.query ?? {}, req.body ?? null]);

  type Handler = (input: Record<string, unknown>) => Promise<Record<string, unknown> | ToolOutcome>;
  const str = (v: unknown) => v as string;

  const handlers: Record<PluneToolName, Handler> = {
    async plune_project_context() {
      const [projects, suites, cases, missions, queue, memory] = await Promise.all([
        call({ method: 'GET', path: '/v1/projects' }),
        call({ method: 'GET', path: '/v1/suites' }),
        call({ method: 'GET', path: '/v1/test-cases', query: { limit: '1', stability: '0' } }),
        call({ method: 'GET', path: '/v1/missions' }),
        call({ method: 'GET', path: '/v1/review-items', query: { state: 'pending', limit: '100' } }),
        // A platform that keeps no project memory yet answers 404: no rules, and the rest of the context still stands.
        call({ method: 'GET', path: '/v1/memory/rules', query: { state: 'in_force' } }).catch((err: unknown) => {
          if (err instanceof PluneApiError && err.status === 404) return { status: 404, body: { rules: [] } };
          throw err;
        }),
      ]);
      // Only a rule in force: accepted by a person and not retired. Candidates wait in the queue and never come from this route.
      const memoryRules = asArray(asRecord(memory.body)['rules'])
        .map(asRecord)
        .filter((r) => r['inForce'] === true && typeof r['id'] === 'string' && typeof r['text'] === 'string')
        .map((r) => ({ id: str(r['id']), text: str(r['text']) }));
      const projectList = asArray(asRecord(projects.body)['projects']);
      const only = projectList.length === 1 ? asRecord(projectList[0])['id'] : undefined;
      const projectId = opts.projectId ?? (typeof only === 'string' ? only : null);
      const total = asRecord(cases.body)['total'];
      return {
        projectId,
        projects: projectList,
        suites: asArray(asRecord(suites.body)['suites']),
        cases: { total: typeof total === 'number' ? total : 0 },
        missions: asArray(asRecord(missions.body)['missions']),
        reviewQueue: { pending: asArray(asRecord(queue.body)['items']).length, more: cursorOf(asRecord(queue.body)['nextCursor']) !== null },
        memoryRules,
      };
    },

    async plune_get(i) {
      const route = { 'test-case': '/v1/test-cases/:id', run: '/v1/runs/:id', 'review-item': '/v1/review-items/:id' }[str(i['kind']) as 'run'];
      const res = await call({ method: 'GET', path: path(route, str(i['id'])) });
      return { kind: str(i['kind']), item: asRecord(res.body) };
    },

    async plune_cases_search(i) {
      const query = withoutUndefined({
        ...(i['filters'] as Record<string, string | string[]> | undefined),
        limit: i['limit'] === undefined ? undefined : String(i['limit']),
        cursor: i['cursor'] as string | undefined,
        stability: '0',
      }) as Record<string, string | string[]>;
      const body = asRecord((await call({ method: 'GET', path: '/v1/test-cases', query })).body);
      return withoutUndefined({
        testCases: asArray(body['testCases']),
        total: typeof body['total'] === 'number' ? body['total'] : undefined,
        matching: typeof body['matching'] === 'number' ? body['matching'] : undefined,
        nextCursor: cursorOf(body['nextCursor']),
      });
    },

    async plune_review_list(i) {
      const kinds = i['kinds'] as string[] | undefined;
      const query = withoutUndefined({
        state: i['state'] as string | undefined,
        kind: kinds?.join(','),
        missionId: i['missionId'] as string | undefined,
        limit: i['limit'] === undefined ? undefined : String(i['limit']),
        cursor: i['cursor'] as string | undefined,
      }) as Record<string, string>;
      const body = asRecord((await call({ method: 'GET', path: '/v1/review-items', query })).body);
      return { items: asArray(body['items']), nextCursor: cursorOf(body['nextCursor']) };
    },

    async plune_review_decide(i) {
      const itemIds = i['itemIds'] as string[];
      const res = await call({
        method: 'POST',
        path: '/v1/review-items/decisions',
        ...(i['confirm'] === undefined ? {} : { query: { confirm: str(i['confirm']) } }),
        body: withoutUndefined({ itemIds, state: i['verdict'], rejectionCategory: i['rejectionCategory'], note: i['note'] }),
      });
      const body = asRecord(res.body);
      if (body['preview'] !== undefined) return { requested: itemIds.length, applied: 0, preview: asRecord(body['preview']) };
      const applied = body['applied'];
      return { requested: itemIds.length, applied: typeof applied === 'number' ? applied : 0, report: body };
    },

    async plune_case_propose(i) {
      const cases = (i['cases'] as Record<string, unknown>[]).map((c) => {
        const steps = c['steps'] as string[];
        const stableId = createHash('sha256').update([c['title'], ...steps, c['expected']].join('\n')).digest('hex').slice(0, 32);
        return withoutUndefined({ stableId, execution: 'manual', ...c });
      });
      proposals += 1;
      const req: ApiRequest = {
        method: 'POST',
        path: '/v1/ingest/cairn',
        body: {
          schemaVersion: 1,
          run: withoutUndefined({ runId: `mcp-${sessionId}-${proposals}`, mode: 'design', target: str(i['target']), missionId: i['missionId'] as string | undefined }),
          cases,
        },
      };
      if (i['dry_run'] === true) return { dryRun: true, requested: cases.length, applied: 0, requests: [planned(req)] };
      const summary = asRecord((await call(req)).body);
      const proposed = summary['proposed'];
      // An older platform names no entries (and ignores the mission): then there is nothing to return.
      const ids = asArray(summary['itemIds']).filter((x): x is string => typeof x === 'string');
      return { dryRun: false, requested: cases.length, applied: typeof proposed === 'number' ? proposed : 0, ...(ids.length > 0 ? { itemIds: ids } : {}), report: summary };
    },

    async plune_cases_generate(i) {
      const { dry_run, projectId, ...body } = i;
      const project = (projectId as string | undefined) ?? opts.projectId;
      if (project === undefined) return fail('invalid_input', NO_PROJECT);
      return write({ method: 'POST', path: path('/v1/projects/:id/case-generations', project), body: withoutUndefined(body) }, dry_run as boolean | undefined);
    },

    async plune_cases_generation_get(i) {
      const project = (i['projectId'] as string | undefined) ?? opts.projectId;
      if (project === undefined) return fail('invalid_input', NO_PROJECT);
      const res = await call({ method: 'GET', path: path('/v1/projects/:id/case-generations/:generationId', project, str(i['generationId'])) });
      return { generation: asRecord(res.body) };
    },

    async plune_mission_create(i) {
      const { dry_run, ...body } = i;
      return write({ method: 'POST', path: '/v1/missions', body: withoutUndefined(body) }, dry_run as boolean | undefined);
    },

    async plune_mission_get(i) {
      const res = await call({ method: 'GET', path: path('/v1/missions/:id', str(i['missionId'])) });
      return { mission: asRecord(res.body) };
    },

    async plune_mission_update(i) {
      const { dry_run, missionId, ...body } = i;
      return write({ method: 'PATCH', path: path('/v1/missions/:id', str(missionId)), body: withoutUndefined(body) }, dry_run as boolean | undefined);
    },

    async plune_source_add(i) {
      const parsed = (i['kind'] === 'file' ? fileSource : linkSource).safeParse(withoutUndefined(i));
      if (!parsed.success) return fail('invalid_input', `The input does not fit: ${zodMessage(parsed.error)}`);
      const { dry_run, missionId, kind, ...rest } = parsed.data as Record<string, unknown>;
      const req: ApiRequest =
        kind === 'file'
          ? { method: 'POST', path: path('/v1/missions/:id/files', str(missionId)), body: withoutUndefined(rest) }
          : { method: 'POST', path: path('/v1/missions/:id/sources', str(missionId)), body: withoutUndefined({ kind, ...rest }) };
      return write(req, dry_run as boolean | undefined);
    },

    async plune_question_ask(i) {
      const { dry_run, ...body } = i;
      return write({ method: 'POST', path: '/v1/review-items/questions', body: withoutUndefined(body) }, dry_run as boolean | undefined);
    },

    async plune_question_list(i) {
      const query = withoutUndefined({
        kind: 'question',
        state: i['state'] as string | undefined,
        limit: i['limit'] === undefined ? undefined : String(i['limit']),
        cursor: i['cursor'] as string | undefined,
      }) as Record<string, string>;
      const body = asRecord((await call({ method: 'GET', path: '/v1/review-items', query })).body);
      const missionId = i['missionId'];
      const questions = asArray(body['items']).filter(
        (item) => missionId === undefined || asRecord(asRecord(item)['question'])['missionId'] === missionId,
      );
      return { questions, nextCursor: cursorOf(body['nextCursor']) };
    },

    async plune_strategy_propose(i) {
      const req: ApiRequest = { method: 'POST', path: path('/v1/missions/:id/strategy', str(i['missionId'])), body: i['content'] };
      if (i['dry_run'] === true) {
        // The platform's own checks, writing nothing. A platform without the route answers a bare 404 (a mission that is not there says `mission_not_found`), and a read token is refused: the planned request is all there is.
        try {
          const res = await call({ ...req, path: `${req.path}/check` });
          return { dryRun: true, checked: true, findings: asArray(asRecord(res.body)['findings']), request: planned(req) };
        } catch (err) {
          if (!(err instanceof PluneApiError && ((err.status === 404 && err.code !== 'mission_not_found') || (err.status === 403 && err.message === READ_ONLY_REFUSAL)))) throw err;
          return { dryRun: true, checked: false, request: planned(req) };
        }
      }
      return write({ method: 'POST', path: path('/v1/missions/:id/strategy', str(i['missionId'])), body: i['content'] }, i['dry_run'] as boolean | undefined);
    },

    async plune_report_request(i) {
      return write({ method: 'POST', path: path('/v1/missions/:id/report', str(i['missionId'])), body: {} }, i['dry_run'] as boolean | undefined);
    },

    async plune_discover_tools(i) {
      const names = (i['names'] as string[] | undefined) ?? [];
      const unknown = names.filter((n) => !isPluneToolName(n));
      if (unknown.length > 0) return fail('invalid_input', `No such tool: ${unknown.join(', ')}. Call this tool without names to see what there is.`);
      const refused = names.filter((n) => scope === 'read' && pluneTool(n).write);
      if (refused.length > 0) return fail('read_only_token', readScopeMessage(`${refused.join(', ')} cannot be switched on`));
      const fixed = opts.fixedToolList === true;
      if (!fixed) for (const n of names as PluneToolName[]) revealed.add(n);
      const words = ((i['query'] as string | undefined) ?? '').toLowerCase().split(/\s+/).filter(Boolean);
      const visible = visibleTools();
      const available = PLUNE_TOOLS.filter((t) => !visible.includes(t.name) && !(scope === 'read' && t.write))
        .filter((t) => words.every((w) => `${t.name} ${t.title} ${t.description}`.toLowerCase().includes(w)))
        .map((t) => ({
          name: t.name,
          title: t.title,
          description: t.description,
          write: t.write,
          ...(fixed ? { inputSchema: z.toJSONSchema(t.input, { target: 'draft-2020-12', io: 'input' }) } : {}),
        }));
      return { revealed: fixed ? [] : names, available, visible };
    },

    async plune_cases_update(i) {
      const cases = i['cases'] as { id: string; changes: Record<string, unknown> }[];
      return batch(
        cases.map((c) => ({ method: 'PATCH', path: path('/v1/test-cases/:id', c.id), body: c.changes })),
        i['dry_run'] as boolean | undefined,
        (_b, n) => cases[n]?.id,
      );
    },

    async plune_run_create(i) {
      return write({ method: 'POST', path: '/v1/runs', body: i['run'] }, i['dry_run'] as boolean | undefined);
    },

    async plune_results_write(i) {
      const results = i['results'] as unknown[];
      const req: ApiRequest = {
        method: 'POST',
        path: path('/v1/runs/:id/results', str(i['runId'])),
        body: withoutUndefined({ results, combination: i['combination'], configuration: i['configuration'] }),
      };
      if (i['dry_run'] === true) return { dryRun: true, requested: results.length, applied: 0, requests: [planned(req)] };
      const report = asRecord((await call(req)).body);
      const accepted = asRecord(report['counts'])['accepted'];
      return { dryRun: false, requested: results.length, applied: typeof accepted === 'number' ? accepted : 0, report };
    },

    async plune_endpoint_propose(i) {
      return batch(
        (i['endpoints'] as Record<string, unknown>[]).map((e) => ({ method: 'POST', path: '/v1/review-items/endpoints', body: withoutUndefined(e) })),
        i['dry_run'] as boolean | undefined,
        (b) => asRecord(b)['id'] as string | undefined,
      );
    },

    async plune_api_request(i) {
      const method = str(i['method']);
      const p = safePath(opts.apiUrl, str(i['path']));
      if (p === undefined) return fail('invalid_input', `path must be a path under /v1 on ${new URL(opts.apiUrl).origin}, e.g. /v1/suites — no host, no dot segments, no query (use query)`);
      const query = i['query'] as Record<string, string> | undefined;
      const req: ApiRequest = withoutUndefined({ method, path: p, query, body: i['body'] }) as ApiRequest;
      if (i['dry_run'] === true) return { dryRun: true, request: planned(req) };
      const confirm = i['confirm'] as string | undefined;
      if (isDeletion(req)) {
        const t = now();
        for (const [k, v] of confirms) if (v.expires <= t) confirms.delete(k);
        if (confirm === undefined) {
          const value = randomBytes(24).toString('base64url');
          confirms.set(value, { fingerprint: fingerprint(req), expires: t + CONFIRM_TTL_MS });
          return {
            preview: {
              action: 'delete',
              method,
              path: p,
              confirm: value,
              expiresInSeconds: CONFIRM_TTL_MS / 1000,
              note: 'Nothing was sent. Repeat the same call with confirm to send it. The platform refuses an agent any deletion (agent_cannot_delete, bulk_delete_needs_person): a person deletes from the dashboard.',
            },
          };
        }
        const held = confirms.get(confirm);
        confirms.delete(confirm);
        if (held === undefined || held.fingerprint !== fingerprint(req))
          return fail('confirm_invalid', 'confirm is unknown, expired, used, or for another request — repeat the call without it to get a new preview');
      } else if (confirm !== undefined) {
        req.query = { ...query, confirm };
      }
      const res = await call(req);
      return { status: res.status, body: res.body };
    },
  };

  return {
    sessionId,
    scope: () => scope,
    visibleTools,
    async execute(name, input) {
      const handler = isPluneToolName(name) ? handlers[name] : undefined;
      if (handler === undefined) return fail('unknown_tool', `No such tool: ${name}.`);
      const tool = pluneTool(name as PluneToolName);
      const parsed = tool.input.safeParse(input ?? {});
      if (!parsed.success) return fail('invalid_input', `The input does not fit: ${zodMessage(parsed.error)}`);
      const args = parsed.data as Record<string, unknown>;
      const writes = name === 'plune_api_request' ? rawWrites(str(args['method']), str(args['path'])) : tool.write;
      if (writes && scope === 'read' && args['dry_run'] !== true) return fail('read_only_token', readScopeMessage(`${name} is refused before any request`));
      try {
        const out = await handler(args);
        return 'ok' in out && typeof out['ok'] === 'boolean' && ('error' in out || 'data' in out) ? (out as ToolOutcome) : { ok: true, data: out };
      } catch (err) {
        return { ok: false, error: errorOf(err) };
      }
    },
  };
}
