// A server for `plune mcp snapshot` and `plune mcp diff`, as data: tools, resources, resource templates and prompts,
// with instructions. The SDK's low-level Server sends every list as written.
// - run as a script (`node snapshot-server.mjs <mode> [reverse]`) it serves over stdio;
// - `snapshotServer(mode, { reverse, echo })` builds the same server for an HTTP transport in the test process.
// Modes:
// - `full`: everything. With `reverse`, every list, every `required` and every set of properties comes in the opposite
//   order, so two runs differ in order only;
// - `echo`: as `full`, and the description of `weather_get` repeats `echo` (SNAPSHOT_ECHO for the script): a server
//   that leaks a credential it was given;
// - `resources-fail`: declares resources and answers resources/list with an error;
// - `empty`: declares tools and lists none;
// - `paged`: tools one per page; `endless`: tools/list always says there is another page;
// - `argv`: as `full`, and the description of `weather_get` repeats API_KEY and the command line it was started with;
// - `deepA` / `deepB`: one tool whose parameter is nested 32 objects deep, its innermost enum `a, b` / `a`;
// - `no-templates`: declares resources and has no resources/templates/list handler (Method not found).

import { pathToFileURL } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const object = (properties, required) => ({ type: 'object', properties, required });

const TOOLS = [
  {
    name: 'weather_get',
    description: 'Returns the current weather for one city.',
    inputSchema: object(
      {
        city: { type: 'string', description: 'City name' },
        units: { type: 'string', enum: ['metric', 'imperial'] },
      },
      ['city', 'units'],
    ),
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: 'note_delete',
    description: 'Deletes one note.',
    inputSchema: object({ id: { type: 'string' }, confirm: { type: 'boolean' } }, [
      'id',
      'confirm',
    ]),
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  // Names a locale would order differently from code units.
  {
    name: 'Zeta',
    description: 'Upper case first.',
    inputSchema: object({}, []),
    annotations: { readOnlyHint: true },
  },
  {
    name: 'alpha',
    description: 'Lower case.',
    inputSchema: object({}, []),
    annotations: { readOnlyHint: true },
  },
];
const RESOURCES = [
  {
    uri: 'file:///notes/readme.md',
    name: 'readme',
    description: 'How the notes are kept.',
    mimeType: 'text/markdown',
  },
  { uri: 'file:///notes/index.json', name: 'index', mimeType: 'application/json' },
];
const TEMPLATES = [
  {
    uriTemplate: 'file:///notes/{id}',
    name: 'note',
    description: 'One note by id.',
    mimeType: 'text/plain',
  },
];
const PROMPTS = [
  {
    name: 'звіт',
    description: 'Summarise the notes.',
    arguments: [
      { name: 'period', description: 'Which days', required: true },
      { name: 'style', description: 'House style' },
    ],
  },
];

/**
 * A deep copy with every list and every object's keys in the opposite order; an `enum` keeps its order, which is the
 * server's to choose and stays in the snapshot as sent.
 */
const reversed = (v) =>
  Array.isArray(v)
    ? v.map(reversed).reverse()
    : v !== null && typeof v === 'object'
      ? Object.fromEntries(
          Object.entries(v)
            .map(([k, x]) => [k, k === 'enum' ? x : reversed(x)])
            .reverse(),
        )
      : v;

/** @param {string} mode @param {{ reverse?: boolean, echo?: string | string[] | undefined }} [options] */
export function snapshotServer(mode, { reverse = false, echo } = {}) {
  const order = (list) => (reverse ? reversed(list) : structuredClone(list));
  const tools = order(TOOLS);
  if (mode === 'argv') {
    const weather = tools.find((t) => t.name === 'weather_get');
    weather.description = `key=${process.env.API_KEY} argv=${process.argv.join(' ')}`;
  }
  if (mode === 'deepA' || mode === 'deepB') {
    let schema = { type: 'string', enum: mode === 'deepA' ? ['a', 'b'] : ['a'] };
    for (let i = 0; i < 32; i++) schema = object({ n: schema }, ['n']);
    tools.splice(0, tools.length, {
      name: 'deep',
      inputSchema: schema,
      annotations: { readOnlyHint: true },
    });
  }
  if (mode === 'echo') {
    const weather = tools.find((t) => t.name === 'weather_get');
    weather.description = `Returns the current weather for one city. Sends Authorization: ${echo} to the weather service.`;
  }
  const capabilities =
    mode === 'empty' || mode === 'paged' || mode === 'endless'
      ? { tools: {} }
      : { tools: { listChanged: true }, resources: { subscribe: true }, prompts: {} };
  const server = new Server(
    { name: `notes-${mode}`, version: '2.0.0', title: 'Notes' },
    { capabilities, instructions: 'Read a note before you delete it.' },
  );
  server.setRequestHandler(ListToolsRequestSchema, (request) => {
    const page = Number(request.params?.cursor ?? 0);
    if (mode === 'empty') return { tools: [] };
    if (mode === 'endless') return { tools: [tools[0]], nextCursor: String(page + 1) };
    if (mode === 'paged')
      return {
        tools: [tools[page]],
        ...(page + 1 < tools.length ? { nextCursor: String(page + 1) } : {}),
      };
    return { tools };
  });
  if (capabilities.resources !== undefined) {
    server.setRequestHandler(ListResourcesRequestSchema, () => {
      if (mode === 'resources-fail') throw new Error('the notes folder is not mounted');
      return { resources: order(RESOURCES) };
    });
    if (mode !== 'no-templates')
      server.setRequestHandler(ListResourceTemplatesRequestSchema, () => ({
        resourceTemplates: order(TEMPLATES),
      }));
  }
  if (capabilities.prompts !== undefined)
    server.setRequestHandler(ListPromptsRequestSchema, () => ({ prompts: order(PROMPTS) }));
  return server;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = snapshotServer(process.argv[2], {
    reverse: process.argv[3] === 'reverse',
    echo: process.env.SNAPSHOT_ECHO,
  });
  await server.connect(new StdioServerTransport());
}
