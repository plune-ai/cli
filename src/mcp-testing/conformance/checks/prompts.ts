/** Prompts: the entries of prompts/list, and a get of a name no server has. Not-applicable without the capability. */

import type { ConformanceCheck } from './index.js';
import { call, declares, entries, failed, isObject, isOutcome, label, notDeclared, passed, said, some } from './wire.js';

export const UNKNOWN_PROMPT = 'plune-conformance-no-such-prompt';

const listShape: ConformanceCheck = async (ctx) => {
  const list = await entries(ctx, 'prompts', 'prompts/list', 'prompts');
  if (isOutcome(list)) return list;
  const bad = list.flatMap((p, i) => {
    if (!isObject(p) || typeof p['name'] !== 'string') return [`${label(p, i)}: no string name`];
    const args = p['arguments'];
    if (args === undefined) return [];
    if (!Array.isArray(args)) return [`${p['name']}: arguments is not a list`];
    return args.some((a) => !isObject(a) || typeof a['name'] !== 'string') ? [`${p['name']}: an argument without a string name`] : [];
  });
  if (bad.length > 0)
    return failed(`${some(bad)}.`, 'Give every prompt a name, and each of its arguments (when given) a name.');
  return passed(`${list.length} prompts, each with a name and well-formed arguments.`);
};

const getUnknown: ConformanceCheck = async (ctx) => {
  if (!declares(ctx, 'prompts')) return notDeclared('prompts');
  const a = await call(ctx, 'prompts/get', { name: UNKNOWN_PROMPT });
  if (a.kind === 'error') return passed(`prompts/get of an unknown prompt answered ${said(a)}.`);
  return failed(
    `prompts/get of an unknown prompt answered ${said(a)}.`,
    'Answer a get of a prompt that does not exist with a JSON-RPC error (-32602, Invalid params).',
  );
};

export const PROMPTS: Record<string, ConformanceCheck> = {
  'prompts-list-shape': listShape,
  'prompts-get-unknown-error': getUnknown,
};
