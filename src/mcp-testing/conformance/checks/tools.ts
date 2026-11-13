/**
 * Tools: the entries of tools/list, their schemas in their own dialect, their names, and what a call answers. The only
 * tools/call requests are those the user listed in --fixture, and two that cannot run a tool: one without a name, one
 * for a name no server has.
 */

import { isDeepStrictEqual } from 'node:util';
import type { ConformanceCheck, ConformanceContext, FixtureCall } from './index.js';
import { paramHeaders } from './modern/meta.js';
import { DIALECT_NAMES, judge } from './schema.js';
import {
  call,
  declares,
  entries,
  failed,
  isObject,
  isOutcome,
  label,
  notDeclared,
  notOffered,
  passed,
  said,
  some,
  walk,
  type Answer,
} from './wire.js';
import type { CheckOutcome } from '../outcome.js';

export const tools = (ctx: ConformanceContext) => entries(ctx, 'tools', 'tools/list', 'tools');
const NAME = /^[A-Za-z0-9_.-]{1,128}$/;
export const UNKNOWN_TOOL = 'plune-conformance-no-such-tool';

const listShape: ConformanceCheck = async (ctx) => {
  const list = await tools(ctx);
  if (isOutcome(list)) return list;
  const bad: string[] = [];
  list.forEach((t, i) => {
    if (!isObject(t) || typeof t['name'] !== 'string') bad.push(`${label(t, i)}: no string name`);
    else if (!isObject(t['inputSchema'])) bad.push(`${t['name']}: inputSchema is ${t['inputSchema'] === null ? 'null' : 'not an object'}`);
  });
  if (bad.length > 0)
    return failed(`${some(bad)}.`, 'Give every tool a string name and an inputSchema object ({ "type": "object" } for no parameters).');
  return passed(`${list.length} tools, each with a string name and an inputSchema object.`);
};

/**
 * Each schema of `pick` judged in its dialect. `root` is what its root must say, if anything. A schema in a dialect
 * this checker has no validator for makes the check could-not-run, unless another one already failed it.
 */
function schemas(
  list: unknown[],
  pick: (t: Record<string, unknown>) => unknown,
  root: (schema: Record<string, unknown>) => string | undefined,
): { judged: number; bad: string[]; unsupported: string[] } {
  const out = { judged: 0, bad: [] as string[], unsupported: [] as string[] };
  list.forEach((t, i) => {
    if (!isObject(t)) return;
    const schema = pick(t);
    if (schema === undefined) return;
    const name = label(t, i);
    out.judged++;
    if (!isObject(schema)) return void out.bad.push(`${name}: not an object`);
    const wrongRoot = root(schema);
    if (wrongRoot !== undefined) return void out.bad.push(`${name}: ${wrongRoot}`);
    const j = judge(schema);
    if (j.valid === 'unsupported') out.unsupported.push(`${name} (${j.dialect})`);
    else if (!j.valid) out.bad.push(`${name}: ${j.problem}`);
  });
  return out;
}

function schemaOutcome(r: ReturnType<typeof schemas>, what: string, fix: string): CheckOutcome {
  if (r.bad.length > 0) return failed(`${what}: ${some(r.bad, 3)}.`, fix);
  if (r.unsupported.length > 0)
    return {
      state: 'could-not-run',
      reason: 'unsupported-dialect',
      actual: `${what} in a dialect this checker does not validate (it does ${DIALECT_NAMES}): ${some(r.unsupported, 3)}.`,
    };
  return passed(`${r.judged} ${what} valid in their dialect.`);
}

const inputSchemaValid: ConformanceCheck = async (ctx) => {
  const list = await tools(ctx);
  if (isOutcome(list)) return list;
  const r = schemas(
    list,
    (t) => t['inputSchema'],
    (s) => (s['type'] === 'object' ? undefined : `type is ${JSON.stringify(s['type']) ?? 'missing'}, not "object"`),
  );
  return schemaOutcome(r, 'inputSchemas', 'Make every inputSchema a valid JSON Schema with type: "object", in 2020-12 or the dialect its $schema names.');
};

const outputSchemaValid: ConformanceCheck = async (ctx) => {
  const list = await tools(ctx);
  if (isOutcome(list)) return list;
  // Up to 2025-11-25 the root is an object (schema.json: type const "object"); 2026-07-28 allows any type.
  const r = schemas(
    list,
    (t) => t['outputSchema'],
    (s) =>
      ctx.era === 'legacy' && s['type'] !== 'object'
        ? `type is ${JSON.stringify(s['type']) ?? 'missing'}, not "object" (required at the root before 2026-07-28)`
        : undefined,
  );
  if (r.judged === 0) return notOffered('No tool has an outputSchema.');
  return schemaOutcome(r, 'outputSchemas', 'Make every outputSchema a valid JSON Schema in its dialect, with type: "object" at the root before 2026-07-28.');
};

export interface Called {
  call: FixtureCall;
  tool: Record<string, unknown> | undefined;
  answer: Answer | undefined;
}

/** The --fixture calls, each made once per run; a tool the server does not list is not called. */
export function fixtureCalls(ctx: ConformanceContext, list: unknown[]): Promise<Called[]> {
  return ctx.memo('fixture calls', async () => {
    const out: Called[] = [];
    for (const c of ctx.fixture ?? []) {
      const tool = list.find((t): t is Record<string, unknown> => isObject(t) && t['name'] === c.tool);
      out.push({
        call: c,
        tool,
        answer:
          tool === undefined
            ? undefined
            : await call(
                ctx,
                'tools/call',
                { name: c.tool, arguments: c.arguments },
                // A modern client over HTTP mirrors the x-mcp-header parameters into Mcp-Param headers.
                ctx.era === 'modern' && ctx.transport === 'http' ? { headers: paramHeaders(tool, c.arguments) } : undefined,
              ),
      });
    }
    return out;
  });
}

/** The fixture calls that answered a result that is not a tool error, or the outcome when the check cannot run. */
async function results(ctx: ConformanceContext): Promise<CheckOutcome | { called: Called; result: Record<string, unknown> }[]> {
  if (ctx.fixture === undefined)
    return {
      state: 'could-not-run',
      reason: 'needs-input',
      actual: 'No --fixture: no tool is called without one. Name a safe tool and its arguments in a fixture file to run this check.',
    };
  const list = await tools(ctx);
  if (isOutcome(list)) return list;
  const called = await fixtureCalls(ctx, list);
  return called.flatMap((c) =>
    c.answer?.kind === 'result' && c.answer.result['isError'] !== true ? [{ called: c, result: c.answer.result }] : [],
  );
}

const structuredConformant: ConformanceCheck = async (ctx) => {
  const r = await results(ctx);
  if (!Array.isArray(r)) return r;
  const bad: string[] = [];
  let judged = 0;
  for (const { called, result } of r) {
    const schema = called.tool?.['outputSchema'];
    if (!isObject(schema)) continue;
    const j = judge(schema);
    if (j.valid !== true) continue; // tools-output-schema-valid says why
    judged++;
    if (!('structuredContent' in result)) {
      bad.push(`${called.call.tool}: no structuredContent, though the tool has an outputSchema`);
      continue;
    }
    const problem = j.check(result['structuredContent']);
    if (problem !== undefined) bad.push(`${called.call.tool}: ${problem}`);
  }
  if (bad.length > 0)
    return failed(`${some(bad, 3)}.`, 'Return structuredContent that conforms to the outputSchema the tool declares.');
  if (judged === 0)
    return notOffered('No fixture call reached a tool with a valid outputSchema and answered a result that is not a tool error.');
  return passed(`${judged} fixture call${judged === 1 ? '' : 's'}: structuredContent conforms to the outputSchema.`);
};

const structuredHasText: ConformanceCheck = async (ctx) => {
  const r = await results(ctx);
  if (!Array.isArray(r)) return r;
  const structured = r.filter(({ result }) => 'structuredContent' in result);
  if (structured.length === 0) return notOffered('No fixture call answered structuredContent.');
  const bad: string[] = [];
  for (const { called, result } of structured) {
    const content = Array.isArray(result['content']) ? result['content'] : [];
    const same = content.some((block) => {
      if (!isObject(block) || block['type'] !== 'text' || typeof block['text'] !== 'string') return false;
      try {
        return isDeepStrictEqual(JSON.parse(block['text']), result['structuredContent']);
      } catch {
        return false;
      }
    });
    if (!same) bad.push(called.call.tool);
  }
  if (bad.length > 0)
    return failed(`No text block holds the structuredContent as JSON: ${some(bad)}.`, 'Also return the serialized structuredContent in a text content block.');
  return passed(`${structured.length} fixture call${structured.length === 1 ? '' : 's'}: the structuredContent is also given as JSON text.`);
};

const nameFormat: ConformanceCheck = async (ctx) => {
  const list = await tools(ctx);
  if (isOutcome(list)) return list;
  const bad = list.filter((t) => isObject(t) && typeof t['name'] === 'string' && !NAME.test(t['name']));
  if (bad.length > 0)
    return failed(
      `${some(bad.map((t) => JSON.stringify((t as Record<string, unknown>)['name'])))}.`,
      'Name tools with 1 to 128 of A-Z, a-z, 0-9, _, - and . only.',
    );
  return passed(`${list.length} tool names, each 1 to 128 allowed characters.`);
};

const nameUnique: ConformanceCheck = async (ctx) => {
  const list = await tools(ctx);
  if (isOutcome(list)) return list;
  const seen = new Set<string>();
  const twice = new Set<string>();
  for (const t of list) {
    const name = isObject(t) ? t['name'] : undefined;
    if (typeof name !== 'string') continue;
    if (seen.has(name)) twice.add(name);
    seen.add(name);
  }
  if (twice.size > 0) return failed(`Listed more than once: ${some([...twice])}.`, 'Give each tool of the server a name of its own.');
  return passed(`${seen.size} tool names, no two the same across ${(await walk(ctx, 'tools/list', 'tools')).pages.length} page(s).`);
};

const callUnknown: ConformanceCheck = async (ctx) => {
  if (!declares(ctx, 'tools')) return notDeclared('tools');
  const a = await call(ctx, 'tools/call', { name: UNKNOWN_TOOL, arguments: {} });
  if (a.kind === 'error') return passed(`tools/call for an unknown tool answered ${said(a)}.`);
  const isError = a.kind === 'result' && a.result['isError'] === true ? ' with isError: true' : '';
  return failed(
    `tools/call for an unknown tool answered ${said(a)}${isError}.`,
    'Answer a call for a tool the server does not have with a JSON-RPC error (such as -32602), not a tool result.',
  );
};

const listOrderStable: ConformanceCheck = async (ctx) => {
  const list = await tools(ctx);
  if (isOutcome(list)) return list;
  const again = await call(ctx, 'tools/list');
  const first = ((await walk(ctx, 'tools/list', 'tools')).pages[0] ?? []).map((t, i) => label(t, i));
  const second = again.kind === 'result' && Array.isArray(again.result['tools']) ? again.result['tools'].map((t, i) => label(t, i)) : undefined;
  if (second === undefined) return failed(`The second tools/list answered ${said(again)}.`, 'Answer tools/list the same way each time.');
  if (!isDeepStrictEqual(first, second))
    return failed(`Two tools/list calls gave ${first.length} and ${second.length} tools in different orders.`, 'Return the tools in a deterministic order.');
  return passed(`Two tools/list calls gave the same ${first.length} tools in the same order.`);
};

export const TOOLS: Record<string, ConformanceCheck> = {
  'tools-list-shape': listShape,
  'tools-input-schema-valid': inputSchemaValid,
  'tools-output-schema-valid': outputSchemaValid,
  'tools-structured-conformant': structuredConformant,
  'tools-structured-has-text': structuredHasText,
  'tools-name-format': nameFormat,
  'tools-name-unique': nameUnique,
  'tools-call-unknown-error': callUnknown,
  'tools-list-order-stable': listOrderStable,
};
