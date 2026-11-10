// Servers for `plune mcp check`, one per mode, on the SDK's low-level Server so each list, ping and call can answer,
// fail or never answer as the mode says.
// - run as a script (`node check-server.mjs <mode>`) it serves over stdio; `crash` prints API_TOKEN to stderr and exits
//   before it reads anything; every other mode prints API_TOKEN to stderr at start when it is set;
// - `checkServer(mode, callLog)` builds the same server for an HTTP transport in the test process.
// Every tools/call is appended to `callLog` (FIXTURE_CALL_LOG for the script), one tool name per line, before it is
// answered, so a test can say which tools were called and which never were.

import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  InitializeRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  PingRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const READ = { readOnlyHint: true };
const none = { type: 'object', properties: {} };
const text = (value) => ({ content: [{ type: 'text', text: value }] });
const never = () => new Promise(() => {});
const later = (ms, value) => new Promise((resolve) => setTimeout(() => resolve(value), ms));

const tool = (name, annotations, call, inputSchema = none) => ({
  name,
  description: `${name} for the check fixture.`,
  inputSchema,
  ...(annotations === undefined ? {} : { annotations }),
  call,
});

const HEALTHY_TOOLS = [
  tool('weather_get', READ, () => text('Sunny.')),
  tool('forecast_get', READ, () => text('Rain tomorrow.')),
];

/** For --smoke: one tool for each way a tool is called or left alone. */
const SMOKE_TOOLS = [
  tool('read_ok', READ, () => text('fine')),
  tool('read_error', READ, () => ({
    content: [{ type: 'text', text: 'the cache is cold' }],
    isError: true,
  })),
  tool('read_rpc_error', READ, () => {
    throw new McpError(-32603, 'internal failure in read_rpc_error');
  }),
  tool('no_hints', undefined, () => text('wrote without saying')),
  tool('read_needs_arg', READ, () => text('needs a city'), {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
  }),
  tool('write_safe', { readOnlyHint: false, destructiveHint: false }, () => text('appended')),
  tool('read_wipe', { readOnlyHint: true, destructiveHint: true }, () => text('wiped')),
  tool('write_wipe', { readOnlyHint: false, destructiveHint: true }, () => text('wiped')),
];

const SMOKE_HANG_TOOLS = [
  tool('slow_a', READ, never),
  tool('slow_b', READ, never),
  tool('read_ok', READ, () => text('fine')),
];

const SMOKE_SLOW_TOOLS = ['slow_1', 'slow_2', 'slow_3', 'slow_4'].map((name) =>
  tool(name, READ, () => later(700, text('done'))),
);

const ALL = { tools: {}, resources: {}, prompts: {} };

/** capabilities declared, tools listed, and what lists and ping do: `ok`, `error` or `hang`. */
const MODES = {
  healthy: { caps: ALL, tools: HEALTHY_TOOLS },
  'stderr-token': { caps: ALL, tools: HEALTHY_TOOLS },
  'tools-only': { caps: { tools: {} }, tools: HEALTHY_TOOLS },
  'resources-error': { caps: ALL, tools: HEALTHY_TOOLS, resources: 'error' },
  'hang-tools': { caps: { tools: {} }, tools: HEALTHY_TOOLS, toolsList: 'hang' },
  'hang-all': {
    caps: ALL,
    tools: HEALTHY_TOOLS,
    toolsList: 'hang',
    resources: 'hang',
    prompts: 'hang',
    ping: 'hang',
  },
  'old-protocol': { caps: { tools: {} }, tools: HEALTHY_TOOLS, protocolVersion: '2025-06-18' },
  smoke: { caps: { tools: {} }, tools: SMOKE_TOOLS },
  'smoke-hang': { caps: { tools: {} }, tools: SMOKE_HANG_TOOLS },
  'smoke-slow': { caps: { tools: {} }, tools: SMOKE_SLOW_TOOLS },
};

const listed = ({ call: _call, ...rest }) => rest;

export function checkServer(mode, callLog) {
  const m = MODES[mode];
  if (m === undefined) throw new Error(`no mode ${mode}`);
  const server = new Server({ name: `check-${mode}`, version: '2.0.0' }, { capabilities: m.caps });
  const answer = (how, value) => {
    if (how === 'hang') return never();
    if (how === 'error') throw new McpError(-32603, 'the list is broken');
    return value;
  };
  if (m.protocolVersion !== undefined) {
    server.setRequestHandler(InitializeRequestSchema, () => ({
      protocolVersion: m.protocolVersion,
      capabilities: m.caps,
      serverInfo: { name: `check-${mode}`, version: '2.0.0' },
    }));
  }
  // Two pages, one tool on each: a check reads lists to the end.
  server.setRequestHandler(ListToolsRequestSchema, (request) => {
    const page = Number(request.params?.cursor ?? 0);
    if (mode === 'healthy' || mode === 'stderr-token')
      return answer(m.toolsList, {
        tools: [listed(m.tools[page])],
        ...(page + 1 < m.tools.length ? { nextCursor: String(page + 1) } : {}),
      });
    return answer(m.toolsList, { tools: m.tools.map(listed) });
  });
  if ('resources' in m.caps) {
    server.setRequestHandler(ListResourcesRequestSchema, () =>
      answer(m.resources, { resources: [{ uri: 'file:///readme.md', name: 'readme' }] }),
    );
    server.setRequestHandler(ListResourceTemplatesRequestSchema, () =>
      answer(m.resources === 'error' ? 'ok' : m.resources, {
        resourceTemplates: [{ uriTemplate: 'file:///{name}', name: 'files' }],
      }),
    );
  }
  if ('prompts' in m.caps)
    server.setRequestHandler(ListPromptsRequestSchema, () =>
      answer(m.prompts, { prompts: [{ name: 'summary' }] }),
    );
  if (m.ping === 'hang') server.setRequestHandler(PingRequestSchema, never);
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (callLog) appendFileSync(callLog, `${request.params.name}\n`);
    const found = m.tools.find((t) => t.name === request.params.name);
    if (found === undefined)
      return { content: [{ type: 'text', text: 'unknown tool' }], isError: true };
    return found.call();
  });
  return server;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = process.argv[2];
  if (process.env.API_TOKEN)
    process.stderr.write(`starting with API_TOKEN=${process.env.API_TOKEN}\n`);
  if (mode === 'crash') {
    process.stderr.write('fatal: cannot open the database\n');
    process.exit(1);
  }
  await checkServer(mode, process.env.FIXTURE_CALL_LOG).connect(new StdioServerTransport());
}
