/**
 * Lifecycle: the handshake as the server sent it, the capabilities it declared against the methods it serves, ping,
 * and the two utilities whose only requirement is to be served once declared (logging, completions).
 */

import type { ConformanceCheck, ConformanceContext } from './index.js';
import {
  call,
  capabilities,
  declares,
  failed,
  isObject,
  notDeclared,
  notOffered,
  passed,
  said,
  some,
  walk,
  type Answer,
} from './wire.js';

const REVISION = /^\d{4}-\d{2}-\d{2}$/;

/** What is wrong with an initialize result; empty when it holds protocolVersion, capabilities and serverInfo. */
export function initializeProblems(result: unknown): string[] {
  if (!isObject(result)) return ['the server sent no initialize result'];
  const problems: string[] = [];
  if (typeof result['protocolVersion'] !== 'string') problems.push('protocolVersion is missing or not a string');
  if (!isObject(result['capabilities'])) problems.push('capabilities is missing or not an object');
  const info = result['serverInfo'];
  if (!isObject(info)) problems.push('serverInfo is missing or not an object');
  else {
    if (typeof info['name'] !== 'string') problems.push('serverInfo.name is missing or not a string');
    if (typeof info['version'] !== 'string') problems.push('serverInfo.version is missing or not a string');
  }
  return problems;
}

const initializeResult: ConformanceCheck = async (ctx) => {
  const result = ctx.session.handshake.result;
  const problems = initializeProblems(result);
  if (problems.length > 0)
    return failed(
      `initialize answered, but ${problems.join('; ')}.`,
      'Answer initialize with protocolVersion (a string), capabilities (an object) and serverInfo (name and version).',
    );
  const r = result as Record<string, unknown>;
  const info = r['serverInfo'] as Record<string, unknown>;
  return passed(
    `protocolVersion ${String(r['protocolVersion'])}, capabilities {${Object.keys(capabilities(ctx)).join(', ')}}, serverInfo ${String(info['name'])} ${String(info['version'])}.`,
  );
};

// The client offers the revision it prefers; the answer is that one, or another the server supports. That the server
// does not support the offered one cannot be seen from outside, so a different revision is a pass when it is one.
const versionNegotiation: ConformanceCheck = async (ctx) => {
  const offered = ctx.session.handshake.offered;
  const result = ctx.session.handshake.result;
  const answered = isObject(result) ? result['protocolVersion'] : undefined;
  if (typeof answered !== 'string' || !REVISION.test(answered))
    return failed(
      `Offered ${String(offered)}; answered ${JSON.stringify(answered) ?? 'nothing'}, which is not a revision.`,
      'Answer with the offered revision when it is supported, else with the latest revision the server supports (YYYY-MM-DD).',
    );
  if (answered === offered) return passed(`Offered ${String(offered)}, answered the same.`);
  return passed(`Offered ${String(offered)}; answered ${answered}, another revision (the server does not support the offered one).`);
};

/** The request that shows a capability is served, per capability; logging/setLevel is gone in the modern era. */
const SERVED: readonly [string, (ctx: ConformanceContext) => Promise<Answer | undefined>][] = [
  ['tools', async (ctx) => (await walk(ctx, 'tools/list', 'tools')).stop],
  ['resources', async (ctx) => (await walk(ctx, 'resources/list', 'resources')).stop],
  ['prompts', async (ctx) => (await walk(ctx, 'prompts/list', 'prompts')).stop],
  ['logging', async (ctx) => (ctx.era === 'legacy' ? call(ctx, 'logging/setLevel', { level: 'info' }) : undefined)],
  [
    'completions',
    (ctx) =>
      call(ctx, 'completion/complete', {
        ref: { type: 'ref/prompt', name: 'plune-conformance-probe' },
        argument: { name: 'probe', value: '' },
      }),
  ],
];

const METHOD: Record<string, string> = {
  tools: 'tools/list',
  resources: 'resources/list',
  prompts: 'prompts/list',
  logging: 'logging/setLevel',
  completions: 'completion/complete',
};

const declaredServed: ConformanceCheck = async (ctx) => {
  const declared = SERVED.filter(([cap]) => declares(ctx, cap));
  if (declared.length === 0) return notDeclared('tools, resources, prompts, logging or completions');
  const missing: string[] = [];
  for (const [cap, probe] of declared) {
    const a = await probe(ctx);
    if (a?.kind === 'error' && a.code === -32601) missing.push(`${cap} (${METHOD[cap]} is Method not found)`);
  }
  if (missing.length > 0)
    return failed(
      `Declared but not served: ${missing.join(', ')}.`,
      'Serve every capability the server declares, or stop declaring the ones it does not serve.',
    );
  return passed(`Declared and served: ${declared.map(([cap]) => cap).join(', ')}.`);
};

const servedDeclared: ConformanceCheck = async (ctx) => {
  const lists = [
    ['tools', 'tools/list'],
    ['resources', 'resources/list'],
    ['prompts', 'prompts/list'],
  ] as const;
  const undeclared = lists.filter(([cap]) => !declares(ctx, cap));
  const served: string[] = [];
  for (const [cap, method] of undeclared) if ((await call(ctx, method)).kind === 'result') served.push(`${method} answers, ${cap} is not declared`);
  if (served.length > 0)
    return failed(`${served.join('; ')}.`, 'Declare the capability of every list the server answers.');
  if (undeclared.length === 0) return passed('tools, resources and prompts are all declared.');
  return passed(`${some(undeclared.map(([, m]) => m))}: not declared, and not answered with a result.`);
};

const pingEmpty: ConformanceCheck = async (ctx) => {
  const a = await call(ctx, 'ping');
  if (a.kind !== 'result')
    return failed(`ping answered ${said(a)}.`, 'Answer ping with result: {}.');
  const extra = Object.keys(a.result).filter((k) => k !== '_meta');
  if (extra.length > 0)
    return failed(`ping answered a result with ${some(extra)}.`, 'Answer ping with an empty result: {}.');
  return passed('ping answered result: {}.');
};

const loggingSetLevel: ConformanceCheck = async (ctx) => {
  if (!declares(ctx, 'logging')) return notDeclared('logging');
  const a = await call(ctx, 'logging/setLevel', { level: 'info' });
  if (a.kind === 'result') return passed('logging/setLevel { level: "info" } answered a result.');
  return failed(`logging/setLevel { level: "info" } answered ${said(a)}.`, 'Accept logging/setLevel when the logging capability is declared.');
};

/** A reference completion/complete can ask about: a prompt argument, else a resource template variable. */
async function completionRef(ctx: ConformanceContext): Promise<Record<string, unknown> | undefined> {
  if (declares(ctx, 'prompts')) {
    for (const p of (await walk(ctx, 'prompts/list', 'prompts')).items) {
      const arg = isObject(p) && Array.isArray(p['arguments']) ? p['arguments'][0] : undefined;
      if (isObject(p) && typeof p['name'] === 'string' && isObject(arg) && typeof arg['name'] === 'string')
        return { ref: { type: 'ref/prompt', name: p['name'] }, argument: { name: arg['name'], value: '' } };
    }
  }
  if (declares(ctx, 'resources')) {
    for (const t of (await walk(ctx, 'resources/templates/list', 'resourceTemplates')).items) {
      const template = isObject(t) ? t['uriTemplate'] : undefined;
      const variable = typeof template === 'string' ? /\{[+#./;?&]?([A-Za-z0-9_]+)/.exec(template)?.[1] : undefined;
      if (typeof template === 'string' && variable !== undefined)
        return { ref: { type: 'ref/resource', uri: template }, argument: { name: variable, value: '' } };
    }
  }
  return undefined;
}

const completionComplete: ConformanceCheck = async (ctx) => {
  if (!declares(ctx, 'completions')) return notDeclared('completions');
  const params = await completionRef(ctx);
  if (params === undefined) return notOffered('No prompt with an argument and no resource template with a variable to complete.');
  const asked = `completion/complete for ${JSON.stringify(params['ref'])}`;
  const a = await call(ctx, 'completion/complete', params);
  if (a.kind !== 'result') return failed(`${asked} answered ${said(a)}.`, 'Answer completion/complete with { completion: { values } }.');
  const c = a.result['completion'];
  const problems: string[] = [];
  if (!isObject(c)) problems.push('completion is missing or not an object');
  else {
    const values = c['values'];
    if (!Array.isArray(values) || values.some((v) => typeof v !== 'string')) problems.push('completion.values is not a list of strings');
    else if (values.length > 100) problems.push(`completion.values holds ${values.length} items, more than 100`);
    if (c['total'] !== undefined && !Number.isInteger(c['total'])) problems.push('completion.total is not an integer');
    if (c['hasMore'] !== undefined && typeof c['hasMore'] !== 'boolean') problems.push('completion.hasMore is not a boolean');
  }
  if (problems.length > 0)
    return failed(`${asked}: ${problems.join('; ')}.`, 'Answer with completion.values (at most 100 strings), and total and hasMore when given.');
  return passed(`${asked} answered ${(c as { values: unknown[] }).values.length} values.`);
};

export const LIFECYCLE: Record<string, ConformanceCheck> = {
  'life-initialize-result': initializeResult,
  'life-version-negotiation': versionNegotiation,
  'life-capabilities-declared-served': declaredServed,
  'life-capabilities-served-declared': servedDeclared,
  'life-ping-empty-result': pingEmpty,
  'logging-set-level': loggingSetLevel,
  'completion-complete': completionComplete,
};
