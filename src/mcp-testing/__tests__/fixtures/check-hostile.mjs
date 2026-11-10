// Stdio servers that push `plune mcp check` and `plune mcp lint` past the sizes and shapes a careful server sends,
// written as plain JSON-RPC so no SDK corrects them. The mode is argv[2]:
// - `biglist`: one tools/list page of 150 000 entries;
// - `bigpaged`: ten pages of 20 000 read-only tools that need no argument;
// - `bigerror`: a tool whose call fails with 5 MB of text, and a ping that fails with a 3 MB message;
// - `slowpages`: a tools/list that never ends, each page after 900 ms, and a ping that never answers;
// - `trick`: read-only-looking tools whose schema or hints make a call unsafe;
// - `no-templates`: declares resources, and answers resources/templates/list with Method not found;
// - `argv`: writes its own arguments to stderr and exits before it reads anything.
// Every tools/call is appended to FIXTURE_CALL_LOG, one name per line, before it is answered.

import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const mode = process.argv[2];

if (mode === 'argv') {
  process.stderr.write(`args: ${process.argv.slice(2).join(' ')}\n`);
  process.exit(1);
}

const READ = { readOnlyHint: true };
const tool = (name, annotations, inputSchema = { type: 'object', properties: {} }) => ({
  name,
  inputSchema,
  ...(annotations === undefined ? {} : { annotations }),
});
const many = (count, prefix, annotations) =>
  Array.from({ length: count }, (_, i) => tool(`${prefix}${i}`, annotations));
const later = (ms, value) => new Promise((resolve) => setTimeout(() => resolve(value), ms));
const never = () => new Promise(() => {});

const TRICK = [
  tool('allof_required', READ, { type: 'object', allOf: [{ required: ['id'] }] }),
  tool('anyof_required', READ, { type: 'object', anyOf: [{ required: ['id'] }] }),
  tool('oneof_required', READ, { type: 'object', oneOf: [{ required: ['id'] }] }),
  tool('ref_required', READ, {
    $ref: '#/$defs/a',
    $defs: { a: { type: 'object', required: ['id'] } },
  }),
  tool('dependent_required', READ, { type: 'object', dependentRequired: { a: ['b'] } }),
  tool('min_properties', READ, { type: 'object', minProperties: 1 }),
  tool('read_only_string', { readOnlyHint: 'true' }),
  tool('destructive_string', { readOnlyHint: true, destructiveHint: 'true' }),
  tool('destructive_number', { readOnlyHint: true, destructiveHint: 1 }),
];

const caps = mode === 'no-templates' ? { resources: {} } : { tools: {} };

const handlers = {
  initialize: (p) => ({
    protocolVersion: p.protocolVersion,
    capabilities: caps,
    serverInfo: { name: `hostile-${mode}`, version: '0.0.1' },
  }),
  ping: () => {
    if (mode === 'slowpages') return never();
    if (mode === 'bigerror') throw { code: -32603, message: 'E'.repeat(3_000_000) };
    return {};
  },
  'tools/list': (p) => {
    const page = Number(p?.cursor ?? 0);
    if (mode === 'biglist') return { tools: many(150_000, 't', undefined) };
    if (mode === 'bigpaged')
      return {
        tools: many(20_000, `p${page}_`, READ),
        ...(page < 9 ? { nextCursor: String(page + 1) } : {}),
      };
    if (mode === 'slowpages')
      return later(900, { tools: [tool(`page_${page}`, READ)], nextCursor: String(page + 1) });
    if (mode === 'trick') return { tools: TRICK };
    if (mode === 'bigerror') return { tools: [tool('big', READ)] };
    return { tools: [tool('ok', READ)] };
  },
  'tools/call': (p) => {
    if (process.env.FIXTURE_CALL_LOG) appendFileSync(process.env.FIXTURE_CALL_LOG, `${p.name}\n`);
    if (mode === 'bigerror')
      return { content: [{ type: 'text', text: 'x'.repeat(5_000_000) }], isError: true };
    return { content: [{ type: 'text', text: 'ok' }] };
  },
  'resources/list': () => ({ resources: [] }),
};

const send = (message) =>
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');

createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', async (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.id === undefined) return;
  const handle = handlers[message.method];
  if (handle === undefined) {
    send({ id: message.id, error: { code: -32601, message: 'Method not found' } });
    return;
  }
  try {
    send({ id: message.id, result: await handle(message.params) });
  } catch (err) {
    send({
      id: message.id,
      error: { code: err.code ?? -32603, message: err.message ?? String(err) },
    });
  }
});
