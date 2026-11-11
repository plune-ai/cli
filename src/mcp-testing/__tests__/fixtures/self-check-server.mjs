// A stdio MCP server the CI self-check step (scripts/mcp-self-check.mjs) must be red against, written as plain JSON-RPC
// so no SDK corrects what it sends. The mode is argv[2]:
// - `broken`: two tools named `dup`, one input schema whose type is not `object`, and a ping answered with an error;
// - `empty`: a healthy server with an empty tools/list;
// - `crash`: prints PLUNE_TOKEN to stderr when it is set, then exits before it reads anything.

import { createInterface } from 'node:readline';

const mode = process.argv[2];

if (mode === 'crash') {
  if (process.env.PLUNE_TOKEN) process.stderr.write(`token ${process.env.PLUNE_TOKEN}\n`);
  process.exit(1);
}

const object = { type: 'object', properties: {} };
const TOOLS =
  mode === 'broken'
    ? [
        { name: 'dup', description: 'Returns the first thing.', inputSchema: object },
        { name: 'dup', description: 'Returns the second thing.', inputSchema: object },
        { name: 'text_only', description: 'Takes a bare string.', inputSchema: { type: 'string' } },
      ]
    : [];

const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);

function answer({ id, method, params = {} }) {
  switch (method) {
    case 'initialize': {
      const version = ['2025-11-25', '2025-06-18'].includes(params.protocolVersion) ? params.protocolVersion : '2025-11-25';
      return send({ id, result: { protocolVersion: version, capabilities: { tools: {} }, serverInfo: { name: `self-check-${mode}`, version: '1.0.0' } } });
    }
    case 'ping':
      return mode === 'broken' ? send({ id, error: { code: -32603, message: 'ping is broken' } }) : send({ id, result: {} });
    case 'tools/list':
      return send({ id, result: { tools: TOOLS } });
    case 'tools/call':
      return send({ id, error: { code: -32602, message: `Unknown tool: ${params.name}` } });
    default:
      return send({ id, error: { code: -32601, message: 'Method not found' } });
  }
}

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return send({ id: null, error: { code: -32700, message: 'Parse error' } });
  }
  if (msg.id !== undefined && msg.method !== undefined) answer(msg);
});
lines.on('close', () => process.exit(0));
