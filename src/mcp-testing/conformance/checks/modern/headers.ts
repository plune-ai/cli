/**
 * The request headers of the 2026-07-28 Streamable HTTP transport (basic/transports/streamable-http, Request
 * Metadata): each probe is one POST of this run's own, a correct modern request but for the one header it changes,
 * read from its status and its JSON-RPC answer. Over stdio none of these applies.
 */

import type { CheckOutcome } from '../../outcome.js';
import { exchange, header, rawRequest, type Exchange } from '../../raw-http.js';
import { UNKNOWN_METHOD } from '../base.js';
import type { ConformanceCheck, ConformanceContext } from '../index.js';
import { tools } from '../tools.js';
import { ask, frameOf, message, target, type Asked } from '../transport.js';
import {
  declares,
  failed,
  isObject,
  isOutcome,
  nextId,
  notOffered,
  passed,
  some,
  supportedVersions,
  dualEra,
  walk,
} from '../wire.js';
import { headerMarks, paramHeaders, staticallyReachable } from './meta.js';

const own = (ctx: ConformanceContext) => ({ version: ctx.protocolVersion ?? '2026-07-28' });

/** The JSON-RPC error code of an answer, when it is one. */
const codeOf = (a: Asked): unknown => {
  const e = a.frame?.['error'];
  return isObject(e) ? e['code'] : undefined;
};
const mismatch = (a: Asked) => a.res.status === 400 && codeOf(a) === -32020;
/** HTTP status and what the body said, for `actual`. */
const got = (a: Asked): string => {
  const code = codeOf(a);
  const what = code !== undefined ? `error ${String(code)}` : isObject(a.frame?.['result']) ? 'a result' : 'no JSON-RPC answer';
  return `HTTP ${a.res.status} and ${what}`;
};

/** Outcome of probes that each must be refused with 400 and -32020. */
function refusedEach(probes: [string, Asked][], fix: string): CheckOutcome {
  const details = probes.map(([, a]) => a.detail);
  const wrong = probes.filter(([, a]) => !mismatch(a)).map(([what, a]) => `${what} got ${got(a)}`);
  if (wrong.length > 0) return { ...failed(`${wrong.join('; ')}.`, fix), details };
  return { ...passed(`${probes.map(([what]) => what).join('; ')}: each got HTTP 400 and -32020.`), details };
}

const unimplementedMethod: ConformanceCheck = async (ctx) => {
  const a = await ask(ctx, own(ctx), UNKNOWN_METHOD);
  if (a.res.status === 404 && codeOf(a) === -32601)
    return { ...passed(`${UNKNOWN_METHOD} got HTTP 404 and -32601.`), details: [a.detail] };
  return {
    ...failed(`${UNKNOWN_METHOD} got ${got(a)}.`, 'Answer a method the server does not implement with 404 Not Found and the error -32601.'),
    details: [a.detail],
  };
};

const versionMismatch: ConformanceCheck = async (ctx) =>
  refusedEach(
    [['MCP-Protocol-Version: 2025-11-25 on a body for 2026-07-28', await ask(ctx, own(ctx), 'server/discover', { set: [['MCP-Protocol-Version', '2025-11-25']] })]],
    'Refuse a request whose MCP-Protocol-Version differs from the version in its _meta with 400 and -32020 (HeaderMismatch).',
  );

const methodMismatch: ConformanceCheck = async (ctx) =>
  refusedEach(
    [['Mcp-Method: tools/list on server/discover', await ask(ctx, own(ctx), 'server/discover', { set: [['Mcp-Method', 'tools/list']] })]],
    'Refuse a request whose Mcp-Method differs from its method with 400 and -32020 (HeaderMismatch).',
  );

/** A request that carries Mcp-Name: the first resource, else the first prompt, else the first --fixture tool. */
interface Named {
  method: string;
  name: string;
  params: Record<string, unknown>;
}

async function namedTargets(ctx: ConformanceContext): Promise<Named[]> {
  return ctx.memo('named targets', async () => {
    const out: Named[] = [];
    if (declares(ctx, 'resources'))
      for (const r of (await walk(ctx, 'resources/list', 'resources')).items)
        if (isObject(r) && typeof r['uri'] === 'string') out.push({ method: 'resources/read', name: r['uri'], params: { uri: r['uri'] } });
    if (declares(ctx, 'prompts'))
      for (const p of (await walk(ctx, 'prompts/list', 'prompts')).items)
        if (isObject(p) && typeof p['name'] === 'string') out.push({ method: 'prompts/get', name: p['name'], params: { name: p['name'] } });
    if (declares(ctx, 'tools') && ctx.fixture !== undefined) {
      const listed = (await walk(ctx, 'tools/list', 'tools')).items;
      for (const c of ctx.fixture)
        if (listed.some((t) => isObject(t) && t['name'] === c.tool))
          out.push({ method: 'tools/call', name: c.tool, params: { name: c.tool, arguments: c.arguments } });
    }
    return out;
  });
}

/** The same name in another case, or with a suffix when it has no letter: a value that differs only in case. */
const otherCase = (name: string): string => {
  const swapped = [...name].map((c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase())).join('');
  return swapped !== name ? swapped : `${name}-other`;
};

const nameMismatch: ConformanceCheck = async (ctx) => {
  const [t] = await namedTargets(ctx);
  if (t === undefined) return notOffered('No resource, no prompt and no --fixture tool to send Mcp-Name for.');
  return refusedEach(
    [[`${t.method} ${t.name} with Mcp-Name: ${otherCase(t.name)}`, await ask(ctx, own(ctx), t.method, { params: t.params, set: [['Mcp-Name', otherCase(t.name)]] })]],
    'Refuse a request whose Mcp-Name differs from params.name or params.uri, compared case-sensitively, with 400 and -32020.',
  );
};

const missingRejected: ConformanceCheck = async (ctx) => {
  const probes: [string, Asked][] = [];
  // A server that serves clients before 2025-06-18 MAY take a request without the header as 2025-03-26.
  const old = supportedVersions(ctx).filter((v) => v < '2025-06-18');
  if (old.length === 0)
    probes.push(['server/discover without MCP-Protocol-Version', await ask(ctx, own(ctx), 'server/discover', { drop: ['MCP-Protocol-Version'] })]);
  probes.push(['server/discover without Mcp-Method', await ask(ctx, own(ctx), 'server/discover', { drop: ['Mcp-Method'] })]);
  const [t] = await namedTargets(ctx);
  if (t !== undefined)
    probes.push([`${t.method} ${t.name} without Mcp-Name`, await ask(ctx, own(ctx), t.method, { params: t.params, drop: ['Mcp-Name'] })]);
  const outcome = refusedEach(probes, 'Refuse a request without MCP-Protocol-Version, Mcp-Method or (for tools/call, resources/read, prompts/get) Mcp-Name with 400 and -32020.');
  const note = old.length > 0 ? ` Not counted: the request without MCP-Protocol-Version, as supportedVersions names ${some(old)}.` : '';
  return { ...outcome, actual: `${outcome.actual ?? ''}${note}` };
};

const caseInsensitive: ConformanceCheck = async (ctx) => {
  const t = target(ctx);
  const host = new URL(t.url).host;
  const details: Exchange[] = [];
  const wrong: string[] = [];
  for (const [what, rename] of [
    ['lower case', (n: string) => n.toLowerCase()],
    ['upper case', (n: string) => n.toUpperCase()],
  ] as const) {
    const id = nextId();
    const base = message(ctx, own(ctx), 'server/discover', id);
    // A Host of its own sends the request through node:http, which keeps the names as written.
    const req = { ...base, headers: [...base.headers.map(([n, v]) => [rename(n), v] as [string, string]), ['Host', host] as [string, string]] };
    const res = await rawRequest(t, req, { stopWhen: (e) => e.data.includes(id) });
    details.push(exchange(t, req, res));
    const frame = frameOf(res, id);
    if (res.status !== 200 || !isObject(frame?.['result'])) wrong.push(`header names in ${what} got HTTP ${res.status}${isObject(frame?.['error']) ? ` and error ${String((frame['error'] as Record<string, unknown>)['code'])}` : ''}`);
  }
  if (wrong.length > 0)
    return { ...failed(`server/discover with ${wrong.join('; ')}.`, 'Compare header names without regard to case.'), details };
  return { ...passed('server/discover answered a result with its header names in lower case and in upper case.'), details };
};

const base64Name: ConformanceCheck = async (ctx) => {
  const targets = await namedTargets(ctx);
  const t = targets.find((x) => !/^[\x20-\x7e]*$/.test(x.name)) ?? targets[0];
  if (t === undefined) return notOffered('No resource, no prompt and no --fixture tool to send Mcp-Name for.');
  const encoded = `=?base64?${Buffer.from(t.name, 'utf8').toString('base64')}?=`;
  const a = await ask(ctx, own(ctx), t.method, { params: t.params, set: [['Mcp-Name', encoded]] });
  if (mismatch(a))
    return {
      ...failed(`${t.method} ${t.name} with Mcp-Name: ${encoded} got HTTP 400 and -32020.`, 'Decode an Mcp-Name of the form =?base64?…?= before comparing it with the body.'),
      details: [a.detail],
    };
  return { ...passed(`${t.method} ${t.name} with Mcp-Name: ${encoded} got ${got(a)}, not a HeaderMismatch.`), details: [a.detail] };
};

/** A --fixture tool with an x-mcp-header parameter that its arguments give a value. */
async function paramTarget(ctx: ConformanceContext) {
  const list = await tools(ctx);
  if (isOutcome(list)) return list;
  for (const c of ctx.fixture ?? []) {
    const tool = list.find((t): t is Record<string, unknown> => isObject(t) && t['name'] === c.tool);
    const [first] = tool === undefined ? [] : paramHeaders(tool, c.arguments);
    if (first !== undefined) return { call: c, header: first };
  }
  return undefined;
}

const paramMismatch: ConformanceCheck = async (ctx) => {
  if (ctx.fixture === undefined)
    return { state: 'could-not-run', reason: 'needs-input', actual: 'No --fixture: no tool is called without one. Name a tool with an x-mcp-header parameter to run this check.' };
  const p = await paramTarget(ctx);
  if (p !== undefined && 'state' in p) return p;
  if (p === undefined) return notOffered('No --fixture tool has an x-mcp-header parameter with a value in its arguments.');
  const [name] = p.header;
  const params = { name: p.call.tool, arguments: p.call.arguments };
  return refusedEach(
    [
      [`tools/call ${p.call.tool} with ${name}: plune-conformance-wrong`, await ask(ctx, own(ctx), 'tools/call', { params, set: [[name, 'plune-conformance-wrong']] })],
      [`tools/call ${p.call.tool} without ${name}`, await ask(ctx, own(ctx), 'tools/call', { params })],
    ],
    'Refuse a tools/call whose Mcp-Param header is missing or differs from the argument with 400 and -32020.',
  );
};

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** What is wrong with the x-mcp-header annotations of one inputSchema. */
export function headerDeclarationProblems(schema: unknown): string[] {
  const problems: string[] = [];
  const seen = new Map<string, string>();
  for (const m of headerMarks(schema)) {
    const where = m.path.join('.') || '(root)';
    if (typeof m.value !== 'string' || m.value === '') problems.push(`${where}: x-mcp-header is ${JSON.stringify(m.value)}, not a non-empty string`);
    else if (!TOKEN.test(m.value)) problems.push(`${where}: x-mcp-header ${JSON.stringify(m.value)} is not an HTTP token`);
    else {
      const key = m.value.toLowerCase();
      if (seen.has(key)) problems.push(`${where}: x-mcp-header ${m.value} repeats ${seen.get(key) ?? ''} without regard to case`);
      seen.set(key, m.value);
    }
    if (!staticallyReachable(m.path)) problems.push(`${where}: not reached through properties alone`);
    else if (!['string', 'integer', 'boolean'].includes(m.schema['type'] as string))
      problems.push(`${where}: on a property of type ${JSON.stringify(m.schema['type']) ?? 'none'}, not string, integer or boolean`);
  }
  return problems;
}

const declarations: ConformanceCheck = async (ctx) => {
  const list = await tools(ctx);
  if (isOutcome(list)) return list;
  const marked = list.filter((t) => isObject(t) && headerMarks(t['inputSchema']).length > 0) as Record<string, unknown>[];
  if (marked.length === 0) return notOffered('No tool marks a parameter with x-mcp-header.');
  const bad = marked.flatMap((t) => headerDeclarationProblems(t['inputSchema']).map((p) => `${String(t['name'])} ${p}`));
  if (bad.length > 0)
    return failed(`${some(bad, 3)}.`, 'Put x-mcp-header (a unique HTTP token) only on string, integer or boolean properties reached through properties.');
  return passed(`${marked.length} tool${marked.length === 1 ? '' : 's'} with x-mcp-header: every declaration is valid.`);
};

const noSessionId: ConformanceCheck = async (ctx) => {
  if (dualEra(ctx))
    return { state: 'not-applicable', reason: 'era', actual: `server/discover names ${some(supportedVersions(ctx))}: a dual-era server may use sessions.` };
  const a = await ask(ctx, own(ctx), 'server/discover', { set: [['Mcp-Session-Id', 'plune-conformance-session']] });
  const sid = header(a.res.headers, 'mcp-session-id');
  if (sid === undefined) return { ...passed('server/discover sent with Mcp-Session-Id got an answer without one.'), details: [a.detail] };
  return {
    ...failed(
      `server/discover sent with Mcp-Session-Id got Mcp-Session-Id: ${sid}${sid === 'plune-conformance-session' ? ' (echoed)' : ''}.`,
      'Ignore an Mcp-Session-Id on a request: neither mint nor echo a session id.',
    ),
    details: [a.detail],
  };
};

export const HEADERS: Record<string, ConformanceCheck> = {
  'mod-unimplemented-method': unimplementedMethod,
  'mod-header-protocol-version-mismatch': versionMismatch,
  'mod-header-method-mismatch': methodMismatch,
  'mod-header-name-mismatch': nameMismatch,
  'mod-header-missing-rejected': missingRejected,
  'mod-header-names-case-insensitive': caseInsensitive,
  'mod-header-name-base64-decoded': base64Name,
  'mod-param-header-mismatch': paramMismatch,
  'mod-x-mcp-header-declarations': declarations,
  'mod-no-session-id': noSessionId,
};
