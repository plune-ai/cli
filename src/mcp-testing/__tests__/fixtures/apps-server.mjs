// A stdio MCP server for the `apps` suite of `plune mcp conformance`, plain JSON-RPC so no SDK corrects what it sends.
// argv[2] is the mode, argv[3] is `modern` to serve the 2026-07-28 era (server/discover) instead of initialize.
// - `good`: a tool with a UI (`weather`), an app-only one (`refresh`) and a plain one, the resource listed and read as the
//   specification asks;
// - `no-ui`: tools and resources, no UI and no extension;
// - `ext-only`: declares the extension, no tool has _meta.ui;
// - `wrong-scheme`: the tool and a listed resource of the MCP Apps media type are not under ui://;
// - `missing`: the resource the tool names is not found (-32002, or -32602 in the modern revision);
// - `missing-other-code`: the same with the code of the other revision;
// - `wrong-mime`: the content and the list name text/html;
// - `both`, `neither`: the content has text and blob, or neither; `blob-good`, `blob-bad`: the HTML as base64, or text
//   that is not base64;
// - `not-html`: the content has no HTML5 doctype;
// - `bad-visibility`, `bad-meta`: values the interfaces of the specification do not allow;
// - `huge`: a resource over the limit of the checker;
// - `no-fallback`, `blank-fallback`: tools/call answers an empty content, or one blank text block;
// - `hostile`: every text the server sends is long and starts with `::error::`;
// - `secret-uri`: the tool names an address that carries a secret from the environment, after 25 characters;
// - `silent-read`: resources/read is never answered;
// - `error-internal`, `error-method`, `empty-contents`: resources/read of a ui:// address answers -32603, -32601, or
//   an empty contents list (only -32002 says the resource is not there);
// - `many`: 33 tools, each with an address of its own, all readable;
// - `flat-key`: the one tool has only the deprecated `_meta["ui/resourceUri"]`;
// - `ui-string`, `ui-null`, `ui-array`: the tool's `_meta.ui` is not an object;
// - `list-fails`: resources/list answers -32603; `list-no-mime`: the listed resource has no mimeType;
// - `comments-x`, `comments-doctype`, `comment-unclosed`, `comments-far`: 290 comments before `x` or the doctype, one
//   comment never closed, comments that run past 2048 characters before the doctype;
// - `mime-case`: the content's mimeType in other letter case and with spaces around `;`.

import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const mode = process.argv[2];
const modern = process.argv[3] === 'modern';
const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
const ok = (id, result) =>
  send({ id, result: modern ? { resultType: 'complete', ...result } : result });
const fail = (id, code, message) => send({ id, error: { code, message } });

const APP = 'text/html;profile=mcp-app';
const HTML = '<!DOCTYPE html><html><body><p>Sunny</p></body></html>';
const URI = mode === 'wrong-scheme' ? 'https://apps.example/weather' : 'ui://apps/weather';
const HOSTILE = `::error::${'A'.repeat(5000)}\n::error::second`;
const HTML_MARKER = 'HTML-BODY-MARKER-9f3a';
// secret-uri: an address that is not under ui:// and carries APPS_SECRET (given with --env, so the run masks it) after
// 25 characters, so the 60-character cut of a message falls inside the secret.
const SECRET_URI = `https://apps.example/${'f'.repeat(25)}${process.env.APPS_SECRET ?? ''}/weather`;
const uri = mode === 'hostile' ? `ui://${HOSTILE}` : mode === 'secret-uri' ? SECRET_URI : URI;
const toolName = mode === 'hostile' ? `::error::${'T'.repeat(300)}` : 'weather';

const visibility = mode === 'bad-visibility' ? ['model', 'admin'] : ['model', 'app'];
const WEATHER = {
  name: toolName,
  description: 'Weather with a dashboard',
  inputSchema: { type: 'object' },
  _meta: { ui: { resourceUri: uri, visibility } },
};
const REFRESH = {
  name: 'refresh',
  description: 'Refreshes the dashboard',
  inputSchema: { type: 'object' },
  _meta: { ui: { resourceUri: URI, visibility: mode === 'bad-visibility' ? 'app' : ['app'] } },
};
const PLAIN = { name: 'plain', description: 'No UI', inputSchema: { type: 'object' } };

const FLAT = {
  name: 'weather',
  description: 'Weather',
  inputSchema: { type: 'object' },
  _meta: { 'ui/resourceUri': URI },
};
const BAD_UI = { 'ui-string': 'x', 'ui-null': null, 'ui-array': [] };

function tools() {
  if (mode === 'no-ui' || mode === 'ext-only') return [PLAIN];
  if (mode === 'flat-key') return [FLAT, PLAIN];
  if (mode in BAD_UI)
    return [
      {
        name: 'weather',
        description: 'Weather',
        inputSchema: { type: 'object' },
        _meta: { ui: BAD_UI[mode] },
      },
    ];
  if (mode === 'many')
    return Array.from({ length: 33 }, (_, i) => ({
      name: `t${i}`,
      description: 'UI',
      inputSchema: { type: 'object' },
      _meta: { ui: { resourceUri: `ui://apps/${i}` } },
    }));
  return [WEATHER, REFRESH, PLAIN];
}

function capabilities() {
  const c = { tools: {}, resources: {} };
  if (mode === 'ext-only') c.extensions = { 'io.modelcontextprotocol/ui': {} };
  else if (modern && mode !== 'no-ui') c.extensions = { 'io.modelcontextprotocol/ui': {} };
  return c;
}

const listedMime =
  mode === 'wrong-mime' ? 'text/html' : mode === 'hostile' ? `::error::${'M'.repeat(200)}` : APP;
function resources() {
  if (mode === 'no-ui' || mode === 'ext-only') return [{ uri: 'mem://a', name: 'a' }];
  if (mode === 'many') return [];
  const list = [{ uri, name: 'weather', mimeType: listedMime }];
  if (mode === 'list-no-mime') delete list[0].mimeType;
  if (mode === 'wrong-scheme')
    list.push({ uri: 'https://apps.example/other', name: 'other', mimeType: APP });
  if (mode === 'bad-meta') list[0]._meta = { ui: { csp: 'self', prefersBorder: 'yes' } };
  return list;
}

function content() {
  const base = {
    uri,
    mimeType:
      mode === 'wrong-mime'
        ? 'text/html'
        : mode === 'mime-case'
          ? 'Text/HTML ; Profile=MCP-App'
          : APP,
  };
  const meta = {
    csp: {
      connectDomains: ['https://api.example.com'],
      resourceDomains: ['https://cdn.example.com'],
    },
    permissions: { camera: {} },
    domain: 'weather.example',
    prefersBorder: true,
  };
  switch (mode) {
    case 'both':
      return { ...base, text: HTML, blob: Buffer.from(HTML).toString('base64') };
    case 'neither':
      return base;
    case 'blob-good':
      return { ...base, blob: Buffer.from(HTML).toString('base64') };
    case 'blob-bad':
      return { ...base, blob: 'this is not base64!!' };
    case 'not-html':
      return { ...base, text: '<p>no doctype</p>' };
    case 'comments-x':
      return { ...base, text: `${'<!---->'.repeat(290)}x` };
    case 'comments-doctype':
      return { ...base, text: `${'<!---->'.repeat(290)}<!DOCTYPE html><html></html>` };
    case 'comment-unclosed':
      return { ...base, text: '<!-- never closed <!DOCTYPE html><html></html>' };
    case 'comments-far':
      return { ...base, text: `${'<!---->'.repeat(400)}<!DOCTYPE html><html></html>` };
    case 'huge':
      return { ...base, text: `<!DOCTYPE html><html>${'a'.repeat(4 * 1024 * 1024 + 1)}</html>` };
    case 'bad-meta':
      return {
        ...base,
        text: HTML,
        _meta: {
          ui: {
            csp: { connectDomains: 'https://x.example', frameDomains: [1] },
            permissions: { camera: true },
            domain: 5,
            prefersBorder: 'yes',
          },
        },
      };
    case 'hostile':
      return {
        uri,
        mimeType: HOSTILE,
        text: `${HOSTILE}\n${HTML_MARKER}\n<script>alert(1)</script>`,
        _meta: { ui: { domain: HOSTILE } },
      };
    default:
      return { ...base, text: HTML, _meta: { ui: meta } };
  }
}

function call(id, params) {
  // The test reads this to see which tools a run called: one name a line.
  if (process.env.APPS_CALL_LOG) appendFileSync(process.env.APPS_CALL_LOG, `${params.name}\n`);
  if (mode === 'no-fallback') return ok(id, { content: [], structuredContent: { sky: 'sunny' } });
  if (mode === 'blank-fallback') return ok(id, { content: [{ type: 'text', text: '   ' }] });
  return ok(id, {
    content: [{ type: 'text', text: `Sunny (${String(params.name).slice(0, 20)})` }],
  });
}

function answer(msg) {
  const { id, method, params = {} } = msg;
  switch (method) {
    case 'initialize':
      if (modern) return fail(id, -32601, 'Method not found');
      return ok(id, {
        protocolVersion: '2025-11-25',
        capabilities: capabilities(),
        serverInfo: { name: `apps-${mode}`, version: '1.0.0' },
      });
    case 'server/discover':
      if (!modern) return fail(id, -32601, 'Method not found');
      return ok(id, {
        supportedVersions: ['2026-07-28'],
        capabilities: capabilities(),
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: `apps-${mode}`, version: '1.0.0' } },
      });
    case 'ping':
      return ok(id, {});
    case 'tools/list':
      return ok(id, { tools: tools() });
    case 'tools/call':
      return call(id, params);
    case 'resources/list':
      if (mode === 'list-fails') return fail(id, -32603, 'Internal error');
      return ok(id, { resources: resources() });
    case 'resources/read':
      if (process.env.APPS_READ_LOG)
        appendFileSync(
          process.env.APPS_READ_LOG,
          `${params.uri}
`,
        );
      if (mode === 'silent-read') return;
      if (mode === 'error-internal') return fail(id, -32603, 'Internal error');
      if (mode === 'error-method') return fail(id, -32601, 'Method not found');
      if (mode === 'error-secret') return fail(id, -32603, `${'e'.repeat(100)}${process.env.SECRET_TEXT ?? ''}`);
      if (mode === 'empty-contents') return ok(id, { contents: [] });
      if (mode === 'many' && String(params.uri).startsWith('ui://apps/'))
        return ok(id, { contents: [{ ...content(), uri: params.uri }] });
      // The code for a missing resource follows the revision: -32002 up to 2025-11-25, -32602 from 2026-07-28.
      if (mode === 'missing' && String(params.uri).startsWith('ui://'))
        return fail(id, modern ? -32602 : -32002, 'Resource not found');
      if (mode === 'missing-other-code' && String(params.uri).startsWith('ui://'))
        return fail(id, modern ? -32002 : -32602, 'Resource not found');
      if (params.uri === uri || params.uri === URI) return ok(id, { contents: [content()] });
      if (params.uri === 'https://apps.example/other')
        return ok(id, { contents: [{ uri: params.uri, mimeType: APP, text: HTML }] });
      return fail(id, -32002, 'Resource not found');
    default:
      return fail(id, -32601, 'Method not found');
  }
}

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id === undefined) return;
  answer(msg);
});
lines.on('close', () => process.exit(0));
