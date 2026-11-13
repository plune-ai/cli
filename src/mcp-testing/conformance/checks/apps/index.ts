/**
 * The apps suite: MCP Apps, tools that come with a UI (apps-catalog.ts). The checks read tools/list, resources/list
 * and resources/read of the ui:// addresses a tool or the list names, and nothing else; they do not run, open or
 * parse the HTML. A tool is called only for apps-ui-tool-text-fallback, and only a tool `--fixture` names.
 */

import { Buffer } from 'node:buffer';
import { paramHeaders } from '../modern/meta.js';
import type { ConformanceCheck, ConformanceContext } from '../index.js';
import { tools } from '../tools.js';
import {
  call,
  failed,
  isObject,
  isOutcome,
  notOffered,
  passed,
  prerequisite,
  some,
  type Answer,
} from '../wire.js';
import {
  APP_MIME,
  MAX_UI_BYTES,
  gather,
  hasUiScheme,
  kind,
  LIMIT_NOTE,
  listNote,
  listed,
  namedAddresses,
  q,
  readUi,
  sameMime,
  uiAddresses,
  uiTools,
  verdict,
  type Judged,
  type UiTool,
} from './view.js';

const scheme: ConformanceCheck = async (ctx) => {
  const found = await uiTools(ctx);
  if (isOutcome(found)) return found;
  const bad: string[] = [];
  let judged = 0;
  for (const t of found) {
    if (t.resourceUri === undefined) continue;
    judged++;
    if (!hasUiScheme(t.resourceUri)) bad.push(`${q(t.name)}: ${q(t.resourceUri)}`);
  }
  const list = await listed(ctx);
  if (Array.isArray(list))
    for (const r of list) {
      if (!sameMime(r['mimeType'], APP_MIME)) continue;
      judged++;
      if (!hasUiScheme(r['uri'])) bad.push(`listed ${q(r['uri'])}`);
    }
  const note = listNote(list).listNote;
  if (bad.length > 0)
    return failed(
      `Not an address that starts with ui://: ${some(bad, 5)}.${note === undefined ? '' : ` ${note}.`}`,
      'Give every UI resource an address that starts with ui://, and name that address in _meta.ui.resourceUri.',
    );
  // The list is half of what this check reads: without it a pass would speak for the tools only.
  if (note !== undefined) return prerequisite(`${note}, so the listed resources were not judged.`);
  if (judged === 0)
    return notOffered(
      'No tool names a _meta.ui.resourceUri, and no listed resource has the MCP Apps media type.',
    );
  return passed(`${judged} address${judged === 1 ? '' : 'es'}, each starting with ui://.`);
};

const exists: ConformanceCheck = async (ctx) => {
  const found = await uiTools(ctx);
  if (isOutcome(found)) return found;
  const { uris, over } = namedAddresses(found);
  if (uris.length === 0)
    return notOffered('No tool names a ui:// resource in _meta.ui.resourceUri.');
  // Only -32002 (Resource not found) says the resource is not there; any other answer says nothing of it.
  const bad: string[] = [];
  const unknown: string[] = [];
  for (const uri of uris) {
    const read = await readUi(ctx, uri);
    if (read.kind === 'not-found') bad.push(`${q(uri)}: resources/read answered ${read.said}`);
    else if (read.kind === 'no-answer')
      unknown.push(`${q(uri)}: resources/read answered ${read.said}`);
    else if (read.contents.length === 0)
      unknown.push(`${q(uri)}: resources/read answered an empty contents list`);
  }
  const limit = over > 0 ? ` ${LIMIT_NOTE(over, uris.length)}.` : '';
  if (bad.length > 0)
    return failed(
      `A resource a tool names is not found: ${some(bad, 3)}.${limit}`,
      'Serve every ui:// resource a tool names in _meta.ui.resourceUri through resources/read.',
    );
  if (unknown.length > 0)
    return prerequisite(`Whether the resource exists is not known: ${some(unknown, 3)}.${limit}`);
  if (over > 0)
    return prerequisite(
      `${LIMIT_NOTE(over, uris.length)}, so the check covers only part of the addresses.`,
    );
  return passed(
    `${uris.length} resource${uris.length === 1 ? '' : 's'} named by tools, each read with content.`,
  );
};

const mimeType: ConformanceCheck = async (ctx) => {
  const found = await uiTools(ctx);
  if (isOutcome(found)) return found;
  const g = await gather(
    ctx,
    await uiAddresses(ctx, found),
    (uri, c): Judged =>
      sameMime(c['mimeType'], APP_MIME)
        ? { problems: [] }
        : {
            problems: [
              `${q(uri)}: mimeType is ${c['mimeType'] === undefined ? 'missing' : q(c['mimeType'])}`,
            ],
          },
  );
  return verdict(
    g,
    'A UI resource without the MCP Apps media type',
    `Answer resources/read of a UI resource with the mimeType ${APP_MIME}.`,
  );
};

// The HTML5 doctype. What may come before it (a byte order mark, white space, comments) is skipped in a loop, not in
// the pattern: a pattern that alternates white space with comments backtracks without end on text a server chooses.
const DOCTYPE = /^<!doctype\s+html(?:\s[^>]*)?>/i;
/** How far into a document the doctype is looked for. */
const LOOK = 2048;

/** `yes`; `no`; or `far`: white space and comments run past `LOOK` characters, so the doctype was not looked for. */
export function opensWithDoctype(html: string): 'yes' | 'no' | 'far' {
  let i = html.startsWith('\uFEFF') ? 1 : 0;
  for (;;) {
    while (i < LOOK && /\s/.test(html.charAt(i))) i++;
    if (i >= LOOK) return html.length > i ? 'far' : 'no';
    if (!html.startsWith('<!--', i)) break;
    // From i + 2: `<!-->` and `<!--->` are complete, empty comments. end >= i + 2, so i grows by 5 or more.
    const end = html.indexOf('-->', i + 2);
    if (end < 0) return 'no';
    i = end + 3;
    if (i >= LOOK) return html.length > i ? 'far' : 'no';
  }
  return DOCTYPE.test(html.slice(i, i + 256)) ? 'yes' : 'no';
}
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** The HTML of a content, or what is wrong with it, or that it is too large to judge. Never printed. */
function htmlOf(
  c: Record<string, unknown>,
): { html: string } | { problem: string } | { large: string } {
  const text = c['text'];
  const blob = c['blob'];
  for (const key of ['text', 'blob'] as const)
    if (c[key] !== undefined && typeof c[key] !== 'string')
      return { problem: `${key} is ${kind(c[key])}, not a string` };
  if (typeof text === 'string' && typeof blob === 'string')
    return { problem: 'it has both text and blob' };
  if (typeof text === 'string') {
    const size = Buffer.byteLength(text);
    return size > MAX_UI_BYTES ? { large: `${size} bytes of text` } : { html: text };
  }
  if (typeof blob === 'string') {
    if (blob.length % 4 !== 0 || !BASE64.test(blob))
      return { problem: `blob is not base64 (${blob.length} characters)` };
    const size = (blob.length / 4) * 3 - (blob.endsWith('==') ? 2 : blob.endsWith('=') ? 1 : 0);
    return size > MAX_UI_BYTES
      ? { large: `${size} bytes in a blob` }
      : { html: Buffer.from(blob, 'base64').toString('utf8') };
  }
  return { problem: 'it has neither text nor blob' };
}

const payload: ConformanceCheck = async (ctx) => {
  const found = await uiTools(ctx);
  if (isOutcome(found)) return found;
  const g = await gather(ctx, await uiAddresses(ctx, found), (uri, c): Judged => {
    const h = htmlOf(c);
    if ('large' in h)
      return { problems: [], skipped: `${h.large}, over the 4 MiB this checker judges` };
    if ('problem' in h) return { problems: [`${q(uri)}: ${h.problem}`] };
    const doctype = opensWithDoctype(h.html);
    if (doctype === 'far')
      return {
        problems: [],
        skipped: `comments or white space run past the first ${LOOK} characters, so the doctype was not looked for`,
      };
    if (doctype === 'no')
      return {
        problems: [
          `${q(uri)}: ${Buffer.byteLength(h.html)} bytes that do not open with an HTML5 doctype`,
        ],
      };
    return { problems: [] };
  });
  return verdict(
    g,
    'A UI resource whose content is not one HTML5 document',
    'Give each content of a UI resource exactly one of text and blob (base64), holding an HTML5 document that starts with <!DOCTYPE html>.',
  );
};

const listedMime: ConformanceCheck = async (ctx) => {
  const found = await uiTools(ctx);
  if (isOutcome(found)) return found;
  const list = await listed(ctx);
  if (!Array.isArray(list)) return list;
  const ui = list.filter((r) => hasUiScheme(r['uri']));
  if (ui.length === 0)
    return notOffered(
      'resources/list lists no ui:// resource (a server may leave UI-only resources out of it).',
    );
  // mimeType is optional on a listed resource, and the sentence is about its value: a missing one is not judged.
  const given = ui.filter((r) => r['mimeType'] !== undefined);
  const missing = ui.length - given.length;
  const without = missing > 0 ? ` ${missing} listed without a mimeType were not judged.` : '';
  const bad = given
    .filter((r) => !sameMime(r['mimeType'], APP_MIME))
    .map((r) => `${q(r['uri'])}: ${q(r['mimeType'])}`);
  if (bad.length > 0)
    return failed(
      `A listed UI resource without the MCP Apps media type: ${some(bad, 3)}.${without}`,
      `Give every listed UI resource the mimeType ${APP_MIME}.`,
    );
  if (given.length === 0)
    return notOffered(
      'No listed ui:// resource has a mimeType (it is optional on a listed resource).',
    );
  return passed(
    `${given.length} listed UI resource${given.length === 1 ? '' : 's'}, each ${APP_MIME}.${without}`,
  );
};

const VISIBILITY = ['model', 'app'];

const visibility: ConformanceCheck = async (ctx) => {
  const found = await uiTools(ctx);
  if (isOutcome(found)) return found;
  const set = found.filter((t) => isObject(t.ui) && t.ui['visibility'] !== undefined);
  if (set.length === 0)
    return notOffered('No tool sets _meta.ui.visibility (it defaults to ["model", "app"]).');
  const bad = set.flatMap((t) => {
    const v = (t.ui as Record<string, unknown>)['visibility'];
    if (!Array.isArray(v)) return [`${q(t.name)}: visibility is ${kind(v)}, not an array`];
    const wrong = v.filter((x) => !VISIBILITY.includes(x as string));
    return wrong.length === 0
      ? []
      : [
          `${q(t.name)}: ${some(
            wrong.map((x) => q(x)),
            3,
          )}`,
        ];
  });
  if (bad.length > 0)
    return failed(
      `visibility with a value other than "model" or "app": ${some(bad, 3)}.`,
      'Give _meta.ui.visibility an array of "model" and "app" only.',
    );
  return passed(
    `${set.length} tool${set.length === 1 ? '' : 's'} with visibility, each holding only "model" and "app".`,
  );
};

/** What is wrong with a `_meta.ui` of a resource, by the interfaces UIResourceMeta and McpUiResourceCsp. */
export function metaProblems(ui: unknown): string[] {
  if (!isObject(ui)) return [`_meta.ui is ${kind(ui)}, not an object`];
  const out: string[] = [];
  const csp = ui['csp'];
  if (csp !== undefined) {
    if (!isObject(csp)) out.push(`csp is ${kind(csp)}, not an object`);
    else
      for (const k of ['connectDomains', 'resourceDomains', 'frameDomains', 'baseUriDomains'])
        if (
          csp[k] !== undefined &&
          !(Array.isArray(csp[k]) && (csp[k] as unknown[]).every((d) => typeof d === 'string'))
        )
          out.push(`csp.${k} is not an array of strings`);
  }
  const permissions = ui['permissions'];
  if (permissions !== undefined) {
    if (!isObject(permissions)) out.push(`permissions is ${kind(permissions)}, not an object`);
    else
      for (const k of ['camera', 'microphone', 'geolocation', 'clipboardWrite'])
        if (permissions[k] !== undefined && !isObject(permissions[k]))
          out.push(`permissions.${k} is ${kind(permissions[k])}, not an object`);
  }
  if (ui['domain'] !== undefined && typeof ui['domain'] !== 'string')
    out.push(`domain is ${kind(ui['domain'])}, not a string`);
  if (ui['prefersBorder'] !== undefined && typeof ui['prefersBorder'] !== 'boolean')
    out.push(`prefersBorder is ${kind(ui['prefersBorder'])}, not a boolean`);
  return out;
}

const metaShapes: ConformanceCheck = async (ctx) => {
  const found = await uiTools(ctx);
  if (isOutcome(found)) return found;
  const local: string[] = [];
  let localJudged = 0;
  for (const t of found) {
    // A tool with only the deprecated flat _meta["ui/resourceUri"] has no _meta.ui to judge.
    if (t.ui === undefined) continue;
    localJudged++;
    if (!isObject(t.ui)) local.push(`tool ${q(t.name)}: _meta.ui is ${kind(t.ui)}, not an object`);
  }
  const list = await listed(ctx);
  if (Array.isArray(list))
    for (const r of list) {
      const meta = r['_meta'];
      if (!isObject(meta) || meta['ui'] === undefined) continue;
      localJudged++;
      local.push(...metaProblems(meta['ui']).map((p) => `listed ${q(r['uri'])}: ${p}`));
    }
  const g = await gather(ctx, await uiAddresses(ctx, found), (uri, c): Judged => {
    const meta = c['_meta'];
    if (!isObject(meta) || meta['ui'] === undefined) return { problems: [], none: true };
    return { problems: metaProblems(meta['ui']).map((p) => `${q(uri)}: ${p}`) };
  });
  return verdict(
    g,
    'A _meta.ui of the wrong shape',
    'Give _meta.ui the shapes of UIResourceMeta: csp (arrays of strings), permissions (objects), domain (a string), prefersBorder (a boolean).',
    { bad: local, judged: localJudged },
  );
};

/** A block of a tool's content that says something: not an empty or blank one. */
const meaningful = (block: unknown): boolean => {
  if (!isObject(block)) return false;
  switch (block['type']) {
    case 'text':
      return typeof block['text'] === 'string' && block['text'].trim() !== '';
    case 'image':
    case 'audio':
      return typeof block['data'] === 'string' && block['data'] !== '';
    case 'resource':
      return isObject(block['resource']);
    case 'resource_link':
      return typeof block['uri'] === 'string' && block['uri'] !== '';
    default:
      return false;
  }
};

/** The fixture calls that name a tool with a UI, made once per run. Nothing else the fixture names is called here. */
function uiCalls(
  ctx: ConformanceContext,
  found: readonly UiTool[],
  list: unknown[],
): Promise<{ name: string; answer: Answer }[]> {
  return ctx.memo('apps fixture calls', async () => {
    const out: { name: string; answer: Answer }[] = [];
    for (const c of ctx.fixture ?? []) {
      if (!found.some((t) => t.name === c.tool)) continue;
      const tool = list.find(
        (t): t is Record<string, unknown> => isObject(t) && t['name'] === c.tool,
      );
      if (tool === undefined) continue;
      out.push({
        name: c.tool,
        // A modern client over HTTP mirrors the x-mcp-header parameters into Mcp-Param headers.
        answer: await call(
          ctx,
          'tools/call',
          { name: c.tool, arguments: c.arguments },
          ctx.era === 'modern' && ctx.transport === 'http'
            ? { headers: paramHeaders(tool, c.arguments) }
            : undefined,
        ),
      });
    }
    return out;
  });
}

const textFallback: ConformanceCheck = async (ctx) => {
  const found = await uiTools(ctx);
  if (isOutcome(found)) return found;
  if (ctx.fixture === undefined)
    return {
      state: 'could-not-run',
      reason: 'needs-input',
      actual:
        'No --fixture: no tool is called without one. Name a tool that has a UI and safe arguments in a fixture file to run this check.',
    };
  const list = await tools(ctx);
  if (isOutcome(list)) return list;
  const called = await uiCalls(ctx, found, list);
  if (called.length === 0)
    return {
      state: 'could-not-run',
      reason: 'needs-input',
      actual:
        'No --fixture call names a tool that has _meta.ui, and no other tool is called by this suite.',
    };
  const bad: string[] = [];
  const notJudged: string[] = [];
  let judged = 0;
  for (const { name, answer } of called) {
    if (answer.kind !== 'result') {
      notJudged.push(
        `${q(name)} answered ${answer.kind === 'error' ? `error ${String(answer.code)}` : 'no JSON-RPC answer'}`,
      );
      continue;
    }
    // A tool error, or a result that is not complete (input_required), is not the answer of a tool that did its work.
    const type = answer.result['resultType'];
    if (answer.result['isError'] === true || (type !== undefined && type !== 'complete')) {
      notJudged.push(
        `${q(name)} answered ${answer.result['isError'] === true ? 'a tool error' : `a result of type ${q(type)}`}`,
      );
      continue;
    }
    judged++;
    const content = answer.result['content'];
    if (!Array.isArray(content)) bad.push(`${q(name)}: no content array`);
    else if (!content.some(meaningful))
      bad.push(
        `${q(name)}: ${content.length === 0 ? 'an empty content array' : 'no block that says anything'}`,
      );
  }
  if (bad.length > 0)
    return failed(
      `A tool with a UI returned no content a client without the UI can use: ${some(bad, 3)}.`,
      'Return a text content (a summary of the result) from every tool that has a UI, besides structuredContent and the UI itself.',
    );
  if (judged === 0)
    return prerequisite(`No fixture call gave a result to judge: ${some(notJudged, 3)}.`);
  return passed(
    `${judged} call${judged === 1 ? '' : 's'} of tools with a UI, each with a content that says something.`,
  );
};

export const APPS: Record<string, ConformanceCheck> = {
  'apps-ui-resource-uri-scheme': scheme,
  'apps-ui-resource-exists': exists,
  'apps-ui-mime-type': mimeType,
  'apps-ui-content-payload': payload,
  'apps-ui-listed-mime': listedMime,
  'apps-ui-visibility-values': visibility,
  'apps-ui-tool-text-fallback': textFallback,
  'apps-ui-meta-shapes': metaShapes,
};
