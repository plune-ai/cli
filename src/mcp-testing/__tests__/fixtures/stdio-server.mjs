// A real stdio MCP server on the SDK's McpServer. Tools:
// - `env`: the names in this process's environment (what the client let through);
// - `cwd`: its working directory;
// - `leak`: fails with API_TOKEN in the message, as a careless server would.
// It also prints API_TOKEN to stderr at start, and starts a grandchild when asked (child-helpers.mjs).

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { startGrandchild, writePids } from './child-helpers.mjs';

writePids(startGrandchild());
if (process.env.API_TOKEN)
  process.stderr.write(`starting with API_TOKEN=${process.env.API_TOKEN}\n`);

const text = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const server = new McpServer({ name: 'fixture', version: '1.0.0' });
server.registerTool('env', { description: 'Names in the environment' }, async () =>
  text(Object.keys(process.env)),
);
server.registerTool('cwd', { description: 'Working directory' }, async () => text(process.cwd()));
server.registerTool('leak', { description: 'Fails with the token in its message' }, async () => {
  throw new Error(`token ${process.env.API_TOKEN} was rejected`);
});

await server.connect(new StdioServerTransport());
