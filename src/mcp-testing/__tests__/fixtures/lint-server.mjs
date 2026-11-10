// Servers for `plune mcp lint`, as data: each mode is a tool list and what each tool answers when called. The SDK's
// low-level Server sends the list as written, so a schema no SDK would build (an inputSchema without a type) reaches
// the client as it would from a careless server.
// - run as a script (`node lint-server.mjs <mode>`) it serves over stdio; `crash` prints API_TOKEN to stderr and exits
//   before it reads anything;
// - `lintServer(mode, callLog)` builds the same server for an HTTP transport in the test process.
// Every tools/call is appended to `callLog` (FIXTURE_CALL_LOG for the script), one tool name per line, before it is
// answered, so a test can say which tools were called and which never were.

import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const object = (properties, required = Object.keys(properties)) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const READ = { readOnlyHint: true, openWorldHint: false };
const text = (value) => ({ content: [{ type: 'text', text: value }] });

const CLEAN = [
  {
    name: 'weather_get',
    description:
      'Returns the current weather for one city: temperature, wind and sky. Do not use it for forecasts; use forecast_get instead.',
    inputSchema: object({ city: { type: 'string', description: 'City name, for example Kyiv.' } }),
    annotations: READ,
  },
  {
    name: 'forecast_get',
    description:
      'Returns the forecast for the next days of one place. Not for the weather right now: weather_get answers that.',
    inputSchema: object({
      place: { type: 'string', description: 'Place to forecast, a city or a region.' },
      days: {
        type: 'integer',
        minimum: 1,
        maximum: 7,
        description: 'How many days ahead, 1 to 7.',
      },
    }),
    annotations: READ,
  },
];

const UKRAINIAN = [
  {
    name: 'cases_get',
    description:
      'Повертає тест-кейси одного набору разом із кроками та очікуваним результатом. Не використовуйте для запусків: для них є run_start.',
    inputSchema: object({
      suite: { type: 'string', description: 'Ідентифікатор набору, з якого брати кейси.' },
    }),
    annotations: READ,
  },
  {
    name: 'suite_describe',
    description:
      'Показує опис набору тестів, його власника та дату останньої зміни. Не застосовуйте його, щоб читати самі кейси.',
    inputSchema: object({
      suite: { type: 'string', description: 'Ідентифікатор набору, який треба описати.' },
    }),
    annotations: READ,
  },
  {
    name: 'run_start',
    description:
      'Запускає прогін обраного набору на вказаному середовищі та повертає номер прогону. Не викликайте його двічі для того самого набору.',
    inputSchema: object({
      suite: { type: 'string', description: 'Ідентифікатор набору, що запускається.' },
      environment: {
        type: 'string',
        enum: ['beta', 'prod'],
        description: 'Середовище, одне з: beta або prod.',
      },
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: 'report_export',
    description:
      'Збирає звіт прогону у файл обраного формату та повертає посилання на нього. Лише для завершених прогонів, не для тих, що ще йдуть.',
    inputSchema: object(
      {
        run: { type: 'string', description: 'Номер прогону, звіт якого потрібен.' },
        labels: {
          type: 'object',
          description: 'Додаткові мітки звіту, наприклад {"команда": "QA"}.',
        },
      },
      ['run'],
    ),
    annotations: READ,
  },
  {
    name: 'project_summary',
    description:
      'Підсумок проєкту: скільки кейсів, наборів і прогонів у ньому є. Не для подробиць окремого прогону: їх дає report_export.',
    inputSchema: object({
      project: { type: 'string', description: 'Ідентифікатор проєкту для підсумку.' },
    }),
    annotations: READ,
  },
];

/** A tool with one heuristic warning (a "count" that is a free string) and nothing else. */
const HEURISTIC = [
  {
    name: 'notes_get',
    description:
      'Returns the notes of one project, newest first. Do not use it for tasks; use tasks_get instead.',
    inputSchema: object(
      {
        project: { type: 'string', description: 'The project the notes belong to.' },
        count: { type: 'string', description: 'How many notes to return.' },
      },
      ['project'],
    ),
    annotations: READ,
  },
];

/** One finding per level: an input schema without a type (error), no description (warning), no annotations (info). */
const MIXED = [{ name: 'broken', inputSchema: { properties: {} } }, ...CLEAN];

const BIG = 'x'.repeat(60_000);

/** A tool for --call: no arguments, read-only, its own description. */
const callable = (name, description, call, extra = {}) => ({
  name,
  description: `${description} Do not use it for anything else.`,
  inputSchema: object({}),
  annotations: READ,
  call,
  ...extra,
});

/** For --call: what each tool answers. `call` is the result as sent; `hang` never answers. */
const CALLS = [
  callable(
    'read_ok',
    'Answers with a short sentence about the weather.',
    text('Sunny, 21 °C, light wind from the west.'),
  ),
  callable('read_big', 'Answers with a very long text.', text(BIG)),
  callable('read_error', 'Fails without saying why.', { content: [], isError: true }),
  {
    ...callable('read_dup', 'Answers with structured content and its copy as text.'),
    outputSchema: object({ city: { type: 'string' }, temp: { type: 'number' } }),
    call: {
      content: [{ type: 'text', text: '{"temp":21,"city":"Kyiv"}' }],
      structuredContent: { city: 'Kyiv', temp: 21 },
    },
  },
  {
    ...callable('read_bad_struct', 'Returns a count of the wrong type.'),
    outputSchema: object({ count: { type: 'number' } }),
    call: {
      content: [{ type: 'text', text: 'There are some.' }],
      structuredContent: { count: 'some' },
    },
  },
  callable('write_note', 'Writes a note and says nothing about its hints.', text('written'), {
    annotations: undefined,
  }),
  callable('read_wipe', 'Says it reads, and that it destroys.', text('wiped'), {
    annotations: { readOnlyHint: true, destructiveHint: true },
  }),
];

const HANG = [callable('read_slow', 'Never answers.', undefined, { hang: true })];

const CONTROL = [
  {
    ...CLEAN[0],
    name: 'x\n::error::boom',
    description:
      '\u001b[31mRed\u001b[0m text.\r\n::warning::second line. Do not use it; use weather_get instead.',
  },
];

export const MODES = {
  clean: CLEAN,
  mixed: MIXED,
  heuristic: HEURISTIC,
  ukrainian: UKRAINIAN,
  empty: [],
  calls: CALLS,
  hang: HANG,
  control: CONTROL,
  paged: CLEAN,
  forever: CLEAN,
};

/** The tool as `tools/list` sends it: what a tool answers is not part of it. */
const listed = ({ call: _call, hang: _hang, ...tool }) => JSON.parse(JSON.stringify(tool));

/** A low-level SDK server for a mode; `paged` sends one tool per page, `forever` always says there is another page. */
export function lintServer(mode, callLog) {
  const tools = MODES[mode];
  if (tools === undefined) throw new Error(`no mode ${mode}`);
  const server = new Server(
    { name: `lint-${mode}`, version: '1.2.3' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, (request) => {
    const page = Number(request.params?.cursor ?? 0);
    if (mode === 'paged')
      return {
        tools: [listed(tools[page])],
        ...(page + 1 < tools.length ? { nextCursor: String(page + 1) } : {}),
      };
    if (mode === 'forever') return { tools: [listed(tools[0])], nextCursor: String(page + 1) };
    return { tools: tools.map(listed) };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (callLog) appendFileSync(callLog, `${request.params.name}\n`);
    const tool = tools.find((t) => t.name === request.params.name);
    if (tool?.hang) return new Promise(() => {});
    return tool?.call ?? { content: [{ type: 'text', text: 'unknown tool' }], isError: true };
  });
  return server;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = process.argv[2];
  if (mode === 'crash') {
    process.stderr.write(`starting with API_TOKEN=${process.env.API_TOKEN}\n`);
    process.stderr.write('fatal: cannot open the database\n');
    process.exit(1);
  }
  await lintServer(mode, process.env.FIXTURE_CALL_LOG).connect(new StdioServerTransport());
}
