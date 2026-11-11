/**
 * Resources: the entries of resources/list and resources/templates/list, a read of the first listed resource (a uri
 * the server itself offered), and a read of a uri no server has. Every check is not-applicable without the
 * resources capability.
 */

import type { ConformanceCheck, ConformanceContext } from './index.js';
import { call, declares, entries, failed, isObject, isOutcome, label, notDeclared, notOffered, passed, said, some } from './wire.js';

const resources = (ctx: ConformanceContext) => entries(ctx, 'resources', 'resources/list', 'resources');
export const UNKNOWN_URI = 'plune-conformance://no-such-resource';

const listShape: ConformanceCheck = async (ctx) => {
  const list = await resources(ctx);
  if (isOutcome(list)) return list;
  const bad = list.flatMap((r, i) =>
    isObject(r) && typeof r['uri'] === 'string' && typeof r['name'] === 'string' ? [] : [label(r, i)],
  );
  if (bad.length > 0) return failed(`Without a string uri and name: ${some(bad)}.`, 'Give every listed resource a uri and a name.');
  return passed(`${list.length} resources, each with a uri and a name.`);
};

const readListed: ConformanceCheck = async (ctx) => {
  const list = await resources(ctx);
  if (isOutcome(list)) return list;
  const first = list.find((r): r is Record<string, unknown> => isObject(r) && typeof r['uri'] === 'string');
  if (first === undefined) return notOffered('resources/list lists no resource to read.');
  const uri = first['uri'] as string;
  const a = await call(ctx, 'resources/read', { uri });
  if (a.kind !== 'result') return failed(`resources/read of the listed ${uri} answered ${said(a)}.`, 'Serve resources/read for every resource the server lists.');
  const contents = a.result['contents'];
  if (!Array.isArray(contents)) return failed(`resources/read of ${uri} has no contents list.`, 'Answer resources/read with { contents: [...] }.');
  const bad = contents.flatMap((c, i) => {
    if (!isObject(c) || typeof c['uri'] !== 'string') return [`content #${i + 1}: no string uri`];
    const kinds = ['text', 'blob'].filter((k) => typeof c[k] === 'string');
    return kinds.length === 1 ? [] : [`content #${i + 1}: ${kinds.length === 0 ? 'neither text nor blob' : 'both text and blob'}`];
  });
  if (bad.length > 0)
    return failed(`resources/read of ${uri}: ${some(bad)}.`, 'Give each content a uri and exactly one of text and blob (base64).');
  return passed(`resources/read of the listed ${uri} answered ${contents.length} content(s), each with a uri and one of text and blob.`);
};

const readNotFound: ConformanceCheck = async (ctx) => {
  if (!declares(ctx, 'resources')) return notDeclared('resources');
  const a = await call(ctx, 'resources/read', { uri: UNKNOWN_URI });
  if (a.kind === 'error' && a.code === -32002) return passed('resources/read of an unknown uri answered error -32002.');
  const empty = a.kind === 'result' && Array.isArray(a.result['contents']) && a.result['contents'].length === 0 ? ' with empty contents' : '';
  return failed(
    `resources/read of an unknown uri answered ${said(a)}${empty}.`,
    'Answer a read of a resource that does not exist with the error -32002 (Resource not found).',
  );
};

const templatesShape: ConformanceCheck = async (ctx) => {
  const list = await entries(ctx, 'resources', 'resources/templates/list', 'resourceTemplates');
  if (isOutcome(list)) return list;
  const bad = list.flatMap((t, i) =>
    isObject(t) && typeof t['uriTemplate'] === 'string' && typeof t['name'] === 'string' ? [] : [label(t, i)],
  );
  if (bad.length > 0) return failed(`Without a string uriTemplate and name: ${some(bad)}.`, 'Give every resource template a uriTemplate and a name.');
  return passed(`${list.length} resource templates, each with a uriTemplate and a name.`);
};

export const RESOURCES: Record<string, ConformanceCheck> = {
  'resources-list-shape': listShape,
  'resources-read-listed': readListed,
  'resources-read-not-found': readNotFound,
  'resources-templates-shape': templatesShape,
};
