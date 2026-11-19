// The small server the examples of the plune-mcp-evals skill (skills/plune-mcp-evals/examples) are written for: a
// notes service with three reads, a write and a destructive delete. Two reads overlap on purpose (both find notes),
// so the examples carry a scenario that tells them apart. Run as a script it serves stdio; every call answers a fixed
// text, because only its tools/list is read (by `plune mcp snapshot`, as the skill tells an agent to read it).

import { pathToFileURL } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const object = (properties, required = Object.keys(properties)) => ({
  type: 'object',
  properties,
  required,
});
const READ = { readOnlyHint: true, openWorldHint: false };

export const NOTES_TOOLS = [
  {
    name: 'notes_search',
    description:
      'Finds notes whose title or text contains the given words. Returns ids, titles and dates.',
    inputSchema: object({ query: { type: 'string', description: 'Words to look for.' } }),
    annotations: READ,
  },
  {
    name: 'notes_recent',
    description:
      'Lists the notes changed most recently, newest first. Returns ids, titles and dates.',
    inputSchema: object(
      { limit: { type: 'integer', description: 'How many notes, 1 to 50.' } },
      [],
    ),
    annotations: READ,
  },
  {
    name: 'note_get',
    description: 'Reads one note in full by its id.',
    inputSchema: object({ id: { type: 'string', description: 'The id of the note.' } }),
    annotations: READ,
  },
  {
    name: 'note_create',
    description: 'Creates a note with a title and a text. Returns its id.',
    inputSchema: object({ title: { type: 'string' }, text: { type: 'string' } }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'note_delete',
    description: 'Deletes a note by its id. It cannot be undone.',
    inputSchema: object({ id: { type: 'string', description: 'The id of the note.' } }),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
];

export function notesServer() {
  const server = new Server({ name: 'notes', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: NOTES_TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => ({
    content: [{ type: 'text', text: `${request.params.name}: done.` }],
  }));
  return server;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await notesServer().connect(new StdioServerTransport());
}
