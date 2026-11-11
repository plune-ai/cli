// A stdio MCP server for the conformance checks, written as plain JSON-RPC so no SDK corrects what it sends. The mode
// is argv[2]:
// - `good`: answers every request of the protocol suite as the specification asks (two pages of tools, resources,
//   templates, prompts, logging, completions, -32700 for invalid JSON), and exits when stdin closes;
// - `bad`: breaks each requirement the protocol suite checks, one way per check (see the comments below);
// - `undeclared`: `good`, but declares only tools while it still answers resources/list and prompts/list;
// - `no-server-info`: answers initialize without serverInfo;
// - `silent`: answers initialize, then nothing.

import { createInterface } from 'node:readline';

const mode = process.argv[2];
const good = mode === 'good' || mode === 'undeclared';
const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
const ok = (id, result) => send({ id, result });
const fail = (id, code, message) => send({ id, error: { code, message } });

// bad: a log line on stdout, and the process stays alive after stdin closes.
if (mode === 'bad') {
  process.stdout.write('server starting\n');
  setInterval(() => {}, 1000);
}

const ECHO = {
  name: 'echo',
  description: 'Echoes the text',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  outputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
};
const ADD = { name: 'add', inputSchema: { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object' } };
// bad: an invalid inputSchema, a root that is not an object, a null inputSchema, a name with spaces and a comma. With
// API_TOKEN set, the name repeats it: a secret the server prints, for the masking of a report.
const BAD_TOOLS = [
  { name: 'dup', inputSchema: { type: 'object', properties: 5 }, outputSchema: { type: 'array' } },
  { name: `bad name, spaced${process.env.API_TOKEN ? ` ${process.env.API_TOKEN}` : ''}`, inputSchema: null },
];

function capabilities() {
  if (mode === 'undeclared') return { tools: {} };
  return { tools: {}, resources: {}, prompts: {}, logging: {}, completions: {} };
}

function answer(msg) {
  const { id, method, params = {} } = msg;
  switch (method) {
    case 'initialize': {
      const version = ['2025-11-25', '2025-06-18'].includes(params.protocolVersion) ? params.protocolVersion : '2025-11-25';
      const result = { protocolVersion: version, capabilities: capabilities(), serverInfo: { name: `conformance-${mode}`, version: '1.0.0' } };
      if (mode === 'no-server-info') delete result.serverInfo;
      return ok(id, result);
    }
    case 'ping':
      // bad: a ping answer that is not empty and holds both result and error.
      return good ? ok(id, {}) : send({ id, result: { ok: true }, error: { code: 1, message: 'both' } });
    case 'tools/list':
      if (good) {
        if (params.cursor === undefined) return ok(id, { tools: [ECHO], nextCursor: 'page-2' });
        if (params.cursor === 'page-2') return ok(id, { tools: [ADD] });
        return fail(id, -32602, 'Invalid cursor');
      }
      // bad: every cursor gives the first page and the same cursor again.
      return ok(id, { tools: BAD_TOOLS, nextCursor: 'again' });
    case 'tools/call': {
      if (typeof params.name !== 'string')
        return good ? fail(id, -32602, 'name is required') : ok(id, { isError: true, content: [{ type: 'text', text: 'no name' }] });
      if (params.name === 'echo' && good) {
        const data = { text: String(params.arguments?.text ?? '') };
        return ok(id, { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data });
      }
      // bad: dup answers structuredContent against its outputSchema, and no text block.
      if (params.name === 'dup' && !good) return ok(id, { content: [], structuredContent: { n: 1 } });
      return good ? fail(id, -32602, `Unknown tool: ${params.name}`) : ok(id, { isError: true, content: [{ type: 'text', text: 'unknown tool' }] });
    }
    case 'resources/list':
      return ok(id, { resources: good ? [{ uri: 'mem://a', name: 'a' }] : [{ uri: 'mem://a' }] });
    case 'resources/read':
      if (params.uri === 'mem://a')
        return ok(id, { contents: [good ? { uri: 'mem://a', text: 'A' } : { uri: 'mem://a', text: 'A', blob: 'QQ==' }] });
      return good ? send({ id, error: { code: -32002, message: 'Resource not found' } }) : ok(id, { contents: [] });
    case 'resources/templates/list':
      return ok(id, { resourceTemplates: [good ? { uriTemplate: 'mem://{id}', name: 'item' } : { uriTemplate: 'mem://{id}' }] });
    case 'prompts/list':
      return ok(id, { prompts: [{ name: 'greet', arguments: [good ? { name: 'who' } : {}] }] });
    case 'prompts/get':
      if (params.name === 'greet') return ok(id, { messages: [] });
      return good ? fail(id, -32602, 'Unknown prompt') : ok(id, { messages: [] });
    case 'logging/setLevel':
      return good ? ok(id, {}) : fail(id, -32601, 'Method not found');
    case 'completion/complete':
      return ok(id, { completion: good ? { values: ['world'], hasMore: false } : { values: [1, 2] } });
    default:
      // bad: an unknown method gets a result.
      return good ? fail(id, -32601, 'Method not found') : ok(id, {});
  }
}

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    // bad: invalid JSON gets no answer.
    if (good) send({ id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (msg.id === undefined) return;
  if (mode === 'silent' && msg.method !== 'initialize') return;
  answer(msg);
});
lines.on('close', () => {
  if (mode !== 'bad') process.exit(0);
});
