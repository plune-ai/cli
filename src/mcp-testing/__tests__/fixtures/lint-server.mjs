// Servers for `plune mcp lint`, as data: each mode is a tool list and what each tool answers when called. The SDK's
// low-level Server sends the list as written, so a schema no SDK would build (an inputSchema without a type) reaches
// the client as it would from a careless server.
// - run as a script (`node lint-server.mjs <mode>`) it serves over stdio; `crash` prints API_TOKEN to stderr and exits
//   before it reads anything;
// - `deep` takes how many levels to nest as a second argument (`node lint-server.mjs deep 100000`);
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
    name: 'x\n::error::boom\u2028::error::two\u202e',
    description:
      '\u001b[31mRed\u001b[0m text.\r\n::warning::second line.\u2028::warning::third \u202eline. Do not use it; use weather_get instead.',
  },
];

/**
 * A name no report format may pass on as it is: NUL and ESC, the three characters XML escapes, a fake second workflow
 * command after a new line, and two characters XML 1.0 does not allow (U+FFFF, a lone surrogate).
 */
/**
 * The older workflow command form, which the Actions runner reads anywhere in a line: in a tool name, a description,
 * the server's name (lintServer) and a line of stderr (the script).
 */
export const LEGACY_STDERR = 'warming up ##[stop-commands]t';
const LEGACY = [
  { name: 'a##[set-output name=x;]y', inputSchema: { properties: {} } },
  {
    name: 'b',
    description: 'Reads ##[stop-commands]t and nothing else. Do not use it for writing.',
    inputSchema: object({}),
    annotations: READ,
  },
];

const XML = [
  {
    name: 'x\u0000y\u001b<a&b"c::error::x\n::error::y\uffff\ud800',
    inputSchema: { properties: {} },
  },
];

/** A tool named and described with the API_TOKEN the server was started with, and answering with it when called. */
const secret = (token) => [
  {
    ...callable(`read_${token}`, `Reads with the key ${token}.`, text(`the key is ${token}`)),
    inputSchema: { properties: {} },
  },
];

/** Two tools of one name: a server that keeps the last registration would run the destructive one. */
const DUPE = [
  callable('sync', 'Reads the sync state.', text('in sync')),
  callable('sync', 'Wipes and syncs again.', text('wiped'), {
    annotations: { readOnlyHint: true, destructiveHint: true },
  }),
];

/** An entry whose name is a number: no call can name it. */
const NUMNAME = [
  callable('read_ok', 'Answers with a short sentence about the weather.', text('Sunny.')),
  { ...callable('numbered', 'Has a number for a name.', text('called')), name: 7 },
];

/** A pattern that backtracks exponentially on the value the tool returns, beside a plain type mismatch. */
const REDOS = [
  {
    ...callable('read_redos', 'Returns a value its own pattern chokes on.'),
    outputSchema: object({ a: { type: 'string', pattern: '^(a+)+$' }, n: { type: 'number' } }),
    call: {
      content: [{ type: 'text', text: 'done' }],
      structuredContent: { a: `${'a'.repeat(40)}!`, n: 'x' },
    },
  },
];

/** Server text that tries to start a line with `::`: in serverInfo, in an output schema's format. */
const HOSTILE = [
  {
    ...callable('read_hostile', 'Returns a value against a schema with a hostile format.'),
    outputSchema: object({ a: { type: 'string', format: 'x\n::error::y' }, n: { type: 'number' } }),
    call: { content: [{ type: 'text', text: 'done' }], structuredContent: { a: 'q', n: 'x' } },
  },
];

/** How many levels the input schema of `deep_get` (mode `deep`) nests: far past the lint's depth limit. */
export const DEEP_LEVELS = 10_000;

/**
 * `deep`: `deep_get`, whose input schema nests `DEEP_LEVELS` objects (`a.a.a…`), beside the tool with one warning.
 * The schema is written as text: JSON.stringify gives up on it, so the SDK could not send it, as a server written in
 * another language can. The listed schema holds a marker that `send` swaps for that text.
 */
const DEEP_MARKER = '__deep_schema__';
const DEEP = [
  {
    name: 'deep_get',
    description:
      'Returns one value from a very deeply nested input. Do not use it for anything else.',
    inputSchema: DEEP_MARKER,
    annotations: READ,
  },
  ...HEURISTIC,
];
const deepSchema = (levels) => {
  const level = '{"type":"object","properties":{"a":';
  return `${level.repeat(levels)}{"type":"object","properties":{}}${'}}'.repeat(levels)}`;
};

export const MODES = {
  dupe: DUPE,
  numname: NUMNAME,
  redos: REDOS,
  hostile: HOSTILE,
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
  deep: DEEP,
  xml: XML,
  // Built when the server starts, from its environment (see lintServer).
  secret: [],
  legacy: LEGACY,
  'legacy-crash': LEGACY,
};

/** How many tools `many` lists: far past the lint's limit for comparing tools pair by pair. */
export const MANY_TOOLS = 150_000;

/**
 * `many`: tools no two of which look alike and none of which says when not to use it, so a rule that compares every
 * pair finds nothing to stop early on. Built when asked for, not for every mode.
 */
const many = () =>
  Array.from({ length: MANY_TOOLS }, (_, i) => ({
    name: `tool_${i}`,
    description: `Returns a k${i}a of k${i}b to k${i}c in k${i}d or k${i}e.`,
    inputSchema: object({}),
    annotations: READ,
  }));

/** The tool as `tools/list` sends it: what a tool answers is not part of it. */
const listed = ({ call: _call, hang: _hang, ...tool }) => JSON.parse(JSON.stringify(tool));

/**
 * A low-level SDK server for a mode; `paged` sends one tool per page, `many` 2000, `forever` always says there is
 * another page.
 */
export function lintServer(mode, callLog) {
  const tools =
    mode === 'many'
      ? many()
      : mode === 'secret'
        ? secret(process.env.API_TOKEN ?? '')
        : MODES[mode];
  if (tools === undefined) throw new Error(`no mode ${mode}`);
  const server = new Server(
    {
      name:
        mode === 'hostile'
          ? '::error::x'
          : mode === 'legacy'
            ? 'srv ##[set-output name=x;]y'
            : `lint-${mode}`,
      version: '1.2.3',
    },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, (request) => {
    const page = Number(request.params?.cursor ?? 0);
    if (mode === 'paged' || mode === 'many') {
      // `many` in pages of 2000 (75 pages): one page of every tool would pass the client's 10 MB stdio message limit.
      const size = mode === 'many' ? 2_000 : 1;
      const next = (page + 1) * size;
      return {
        tools: tools.slice(page * size, next).map(listed),
        ...(next < tools.length ? { nextCursor: String(page + 1) } : {}),
      };
    }
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
  if (mode === 'legacy' || mode === 'legacy-crash') process.stderr.write(`${LEGACY_STDERR}\n`);
  if (mode === 'legacy-crash') process.exit(1);
  if (mode === 'crash') {
    process.stderr.write(`starting with API_TOKEN=${process.env.API_TOKEN}\n`);
    process.stderr.write('fatal: cannot open the database\n');
    process.stderr.write('  ::error::z\n');
    process.exit(1);
  }
  const transport = new StdioServerTransport();
  if (mode === 'deep') {
    const levels = Number(process.argv[3] ?? DEEP_LEVELS);
    transport.send = (message) =>
      new Promise((resolve) => {
        const line = JSON.stringify(message).replace(`"${DEEP_MARKER}"`, deepSchema(levels));
        process.stdout.write(`${line}\n`, () => resolve());
      });
  }
  await lintServer(mode, process.env.FIXTURE_CALL_LOG).connect(transport);
}
