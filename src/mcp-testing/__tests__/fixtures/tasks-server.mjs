// A server of the Tasks extension (io.modelcontextprotocol/tasks, revision 2026-07-28) for the `tasks` suite of
// `plune mcp conformance`, plain JSON-RPC so no SDK corrects what it sends. `answer(mode, state, msg, emit)` answers one
// message; run as a process it serves stdio in the mode of argv[2] (argv[3] `legacy`: the 2025-11-25 handshake, without the
// extension). The HTTP test wraps the same function in node:http.
// Tools: `export` (makes a task for a client that declared the extension) and `plain` (never a task).
// A task answers tasks/get by a list of statuses, one per poll; env TASKS_CALL_LOG: every method asked, one a line.
// - `good`: working, input_required (twice, the same request), completed with a result; keeps every requirement;
// - `failing`: working, then failed with an error and a statusMessage;
// - `never`: the task stays working; tasks/cancel is acknowledged and the task becomes cancelled;
// - `stuck`: the task stays working, and tasks/cancel is acknowledged but changes nothing;
// - `no-task`: `export` answers an ordinary result: the server never makes a task; `ext-missing`: no extension declared;
// - `untyped`: the task handle has resultType "complete"; `task-elsewhere`: tools/list has resultType "task";
// - `task-undeclared`: `export` makes a task for a client that did not declare the extension;
// - `undeclared-ok`, `undeclared-code`, `undeclared-no-data`: tasks/* without the declaration is served, -32602, or
//   -32021 without data.requiredCapabilities;
// - `no-result-type`, `bad-status`, `no-created`, `float-ttl`: tasks/get without resultType, with a status the
//   specification does not have, without createdAt, with ttlMs 1.5 and a string pollIntervalMs;
// - `no-result`, `no-error`, `no-input-requests`: completed without result, failed without error, input_required without
//   inputRequests; `failing-no-message`: failed without statusMessage;
// - `unknown-ok`, `unknown-code`: tasks/get for an unknown id is served, or answers -32603; `unknown-update-ok`: tasks/update
//   and tasks/cancel for an unknown id are acknowledged;
// - `cancel-extra`, `cancel-no-type`, `cancel-error`: tasks/cancel answers a task, has no resultType, or answers -32603;
//   `update-extra`, `update-no-type`, `update-error`: the same for tasks/update;
// - `key-reuse`: the key of inputRequests holds another request at the second poll;
// - `hostile`: like `stuck`; the id, the status and the messages are long, start with `::error::` and carry TASKS_SECRET after 25
//   characters.

import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

export const EXT = 'io.modelcontextprotocol/tasks';
const CAPS = 'io.modelcontextprotocol/clientCapabilities';
const declared = (params) => params?._meta?.[CAPS]?.extensions?.[EXT] !== undefined;
const HOSTILE = (secret) =>
  `::error::${'A'.repeat(25)}${secret}${'B'.repeat(5000)}\n::error::second`;

const TOOLS = [
  { name: 'export', description: 'Exports a report', inputSchema: { type: 'object' } },
  { name: 'plain', description: 'Answers at once', inputSchema: { type: 'object' } },
];
const REQUEST = (text) => ({
  method: 'elicitation/create',
  params: {
    mode: 'form',
    message: text,
    requestedSchema: { type: 'object', properties: { name: { type: 'string' } } },
  },
});
const SEQUENCES = {
  good: ['working', 'input_required', 'input_required', 'completed'],
  failing: ['working', 'failed'],
  'failing-no-message': ['working', 'failed'],
  'no-error': ['working', 'failed'],
  never: ['working'],
  stuck: ['working'],
  hostile: ['working'],
  'key-reuse': ['input_required', 'input_required', 'input_required', 'completed'],
  'no-result': ['working', 'completed'],
  'no-input-requests': ['working', 'input_required'],
};

const log = (method) => {
  if (process.env.TASKS_CALL_LOG) appendFileSync(process.env.TASKS_CALL_LOG, `${method}\n`);
};

export function answer(mode, state, msg, emit) {
  const { id, method, params = {} } = msg;
  state.tasks ??= new Map();
  const send = (m) => emit({ jsonrpc: '2.0', ...m });
  const ok = (result) => send({ id, result: { resultType: 'complete', ...result } });
  const fail = (code, message, data) =>
    send({ id, error: { code, message, ...(data === undefined ? {} : { data }) } });
  const secret = process.env.TASKS_SECRET ?? '';
  const hostile = mode === 'hostile';
  const seq = SEQUENCES[mode] ?? SEQUENCES.good;
  const missing = () =>
    fail(
      -32021,
      'Missing required client capability',
      mode === 'undeclared-no-data'
        ? undefined
        : { requiredCapabilities: { extensions: { [EXT]: {} } } },
    );

  const base = (t, status) => ({
    taskId: t.id,
    status,
    ...(mode === 'no-created' ? {} : { createdAt: '2026-11-13T10:00:00Z' }),
    lastUpdatedAt: '2026-11-13T10:00:01Z',
    ttlMs: mode === 'float-ttl' ? 1.5 : 60000,
    pollIntervalMs: mode === 'float-ttl' ? '10' : 10,
    ...(hostile ? { statusMessage: HOSTILE(secret) } : {}),
  });
  const statusOf = (t) =>
    t.cancelled && mode !== 'stuck' && !hostile
      ? 'cancelled'
      : seq[Math.min(t.polls, seq.length - 1)];
  const detail = (t, status) => {
    const b = base(t, status);
    if (mode === 'bad-status') return { ...b, status: 'running' };
    if (status === 'input_required' && mode !== 'no-input-requests')
      return {
        ...b,
        inputRequests: {
          name: REQUEST(mode === 'key-reuse' && t.polls > 1 ? 'Another question?' : 'Your name?'),
        },
      };
    if (status === 'completed' && mode !== 'no-result')
      return {
        ...b,
        result: { content: [{ type: 'text', text: 'report ready' }], isError: false },
      };
    if (status === 'failed')
      return {
        ...b,
        ...(mode === 'failing-no-message' ? {} : { statusMessage: 'The export failed' }),
        ...(mode === 'no-error' ? {} : { error: { code: -32603, message: 'The export failed' } }),
      };
    return b;
  };
  const taskOf = () => {
    const key = params.taskId;
    return typeof key === 'string' ? state.tasks.get(key) : undefined;
  };
  const unknown = () => fail(-32602, 'Failed to retrieve task: Task not found');

  switch (method) {
    case 'initialize':
      if (!state.legacy) return fail(-32601, 'Method not found');
      return send({
        id,
        result: {
          protocolVersion: '2025-11-25',
          capabilities: { tools: {} },
          serverInfo: { name: `tasks-${mode}`, version: '1.0.0' },
        },
      });
    case 'server/discover':
      if (state.legacy) return fail(-32601, 'Method not found');
      return ok({
        supportedVersions: ['2026-07-28'],
        capabilities: {
          tools: {},
          ...(mode === 'ext-missing' ? {} : { extensions: { [EXT]: {} } }),
        },
        _meta: {
          'io.modelcontextprotocol/serverInfo': { name: `tasks-${mode}`, version: '1.0.0' },
        },
      });
    case 'ping':
      return ok({});
    case 'tools/list':
      return send({
        id,
        result: { resultType: mode === 'task-elsewhere' ? 'task' : 'complete', tools: TOOLS },
      });
    case 'tools/call': {
      log(`tools/call ${params.name}`);
      const makes =
        params.name === 'export' &&
        mode !== 'no-task' &&
        (declared(params) || mode === 'task-undeclared');
      if (!makes) return ok({ content: [{ type: 'text', text: 'done' }] });
      const t = {
        id: hostile
          ? `${'t'.repeat(25)}${secret}${'u'.repeat(300)}`
          : `task-${state.tasks.size + 1}`,
        polls: 0,
        cancelled: false,
      };
      state.tasks.set(t.id, t);
      return send({
        id,
        result: { ...base(t, 'working'), resultType: mode === 'untyped' ? 'complete' : 'task' },
      });
    }
    case 'tasks/get': {
      log('tasks/get');
      if (!declared(params) && mode !== 'undeclared-ok')
        return mode === 'undeclared-code' ? fail(-32602, 'Invalid params') : missing();
      const t = taskOf();
      if (t === undefined) {
        if (mode === 'unknown-ok') return ok(base({ id: String(params.taskId) }, 'working'));
        return mode === 'unknown-code' ? fail(-32603, 'Internal error') : unknown();
      }
      const status = statusOf(t);
      const body = detail(t, status);
      t.polls += 1;
      return send({
        id,
        result: mode === 'no-result-type' ? body : { resultType: 'complete', ...body },
      });
    }
    case 'tasks/update': {
      log('tasks/update');
      if (!declared(params) && mode !== 'undeclared-ok')
        return mode === 'undeclared-code' ? fail(-32602, 'Invalid params') : missing();
      if (taskOf() === undefined && mode !== 'unknown-update-ok') return unknown();
      if (mode === 'update-error') return fail(-32603, 'Internal error');
      if (mode === 'update-no-type') return send({ id, result: {} });
      if (mode === 'update-extra') return ok(base({ id: String(params.taskId) }, 'working'));
      return ok({});
    }
    case 'tasks/cancel': {
      log('tasks/cancel');
      if (!declared(params) && mode !== 'undeclared-ok')
        return mode === 'undeclared-code' ? fail(-32602, 'Invalid params') : missing();
      const t = taskOf();
      if (t === undefined && mode !== 'unknown-update-ok') return unknown();
      if (mode === 'cancel-error') return fail(-32603, 'Internal error');
      if (t !== undefined) t.cancelled = true;
      if (mode === 'cancel-no-type') return send({ id, result: {} });
      if (mode === 'cancel-extra') return ok(base({ id: String(params.taskId) }, 'cancelled'));
      return ok({});
    }
    default:
      return fail(-32601, 'Method not found');
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = process.argv[2] ?? 'good';
  const state = { legacy: process.argv[3] === 'legacy' };
  const write = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);
  const lines = createInterface({ input: process.stdin });
  lines.on('line', (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.id === undefined) return;
    answer(mode, state, msg, write);
  });
  lines.on('close', () => process.exit(0));
}
