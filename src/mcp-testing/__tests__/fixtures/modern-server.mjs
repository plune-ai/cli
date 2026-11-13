// A server of the 2026-07-28 revision for the conformance checks, written as plain JSON-RPC so no SDK corrects what it
// sends. `answer(mode, state, msg, emit, end)` answers one message: `emit` sends a message (a line on stdio, an SSE event
// over HTTP), `end` closes the answer (the HTTP stream; nothing on stdio). Run as a process it serves stdio in the mode
// of argv[2]; the HTTP tests wrap the same function in node:http and add the header rules there.
// - `good`: keeps every requirement of the modern checks, modern only;
// - `dual`: `good`, and it also answers initialize (a dual-era server);
// - `bad`: breaks each modern requirement it can, one way per check (see the comments below);
// - `empty`: `good`, but an unknown resource reads as empty contents;
// - `no-discover`: answers server/discover without capabilities.

import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

const MODERN = '2026-07-28';
const META = {
  version: 'io.modelcontextprotocol/protocolVersion',
  capabilities: 'io.modelcontextprotocol/clientCapabilities',
  serverInfo: 'io.modelcontextprotocol/serverInfo',
  subscriptionId: 'io.modelcontextprotocol/subscriptionId',
};
const HINTS = { ttlMs: 60000, cacheScope: 'public' };

export const ECHO = {
  name: 'echo',
  description: 'Echoes the text',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  outputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
};
// Needs elicitation, which a client that declares nothing does not have.
export const ASK = { name: 'ask', description: 'Asks the user', inputSchema: { type: 'object' } };
// Mirrors region into Mcp-Param-Region over HTTP.
export const REGION = {
  name: 'region',
  description: 'Runs in a region',
  inputSchema: { type: 'object', properties: { region: { type: 'string', 'x-mcp-header': 'Region' } } },
};
// bad: x-mcp-header on a number, under items, and twice the same name in another case.
const BAD_REGION = {
  name: 'region',
  inputSchema: {
    type: 'object',
    properties: {
      region: { type: 'string', 'x-mcp-header': 'Region' },
      size: { type: 'number', 'x-mcp-header': 'region' },
      list: { type: 'array', items: { type: 'string', 'x-mcp-header': 'Item' } },
    },
  },
};

export const capabilitiesOf = (mode) => ({ tools: { listChanged: true }, prompts: {}, resources: {}, completions: {}, logging: {} });

const supported = (mode) => (mode === 'dual' ? [MODERN, '2025-11-25'] : [MODERN]);

/** One answer: a result (with resultType unless bad says otherwise) or an error. */
const result = (id, r) => ({ jsonrpc: '2.0', id, result: { resultType: 'complete', ...r } });
const error = (id, code, message, data) => ({ jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } });

export function answer(mode, state, msg, emit, end = () => {}) {
  const bad = mode === 'bad';
  const { id, method, params = {} } = msg;
  if (id === undefined) return end();
  const send = (frame) => {
    emit(frame);
    end();
  };
  if (method === 'initialize') {
    if (mode !== 'dual') return send(error(id, -32601, 'Method not found'));
    // A dual-era server: initialize puts this connection in the legacy era.
    state.legacy = true;
    return send({
      jsonrpc: '2.0',
      id,
      result: { protocolVersion: '2025-11-25', capabilities: capabilitiesOf(mode), serverInfo: { name: 'modern-dual', version: '1.0.0' } },
    });
  }
  if (state.legacy && method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
  const meta = params._meta ?? {};
  // bad: a request without the required _meta fields, or for a revision it does not know, is served all the same.
  if (!bad && !state.legacy) {
    if (typeof meta[META.version] !== 'string' || meta[META.capabilities] === null || typeof meta[META.capabilities] !== 'object')
      return send(error(id, -32602, 'Missing required _meta field'));
    if (!supported(mode).includes(meta[META.version]))
      return send(error(id, -32022, 'Unsupported protocol version', { supported: supported(mode), requested: meta[META.version] }));
  }
  // bad: no request before server/discover on a connection is served.
  if (bad && method === 'server/discover') state.discovered = true;
  if (bad && !state.discovered) return send(error(id, -32600, 'Call server/discover first'));
  // bad: a log message for a request that set no logLevel.
  if (bad && method === 'tools/list') emit({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'listing' } });
  switch (method) {
    case 'ping':
      // bad: ping, which the revision removed, still answers.
      return bad ? send(result(id, {})) : send(error(id, -32601, 'Method not found'));
    case 'server/discover': {
      const r = { supportedVersions: supported(mode), capabilities: capabilitiesOf(mode), ...HINTS };
      if (mode === 'no-discover') delete r.capabilities;
      // bad: no serverInfo in _meta.
      return send(result(id, bad ? r : { ...r, _meta: { [META.serverInfo]: { name: `modern-${mode}`, version: '1.0.0' } } }));
    }
    case 'tools/list': {
      if (params.cursor === undefined) {
        // bad: the first page has no resultType and a negative ttlMs.
        if (bad) return send({ jsonrpc: '2.0', id, result: { tools: [ECHO], nextCursor: 'page-2', ttlMs: -1, cacheScope: 'public' } });
        return send(result(id, { tools: [ECHO], nextCursor: 'page-2', ...HINTS }));
      }
      if (params.cursor === 'page-2') {
        // bad: the second page has another cacheScope, and a tool named after its process (it varies per connection).
        if (bad) return send(result(id, { tools: [ASK, BAD_REGION, { ...ASK, name: `conn-${state.connection}` }], ttlMs: 1, cacheScope: 'private' }));
        return send(result(id, { tools: [ASK, REGION], ...HINTS }));
      }
      return send(error(id, -32602, 'Invalid cursor'));
    }
    case 'tools/call': {
      const name = params.name;
      if (typeof name !== 'string') return send(error(id, -32602, 'name is required'));
      if (name === 'echo') {
        const data = { text: String(params.arguments?.text ?? '') };
        return send(result(id, { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data }));
      }
      if (name === 'ask') {
        // bad: asks for elicitation by input_required although the client declared no capability.
        if (bad)
          return send(result(id, { resultType: 'input_required', inputRequests: { who: { method: 'elicitation/create', params: { mode: 'form', message: 'Who?', requestedSchema: { type: 'object', properties: {} } } } } }));
        return send(error(id, -32021, 'Missing required client capability', { requiredCapabilities: { elicitation: {} } }));
      }
      if (name === 'region') return send(result(id, { content: [{ type: 'text', text: String(params.arguments?.region ?? '') }] }));
      return send(error(id, -32602, `Unknown tool: ${name}`));
    }
    case 'resources/list':
      return send(result(id, { resources: [{ uri: 'mem://a', name: 'a' }], ...HINTS }));
    case 'resources/read':
      if (params.uri === 'mem://a') return send(result(id, { contents: [{ uri: 'mem://a', text: 'A' }], ...HINTS }));
      // bad: the code of earlier revisions; empty: a result with no contents.
      if (bad) return send(error(id, -32002, 'Resource not found'));
      if (mode === 'empty') return send(result(id, { contents: [], ...HINTS }));
      return send(error(id, -32602, 'Resource not found'));
    case 'resources/templates/list':
      // bad: no caching hints.
      return send(result(id, { resourceTemplates: [{ uriTemplate: 'mem://{id}', name: 'item' }], ...(bad ? {} : HINTS) }));
    case 'prompts/list':
      // bad: a cacheScope that is neither public nor private.
      return send(result(id, { prompts: [{ name: 'greet', arguments: [{ name: 'who' }] }], ...HINTS, ...(bad ? { cacheScope: 'shared' } : {}) }));
    case 'prompts/get':
      if (params.name === 'greet') return send(result(id, { messages: [] }));
      return send(error(id, -32602, 'Unknown prompt'));
    case 'completion/complete':
      // bad: a code of the range the specification keeps for itself, which it does not define.
      if (bad) return send(error(id, -32050, 'Completion failed'));
      return send(result(id, { completion: { values: ['world'], hasMore: false } }));
    case 'subscriptions/listen': {
      const tag = { [META.subscriptionId]: id };
      const ack = { jsonrpc: '2.0', method: 'notifications/subscriptions/acknowledged', params: { _meta: tag, notifications: params.notifications ?? {} } };
      const changed = (what, t) => ({ jsonrpc: '2.0', method: `notifications/${what}/list_changed`, params: t === undefined ? {} : { _meta: t } });
      if (bad) {
        // bad: a notification before the acknowledgment, one nobody asked for without a tag, then an error to end it.
        emit(changed('tools', tag));
        emit(ack);
        setTimeout(() => emit(changed('prompts')), 50);
        setTimeout(() => {
          if (state.http) end();
          else emit(error(id, -32603, 'Subscription ended'));
        }, 100);
        return;
      }
      emit(ack);
      setTimeout(() => emit(changed('tools', tag)), 50);
      // It ends the subscription on its own, as at shutdown, with a successful response.
      setTimeout(() => send({ jsonrpc: '2.0', id, result: { resultType: 'complete', _meta: tag } }), 100);
      return;
    }
    default:
      return send(error(id, -32601, 'Method not found'));
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = process.argv[2] ?? 'good';
  const state = { connection: process.pid };
  const write = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);
  const lines = createInterface({ input: process.stdin });
  lines.on('line', (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    }
    answer(mode, state, msg, write);
  });
  lines.on('close', () => process.exit(0));
}
