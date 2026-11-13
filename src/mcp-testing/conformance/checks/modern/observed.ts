/**
 * The whole run, read back: every message the server sent over the session's raw layer (Session.traffic), judged
 * once all other checks have asked what they ask. Nothing is sent here.
 */

import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import schema from '../../schemas/2026-07-28.json' with { type: 'json' };
import type { ConformanceCheck, ConformanceContext } from '../index.js';
import { capabilities, declares, failed, isObject, notDeclared, notOffered, passed, some } from '../wire.js';

/** SHA-256 of schemas/2026-07-28.json as published (a test holds the file to it). */
export const SCHEMA_SHA256 = 'edbb197ed0f92e90d658866e23cf76f107df0caac5ce25c2b9e64e1ca9a6314a';
/** Where the file comes from: the specification repository, at the commit it was taken from. */
export const SCHEMA_SOURCE =
  'https://github.com/modelcontextprotocol/modelcontextprotocol/blob/38353251fab3bdeead03dd8283b9e66076ce1a7f/schema/2026-07-28/schema.json';

const traffic = (ctx: ConformanceContext) => ctx.session.traffic();
const results = (ctx: ConformanceContext) =>
  traffic(ctx).flatMap((t) => (isObject(t.frame['result']) ? [{ method: t.method ?? 'a request', result: t.frame['result'] }] : []));
const errors = (ctx: ConformanceContext) =>
  traffic(ctx).flatMap((t) => (isObject(t.frame['error']) ? [{ method: t.method ?? 'a request', error: t.frame['error'] }] : []));

const RESULT_TYPES = ['complete', 'input_required'];

const resultType: ConformanceCheck = async (ctx) => {
  const all = results(ctx);
  if (all.length === 0) return notOffered('No result came back in the run.');
  const extensions = capabilities(ctx)['extensions'];
  const extended = isObject(extensions) && Object.keys(extensions).length > 0;
  const missing = all.filter((r) => typeof r.result['resultType'] !== 'string');
  const unknown = all.filter((r) => typeof r.result['resultType'] === 'string' && !RESULT_TYPES.includes(r.result['resultType']));
  const bad = [...missing.map((r) => `${r.method}: no resultType`), ...(extended ? [] : unknown.map((r) => `${r.method}: resultType ${JSON.stringify(r.result['resultType'])}`))];
  if (bad.length > 0)
    return failed(`${some(bad)}.`, 'Give every result a resultType: "complete", "input_required", or a value of an extension the server declares.');
  const note = extended && unknown.length > 0 ? ` Other values (${some(unknown.map((r) => String(r.result['resultType'])))}) taken as those of the declared extensions.` : '';
  return passed(`${all.length} result${all.length === 1 ? '' : 's'} with a known resultType.${note}`);
};

/** Codes the revision defines in -32020..-32099, and the retired ones it forbids. */
const DEFINED = new Set([-32020, -32021, -32022]);
const RETIRED = new Set([-32002, -32042]);

const errorCodeRange: ConformanceCheck = async (ctx) => {
  const all = errors(ctx);
  if (all.length === 0) return notOffered('No error came back in the run.');
  const bad = all.filter(({ error }) => {
    const code = error['code'];
    return typeof code === 'number' && (RETIRED.has(code) || (code <= -32020 && code >= -32099 && !DEFINED.has(code)));
  });
  if (bad.length > 0)
    return failed(
      `${some(bad.map(({ method, error }) => `${method}: ${String(error['code'])}`))}.`,
      'Use from -32099 to -32020 only the codes the specification defines (-32020, -32021, -32022), and never -32002 or -32042.',
    );
  return passed(`${all.length} error${all.length === 1 ? '' : 's'}: no undefined code of the reserved range, no retired code.`);
};

const logsNeedLevel: ConformanceCheck = async (ctx) => {
  if (!declares(ctx, 'logging')) return notDeclared('logging');
  const logs = traffic(ctx).filter((t) => t.frame['method'] === 'notifications/message');
  const asked = traffic(ctx).filter((t) => t.method !== undefined).length;
  if (logs.length > 0)
    return failed(
      `${logs.length} notifications/message came back, though no request set io.modelcontextprotocol/logLevel.`,
      'Send notifications/message only for a request whose _meta sets io.modelcontextprotocol/logLevel.',
    );
  return passed(`${asked} answers to requests without logLevel, and no notifications/message.`);
};

/** The result definition of each method of the revision; any other method answers a plain Result. */
const RESULT_OF: Record<string, string> = {
  'server/discover': 'DiscoverResult',
  'tools/list': 'ListToolsResult',
  'tools/call': 'CallToolResult',
  'prompts/list': 'ListPromptsResult',
  'prompts/get': 'GetPromptResult',
  'resources/list': 'ListResourcesResult',
  'resources/templates/list': 'ListResourceTemplatesResult',
  'resources/read': 'ReadResourceResult',
  'completion/complete': 'CompleteResult',
  'subscriptions/listen': 'SubscriptionsListenResult',
};
const NOTIFICATION_OF: Record<string, string> = {
  'notifications/message': 'LoggingMessageNotification',
  'notifications/progress': 'ProgressNotification',
  'notifications/cancelled': 'CancelledNotification',
  'notifications/tools/list_changed': 'ToolListChangedNotification',
  'notifications/prompts/list_changed': 'PromptListChangedNotification',
  'notifications/resources/list_changed': 'ResourceListChangedNotification',
  'notifications/resources/updated': 'ResourceUpdatedNotification',
  'notifications/subscriptions/acknowledged': 'SubscriptionsAcknowledgedNotification',
};

let ajv: Ajv2020 | undefined;
/** The validator of one definition of the schema, compiled once per process. */
function validator(name: string): ValidateFunction {
  if (ajv === undefined) {
    ajv = new Ajv2020({ strict: false, validateFormats: false, logger: false });
    ajv.addSchema(schema as object, 'mcp-2026-07-28');
  }
  const fn = ajv.getSchema(`mcp-2026-07-28#/$defs/${name}`);
  if (fn === undefined) throw new Error(`schema.json has no definition ${name}`);
  return fn;
}

/** What is wrong with one message against the schema; undefined when it conforms or is not judged. */
export function wireProblem(frame: Record<string, unknown>, method: string | undefined): string | undefined {
  const check = (name: string, value: unknown, what: string) => {
    const fn = validator(name);
    return fn(value) ? undefined : `${what} is not a ${name}: ${(ajv as Ajv2020).errorsText(fn.errors)}`;
  };
  if ('error' in frame) {
    // JSON-RPC 2.0 (section 5) answers a message whose id could not be read with id: null, which the schema has no
    // type for (it leaves the id out instead): the null is taken as the absent id.
    const { id, ...rest } = frame;
    return check('JSONRPCErrorResponse', id === null ? rest : frame, `the error to ${method ?? 'a request'}`);
  }
  if ('result' in frame) {
    const r = frame['result'];
    const def = isObject(r) && r['resultType'] === 'input_required' ? 'InputRequiredResult' : (RESULT_OF[method ?? ''] ?? 'Result');
    return check('JSONRPCResultResponse', frame, `the response to ${method ?? 'a request'}`) ?? check(def, r, `the result of ${method ?? 'a request'}`);
  }
  const name = typeof frame['method'] === 'string' && frame['id'] === undefined ? NOTIFICATION_OF[frame['method']] : undefined;
  return name === undefined ? undefined : check(name, frame, String(frame['method']));
}

const wireSchema: ConformanceCheck = async (ctx) => {
  const all = traffic(ctx);
  if (all.length === 0) return notOffered('No message came back in the run.');
  const bad = all.flatMap((t) => {
    const p = wireProblem(t.frame, t.method);
    return p === undefined ? [] : [p];
  });
  const digest = `schema.json of 2026-07-28, sha256 ${SCHEMA_SHA256.slice(0, 12)}`;
  if (bad.length > 0)
    return failed(`${bad.length} of ${all.length} messages do not conform to ${digest}: ${some(bad, 3)}.`, 'Send every message in the shape the schema of the revision gives it.');
  return passed(`${all.length} messages conform to ${digest}.`);
};

export const OBSERVED: Record<string, ConformanceCheck> = {
  'mod-result-type-present': resultType,
  'mod-error-code-range': errorCodeRange,
  'mod-logs-need-log-level': logsNeedLevel,
  'mod-wire-schema-valid': wireSchema,
};
