/**
 * The 2026-07-28 revision on any transport: server/discover, the per-request metadata, the removed methods, a server
 * without connection state, the not-found answer of resources/read, the caching hints, and the -32021 answer to a
 * capability the client did not declare. Each request goes over the session's raw layer with the modern `_meta`
 * (../wire.ts), or with a field of it left out where that is the probe.
 */

import type { Session } from '../../../connect/session.js';
import type { CheckOutcome } from '../../outcome.js';
import type { ConformanceCheck, ConformanceContext } from '../index.js';
import { fixtureCalls, tools } from '../tools.js';
import {
  call,
  callAsIs,
  capabilities,
  declares,
  failed,
  isObject,
  isOutcome,
  label,
  notDeclared,
  notOffered,
  passed,
  prerequisite,
  said,
  some,
  walk,
  type Answer,
} from '../wire.js';
import { CLIENT, META, modernMeta } from './meta.js';

const version = (ctx: ConformanceContext) => ctx.protocolVersion ?? '2026-07-28';
const http = (ctx: ConformanceContext) => ctx.transport === 'http';
/** ` (HTTP 404)` over HTTP: the status an answer came with. */
const status = (a: Answer) => (a.status === undefined ? '' : ` (HTTP ${a.status})`);
const isError = (a: Answer, code: number): a is Extract<Answer, { kind: 'error' }> => a.kind === 'error' && a.code === code;

/** What is wrong with a DiscoverResult; empty when it has all it must. */
export function discoverProblems(result: Record<string, unknown>, revision: string): string[] {
  const problems: string[] = [];
  if (result['resultType'] !== 'complete') problems.push(`resultType is ${JSON.stringify(result['resultType']) ?? 'missing'}, not "complete"`);
  const versions = result['supportedVersions'];
  if (!Array.isArray(versions) || versions.length === 0 || versions.some((v) => typeof v !== 'string'))
    problems.push('supportedVersions is not a non-empty list of strings');
  else if (!versions.includes(revision)) problems.push(`supportedVersions does not name ${revision}, the revision it answered for`);
  if (!isObject(result['capabilities'])) problems.push('capabilities is missing or not an object');
  return problems;
}

const discoverResult: ConformanceCheck = async (ctx) => {
  const a = ctx.discover;
  if (a === undefined) return prerequisite('server/discover was not asked.');
  if (isError(a, -32022))
    return prerequisite(`server/discover for ${version(ctx)} answered -32022: the server does not support the revision of this run.`);
  if (a.kind !== 'result')
    return failed(`server/discover answered ${said(a)}${status(a)}.`, 'Implement server/discover and answer it with a DiscoverResult.');
  const problems = discoverProblems(a.result, version(ctx));
  if (problems.length > 0)
    return failed(
      `server/discover answered, but ${problems.join('; ')}.`,
      'Answer server/discover with resultType "complete", supportedVersions (naming the requested revision) and capabilities.',
    );
  const versions = a.result['supportedVersions'] as string[];
  return passed(`DiscoverResult: supportedVersions ${some(versions)}, capabilities {${Object.keys(capabilities(ctx)).join(', ')}}.`);
};

const discoverServerInfo: ConformanceCheck = async (ctx) => {
  const a = ctx.discover;
  if (a?.kind !== 'result') return prerequisite('server/discover answered no result.');
  const meta = a.result['_meta'];
  const info = isObject(meta) ? meta[META.serverInfo] : undefined;
  if (isObject(info) && typeof info['name'] === 'string' && typeof info['version'] === 'string')
    return passed(`_meta names the server: ${info['name']} ${info['version']}.`);
  return failed(
    isObject(info) ? 'io.modelcontextprotocol/serverInfo has no string name and version.' : 'The DiscoverResult has no _meta["io.modelcontextprotocol/serverInfo"].',
    'Name the server in _meta["io.modelcontextprotocol/serverInfo"] of the DiscoverResult: { name, version }.',
  );
};

const metaRequired: ConformanceCheck = async (ctx) => {
  const full = modernMeta(version(ctx));
  const probes: [string, Record<string, unknown>, number[]][] = [
    // Over HTTP the header still says the version the body leaves out: HeaderMismatch is an answer as well.
    ['without protocolVersion', { [META.client]: CLIENT, [META.capabilities]: {} }, http(ctx) ? [-32602, -32020] : [-32602]],
    ['without clientCapabilities', { [META.version]: full[META.version], [META.client]: CLIENT }, [-32602]],
  ];
  const wrong: string[] = [];
  const got: string[] = [];
  // Each probe on a connection of its own: a dual-era server may take a request without a version for the legacy era
  // and keep the process there, which would change what every later check on the shared connection reads.
  for (const [what, meta, codes] of probes) {
    const a = await fresh(ctx, (other) => callAsIs(other, 'server/discover', { _meta: meta }));
    got.push(`${what}: ${said(a)}${status(a)}`);
    const code = a.kind === 'error' && typeof a.code === 'number' && codes.includes(a.code);
    if (!code || (http(ctx) && a.status !== 400)) wrong.push(`${what} answered ${said(a)}${status(a)}`);
  }
  if (wrong.length > 0)
    return failed(
      `server/discover ${wrong.join('; ')}.`,
      `Reject a request whose _meta lacks a required field with -32602 (Invalid params)${http(ctx) ? ' and HTTP 400' : ''}.`,
    );
  return passed(`server/discover ${got.join('; ')}.`);
};

const unsupportedVersion: ConformanceCheck = async (ctx) => {
  // On a connection of its own, so the verdict does not depend on what the checks before it sent on the shared one.
  const a = await fresh(ctx, (other) =>
    callAsIs(other, 'server/discover', { _meta: { ...modernMeta(version(ctx)), [META.version]: '1900-01-01' } }),
  );
  const data = a.kind === 'error' && isObject(a.frame['error']) ? (a.frame['error'] as Record<string, unknown>)['data'] : undefined;
  const supported = isObject(data) ? data['supported'] : undefined;
  const problems: string[] = [];
  if (!isError(a, -32022)) problems.push(`answered ${said(a)}, not -32022`);
  else if (!Array.isArray(supported) || supported.length === 0) problems.push('data.supported is not a non-empty list');
  if (http(ctx) && a.status !== 400) problems.push(`got HTTP ${a.status ?? 'no status'}, not 400`);
  if (problems.length > 0)
    return failed(
      `server/discover for 1900-01-01 ${problems.join('; ')}.`,
      `Answer a request for a revision the server does not support with -32022 and data.supported${http(ctx) ? ', HTTP 400' : ''}.`,
    );
  return passed(`server/discover for 1900-01-01 answered -32022, supported ${some((supported as unknown[]).map(String))}${status(a)}.`);
};

/** The methods the revision removed, with params a legacy server would take. */
const REMOVED: [string, Record<string, unknown>][] = [
  ['ping', {}],
  ['logging/setLevel', { level: 'info' }],
  ['resources/subscribe', { uri: 'plune-conformance://removed' }],
  ['resources/unsubscribe', { uri: 'plune-conformance://removed' }],
];

/** The answer to a request on a new connection, which is closed after it. */
export async function fresh<T>(ctx: ConformanceContext, ask: (other: ConformanceContext) => Promise<T>): Promise<T> {
  if (ctx.connect === undefined) throw new Error('A new connection is not available to this check.');
  const session: Session = await ctx.connect();
  try {
    const memos = new Map<string, Promise<unknown>>();
    return await ask({
      ...ctx,
      session,
      memo: <V>(key: string, make: () => Promise<V>) => {
        if (!memos.has(key)) memos.set(key, make());
        return memos.get(key) as Promise<V>;
      },
    });
  } finally {
    await session.close();
  }
}

const removedMethods: ConformanceCheck = async (ctx) => {
  const wrong: string[] = [];
  const notFound = (a: Answer) => isError(a, -32601) && (!http(ctx) || a.status === 404);
  for (const [method, params] of REMOVED) {
    const a = await call(ctx, method, params);
    if (!notFound(a)) wrong.push(`${method} answered ${said(a)}${status(a)}`);
  }
  // initialize on a connection of its own: over stdio it would put a dual-era process into the legacy era.
  const init = await fresh(ctx, (other) =>
    call(other, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: CLIENT }),
  );
  const dual = init.kind === 'result' && typeof init.result['protocolVersion'] === 'string';
  if (!dual && !notFound(init)) wrong.push(`initialize answered ${said(init)}${status(init)}`);
  const note = dual ? ' initialize answered an initialize result: a dual-era server, not counted.' : '';
  if (wrong.length > 0)
    return failed(
      `${wrong.join('; ')}.${note}`,
      `Answer the methods 2026-07-28 removed with -32601 (Method not found)${http(ctx) ? ' and HTTP 404' : ''}.`,
    );
  return passed(`ping, logging/setLevel, resources/subscribe, resources/unsubscribe${dual ? '' : ' and initialize'} answered -32601.${note}`);
};

/** The lists of the declared capabilities: tools/list first. */
const LISTS = [
  ['tools', 'tools/list', 'tools'],
  ['prompts', 'prompts/list', 'prompts'],
  ['resources', 'resources/list', 'resources'],
] as const;

const statelessNoPriorContext: ConformanceCheck = async (ctx) => {
  const list = LISTS.find(([cap]) => declares(ctx, cap));
  if (list === undefined) return notDeclared('tools, prompts or resources');
  const [, method] = list;
  const a = await fresh(ctx, (other) => call(other, method));
  if (a.kind === 'result') return passed(`${method}, the first request on a new connection, answered a result.`);
  return failed(
    `${method}, the first request on a new connection, answered ${said(a)}${status(a)}.`,
    'Serve every request from its own _meta: no request (server/discover or another) may be needed before it on a connection.',
  );
};

/** The labels of a walked list, sorted: the set of entries, whatever their order. */
async function entrySet(ctx: ConformanceContext, method: string, field: string): Promise<string[] | Answer> {
  const w = await walk(ctx, method, field);
  if (w.stop !== undefined) return w.stop;
  return w.items.map(label).sort();
}

const listStable: ConformanceCheck = async (ctx) => {
  const lists = LISTS.filter(([cap]) => declares(ctx, cap));
  if (lists.length === 0) return notDeclared('tools, prompts or resources');
  const here = new Map<string, string[] | Answer>();
  for (const [, method, field] of lists) here.set(method, await entrySet(ctx, method, field));
  const there = await fresh(ctx, async (other) => {
    // server/discover first, as a client would: statelessness is mod-stateless-no-prior-context's to judge.
    await call(other, 'server/discover');
    const m = new Map<string, string[] | Answer>();
    for (const [, method, field] of lists) m.set(method, await entrySet(other, method, field));
    return m;
  });
  const differ: string[] = [];
  for (const [, method] of lists) {
    const a = here.get(method);
    const b = there.get(method);
    if (!Array.isArray(a) || !Array.isArray(b)) {
      const refused = !Array.isArray(a) ? a : (b as Answer);
      return prerequisite(`${method} answered ${said(refused as Answer)}.`);
    }
    if (a.join('\n') !== b.join('\n')) {
      const only = (x: string[], y: string[]) => x.filter((e) => !y.includes(e));
      differ.push(`${method}: only on the run's connection ${some(only(a, b)) || 'none'}, only on a new one ${some(only(b, a)) || 'none'}`);
    }
  }
  if (differ.length > 0)
    return failed(`${differ.join('; ')}.`, 'Answer the same lists on every connection: never vary them by connection or by other requests on it.');
  return passed(`${lists.map(([, m]) => m).join(', ')}: the same entries on the run's connection and on a new one.`);
};

const MISSING_URI = 'plune-conformance://no-such-resource';
const readMissing = (ctx: ConformanceContext) => ctx.memo('read missing', () => call(ctx, 'resources/read', { uri: MISSING_URI }));

const resourceNotFound: ConformanceCheck = async (ctx) => {
  if (!declares(ctx, 'resources')) return notDeclared('resources');
  const a = await readMissing(ctx);
  if (isError(a, -32602)) return passed(`resources/read of ${MISSING_URI} answered -32602.`);
  return failed(
    `resources/read of ${MISSING_URI} answered ${said(a)}${isError(a, -32002) ? ', the code earlier revisions used' : ''}.`,
    'Answer resources/read of a resource that does not exist with -32602 (Invalid params), not -32002.',
  );
};

const resourceNoEmptyContents: ConformanceCheck = async (ctx) => {
  if (!declares(ctx, 'resources')) return notDeclared('resources');
  const a = await readMissing(ctx);
  const contents = a.kind === 'result' ? a.result['contents'] : undefined;
  if (Array.isArray(contents) && contents.length === 0)
    return failed(`resources/read of ${MISSING_URI} answered a result with contents: [].`, 'Answer a resource that does not exist with an error, never with empty contents.');
  return passed(`resources/read of ${MISSING_URI} answered ${said(a)}, not empty contents.`);
};

/** A cacheable result, by where it came from. */
interface Cacheable {
  where: string;
  result: Record<string, unknown>;
}

/** The cacheable results of the run: server/discover, every page of each declared list, and one resources/read. */
function cacheables(ctx: ConformanceContext): Promise<{ results: Cacheable[]; pages: Cacheable[][] } | CheckOutcome> {
  return ctx.memo('cacheables', async () => {
    const results: Cacheable[] = [];
    const pages: Cacheable[][] = [];
    if (ctx.discover?.kind === 'result') results.push({ where: 'server/discover', result: ctx.discover.result });
    const lists: [string, string, string][] = [
      ['tools', 'tools/list', 'tools'],
      ['prompts', 'prompts/list', 'prompts'],
      ['resources', 'resources/list', 'resources'],
      ['resources', 'resources/templates/list', 'resourceTemplates'],
    ];
    for (const [cap, method, field] of lists) {
      if (!declares(ctx, cap)) continue;
      const w = await walk(ctx, method, field);
      if (w.stop !== undefined) return prerequisite(`${method} answered ${said(w.stop)}.`);
      const own = w.results.map((result, i) => ({ where: w.results.length > 1 ? `${method} page ${i + 1}` : method, result }));
      results.push(...own);
      pages.push(own);
    }
    if (declares(ctx, 'resources')) {
      const first = (await walk(ctx, 'resources/list', 'resources')).items.find((r) => isObject(r) && typeof r['uri'] === 'string');
      if (isObject(first)) {
        const a = await call(ctx, 'resources/read', { uri: first['uri'] });
        if (a.kind === 'result') results.push({ where: `resources/read ${String(first['uri'])}`, result: a.result });
      }
    }
    return { results, pages };
  });
}

const complete = (c: Cacheable) => c.result['resultType'] !== 'input_required';

const cacheHints: ConformanceCheck = async (ctx) => {
  const c = await cacheables(ctx);
  if (!('results' in c)) return c;
  const checked = c.results.filter(complete);
  const missing = checked.filter((r) => !('ttlMs' in r.result) || !('cacheScope' in r.result));
  if (missing.length > 0)
    return failed(
      `No ttlMs or cacheScope on: ${some(missing.map((r) => `${r.where} (${['ttlMs', 'cacheScope'].filter((k) => !(k in r.result)).join(' and ')} missing)`))}.`,
      'Give every complete result of server/discover, the lists and resources/read a ttlMs and a cacheScope.',
    );
  return passed(`${checked.length} cacheable result${checked.length === 1 ? '' : 's'} (${some(checked.map((r) => r.where))}) carry ttlMs and cacheScope.`);
};

const cacheTtl: ConformanceCheck = async (ctx) => {
  const c = await cacheables(ctx);
  if (!('results' in c)) return c;
  const given = c.results.filter((r) => 'ttlMs' in r.result);
  if (given.length === 0) return notOffered('No result carries ttlMs (mod-cache-hints-coverage judges that).');
  const bad = given.filter((r) => !Number.isInteger(r.result['ttlMs']) || (r.result['ttlMs'] as number) < 0);
  if (bad.length > 0)
    return failed(`ttlMs is not an integer of 0 or more on: ${some(bad.map((r) => `${r.where} (${JSON.stringify(r.result['ttlMs'])})`))}.`, 'Give ttlMs as an integer number of milliseconds, 0 or more.');
  return passed(`ttlMs on ${given.length} result${given.length === 1 ? '' : 's'} is an integer of 0 or more.`);
};

const cacheScope: ConformanceCheck = async (ctx) => {
  const c = await cacheables(ctx);
  if (!('results' in c)) return c;
  const given = c.results.filter((r) => 'cacheScope' in r.result);
  if (given.length === 0) return notOffered('No result carries cacheScope (mod-cache-hints-coverage judges that).');
  const bad = given.filter((r) => r.result['cacheScope'] !== 'public' && r.result['cacheScope'] !== 'private');
  if (bad.length > 0)
    return failed(`cacheScope is neither "public" nor "private" on: ${some(bad.map((r) => `${r.where} (${JSON.stringify(r.result['cacheScope'])})`))}.`, 'Give cacheScope as "public" or "private".');
  return passed(`cacheScope on ${given.length} result${given.length === 1 ? '' : 's'} is "public" or "private".`);
};

const cacheScopePages: ConformanceCheck = async (ctx) => {
  const c = await cacheables(ctx);
  if (!('results' in c)) return c;
  const paged = c.pages.filter((p) => p.length > 1);
  if (paged.length === 0) return notOffered('No declared list came in more than one page.');
  const bad = paged.filter((p) => new Set(p.map((r) => JSON.stringify(r.result['cacheScope']))).size > 1);
  if (bad.length > 0)
    return failed(
      `Pages of one list differ in cacheScope: ${some(bad.map((p) => p.map((r) => `${r.where} ${JSON.stringify(r.result['cacheScope']) ?? 'none'}`).join(', ')))}.`,
      'Apply the cacheScope of the first page to every page of the list.',
    );
  return passed(`${paged.length} paginated list${paged.length === 1 ? '' : 's'}: one cacheScope on every page.`);
};

/** The client capability an input request of an InputRequiredResult relies on. */
const CAPABILITY_OF: Record<string, string> = {
  'sampling/createMessage': 'sampling',
  'elicitation/create': 'elicitation',
  'roots/list': 'roots',
};

const undeclaredCapability: ConformanceCheck = async (ctx) => {
  if (ctx.fixture === undefined)
    return {
      state: 'could-not-run',
      reason: 'needs-input',
      actual: 'No --fixture: no tool is called without one. Name a tool that needs sampling, elicitation or roots to run this check.',
    };
  const list = await tools(ctx);
  if (isOutcome(list)) return list;
  const wrong: string[] = [];
  const right: string[] = [];
  for (const { call: c, answer } of await fixtureCalls(ctx, list)) {
    if (answer === undefined) continue;
    if (answer.kind === 'result' && answer.result['resultType'] === 'input_required') {
      const requests = answer.result['inputRequests'];
      const methods = isObject(requests)
        ? Object.values(requests).flatMap((r) => (isObject(r) && typeof r['method'] === 'string' ? [r['method']] : []))
        : [];
      const needed = [...new Set(methods.map((m) => CAPABILITY_OF[m]).filter((x): x is string => x !== undefined))];
      if (needed.length > 0) wrong.push(`${c.tool} asked for ${needed.join(', ')} by input_required, which the client did not declare`);
    } else if (isError(answer, -32021)) {
      const error = answer.frame['error'] as Record<string, unknown>;
      const data = error['data'];
      const required = isObject(data) ? data['requiredCapabilities'] : undefined;
      if (!isObject(required) || Object.keys(required).length === 0)
        wrong.push(`${c.tool} answered -32021 without data.requiredCapabilities naming a capability`);
      else if (http(ctx) && answer.status !== 400) wrong.push(`${c.tool} answered -32021 with HTTP ${answer.status ?? 'no status'}, not 400`);
      else right.push(`${c.tool}: -32021 for ${Object.keys(required).join(', ')}`);
    }
  }
  if (wrong.length > 0)
    return failed(
      `${wrong.join('; ')}.`,
      `When a request needs a client capability the client did not declare, answer -32021 with data.requiredCapabilities${http(ctx) ? ' and HTTP 400' : ''}.`,
    );
  if (right.length === 0) return notOffered('No --fixture call needed a client capability.');
  return passed(`${right.join('; ')}.`);
};

export const CORE: Record<string, ConformanceCheck> = {
  'mod-discover-result': discoverResult,
  'mod-discover-server-info': discoverServerInfo,
  'mod-meta-required-fields': metaRequired,
  'mod-unsupported-version': unsupportedVersion,
  'mod-removed-methods': removedMethods,
  'mod-stateless-no-prior-context': statelessNoPriorContext,
  'mod-list-stable-across-connections': listStable,
  'mod-resource-not-found': resourceNotFound,
  'mod-resource-no-empty-contents': resourceNoEmptyContents,
  'mod-cache-hints-coverage': cacheHints,
  'mod-cache-ttl-valid': cacheTtl,
  'mod-cache-scope-valid': cacheScope,
  'mod-cache-scope-stable-pages': cacheScopePages,
  'mod-undeclared-capability': undeclaredCapability,
};
