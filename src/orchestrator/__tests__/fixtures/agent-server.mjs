// A stdio MCP server for the agent loop, on the SDK's low-level Server so a name like `files/read` and every kind of
// answer can be served as is. Tools:
// - `echo`: answers its `text` argument;
// - `files/read`: answers `contents of <path>` (a name the providers refuse on their wire);
// - `fail`: answers `isError: true`;
// - `big`: answers 1 MiB of text;
// - `slow`: never answers;
// - `crash`: exits the process before it answers.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const text = (value, extra = {}) => ({ content: [{ type: 'text', text: value }], ...extra });
const obj = (properties = {}) => ({ type: 'object', properties });

const TOOLS = {
  echo: {
    inputSchema: obj({ text: { type: 'string' } }),
    annotations: { readOnlyHint: true },
    call: (args) => text(String(args.text ?? '')),
  },
  'files/read': {
    inputSchema: obj({ path: { type: 'string' } }),
    annotations: { readOnlyHint: true },
    call: (args) => text(`contents of ${String(args.path)}`),
  },
  fail: { inputSchema: obj(), call: () => text('the tool failed', { isError: true }) },
  big: { inputSchema: obj(), call: () => text('x'.repeat(1024 * 1024)) },
  slow: { inputSchema: obj(), call: () => new Promise(() => {}) },
  crash: { inputSchema: obj(), call: () => process.exit(3) },
};

const server = new Server(
  { name: 'agent-fixture', version: '1.0.0' },
  { capabilities: { tools: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: Object.entries(TOOLS).map(([name, t]) => ({
    name,
    description: `${name} for the agent fixture.`,
    inputSchema: t.inputSchema,
    ...(t.annotations ? { annotations: t.annotations } : {}),
  })),
}));
server.setRequestHandler(CallToolRequestSchema, (req) => {
  const tool = TOOLS[req.params.name];
  if (tool === undefined) throw new Error(`no tool ${req.params.name}`);
  return tool.call(req.params.arguments ?? {});
});

await server.connect(new StdioServerTransport());
