/**
 * The catalog entries of the `tasks` suite: what an MCP server that offers the Tasks extension (`io.modelcontextprotocol/tasks`)
 * owes a client that declared it. Data only, like catalog.ts, which appends these to CATALOG. The text is the
 * specification of the extension, https://github.com/modelcontextprotocol/ext-tasks/blob/main/specification/2026-07-28/tasks.md
 * (and its schema/2026-07-28/schema.ts), read on 2026-11-13 together with https://modelcontextprotocol.io/seps/2663-tasks-extension.md
 * (Final, "preserved as a historical record"), https://modelcontextprotocol.io/extensions/tasks/overview.md and
 * https://modelcontextprotocol.io/extensions/overview.md, which lists MCP Tasks at the stage "Beta, to Core". Where the SEP and
 * the extension text differ, the extension text is the one quoted (the SEP's example of a failed task has resultType
 * "task"; the extension text has "complete", as the sentence about tasks/get says).
 *
 * The extension exists from the revision 2026-07-28: the checks are for modern sessions only, and only against a server that
 * declares the extension in the capabilities of server/discover. The experimental Tasks of 2025-11-25 are another feature
 * and have no check here. Notifications (`notifications/tasks`, `subscriptions/listen`) are not checked: they are optional.
 *
 * `derivation` quotes the sentence the level comes from, word for word. `derived`: the level is read from a sentence that
 * is not about exactly what the check judges, or the text gives no criterion; `derivation` says which. A rule of the text
 * with no keyword in it (`MUST`, `SHOULD`) is a `SHOULD` at most.
 */

import type { CatalogEntry, Era, SpecRef } from './catalog.js';

export const TASKS_SPEC_URL =
  'https://github.com/modelcontextprotocol/ext-tasks/blob/main/specification/2026-07-28/tasks.md';
const MODERN: Era[] = ['modern'];
const ref = (section: string): SpecRef => ({
  revision: '2026-07-28',
  page: 'tasks.md',
  section,
  url: TASKS_SPEC_URL,
});

const tasks = (
  s: Omit<CatalogEntry, 'suite' | 'kind' | 'derived' | 'needsFixture' | 'transports' | 'eras'> &
    Partial<Pick<CatalogEntry, 'derived' | 'needsFixture' | 'transports'>>,
): CatalogEntry => ({
  ...s,
  suite: 'tasks',
  kind: 'check',
  derived: s.derived ?? false,
  // Every check reads a task, and a task comes from a tool the user names in --fixture.
  needsFixture: s.needsFixture ?? true,
  transports: s.transports ?? ['stdio', 'http'],
  eras: MODERN,
});

export const TASKS_CATALOG: readonly CatalogEntry[] = [
  tasks({
    id: 'tasks-result-type',
    title: 'A task handle has resultType "task", and no other result has it',
    description:
      'The result of the --fixture call that made a task has resultType "task", a string taskId and a status of the specification. A result that carries a task handle (a string taskId and a status) without resultType "task" fails; so does any other result the run got (server/discover, tools/list, tasks/get, a call that made no task) that has resultType "task".',
    level: 'MUST',
    derivation:
      'Polymorphic Results: "Servers **MUST** set `resultType` to `"task"` when returning a `CreateTaskResult` so that clients can distinguish it from a standard result. Servers **MUST NOT** set `resultType` to `"task"` on result types other than `CreateTaskResult`."',
    specRefs: [ref('Polymorphic Results'), ref('Task Creation')],
  }),
  tasks({
    id: 'tasks-undeclared-no-task',
    title: 'A client that did not declare the extension is given no task',
    description:
      'The --fixture call that made a task for a client that declared the extension is sent once more without the declaration. The answer is not a task handle (a result of another kind, or an error, is not judged further). The first call, the control, has to have made a task: otherwise the check is could-not-run.',
    level: 'MUST',
    derivation:
      'Capability Negotiation: "A server **MUST NOT** return `CreateTaskResult` to a client that did not include the extension capability on its request, regardless of prior declarations."',
    specRefs: [ref('Capability Negotiation')],
  }),
  tasks({
    id: 'tasks-undeclared-capability-error',
    title: 'tasks/get, tasks/update and tasks/cancel without the declaration are -32021',
    description:
      'Each of the three methods, sent for the task the run made but without the extension in the client capabilities, is answered with the error -32021 whose data.requiredCapabilities.extensions names io.modelcontextprotocol/tasks. The same tasks/get with the declaration has to be accepted (the control). The run may cancel its own task this way if the server accepts the request.',
    level: 'MUST',
    derivation:
      'Protocol Errors: "Servers **MUST** return this error for non-declaring clients issuing `tasks/get`, `tasks/update`, and `tasks/cancel` requests." with "Missing required client capabilities: `-32021` (Missing Required Client Capability)". The error shape (data.requiredCapabilities) is the example of Capability Negotiation: no sentence says MUST about data.',
    specRefs: [ref('Protocol Errors'), ref('Capability Negotiation')],
  }),
  tasks({
    id: 'tasks-get-status-shape',
    title: 'tasks/get answers a task with resultType "complete" and the fields of a task',
    description:
      'Each tasks/get answer of the run is a result with resultType "complete", the taskId asked for, one of the five statuses (working, input_required, completed, failed, cancelled), createdAt and lastUpdatedAt as ISO 8601 date-times, and a ttlMs member. At most 6 polls of one task, within 5 seconds, by the pollIntervalMs the server gives kept between 20 and 1000 ms.',
    level: 'MUST',
    derived: true,
    derivation:
      'Response: "The `resultType` field **MUST** be set to `"complete"` on this object as it is the standard result shape for the `tasks/get` request." and "the server **MUST** return a a `Task` object with status `working`". The required fields (taskId, status, createdAt, lastUpdatedAt, ttlMs) are those of the interface Task, which no sentence with a keyword repeats; the set of statuses is that of "Tasks can be in one of the following states".',
    specRefs: [ref('Task Polling'), ref('Tasks')],
  }),
  tasks({
    id: 'tasks-status-payload',
    title: 'completed has a result, failed an error, input_required inputRequests',
    description:
      'Of the tasks/get answers the run got: one with status completed has a result object, one with failed has an error object, one with input_required has an inputRequests object. A status the run never saw is not judged; if it saw none of the three, the check is not-applicable (not-offered).',
    level: 'MUST',
    derivation:
      'Response: "If the status is `input_required`, the server **MUST** return a `Task` object with status `input_required` and an `inputRequests` field"; "If the status is `completed`, the server **MUST** return a `Task` object with status `completed` and a `result` field containing the final result of the task."; "If the status is `failed`, the server **MUST** return a `Task` object with status `failed` and the error that occurred during execution."',
    specRefs: [ref('Task Polling')],
  }),
  tasks({
    id: 'tasks-ttl-poll-integers',
    title: 'ttlMs is an integer or null, pollIntervalMs an integer',
    description:
      'In the task handle and in each tasks/get answer, ttlMs is an integer (milliseconds) or null, and pollIntervalMs, when present, is an integer. A fraction, a string or a missing ttlMs fails.',
    level: 'SHOULD',
    derived: true,
    derivation:
      'No sentence says MUST or SHOULD about the types: the interface Task has "ttlMs: number | null;" with "Time-to-live duration from creation in integer milliseconds, null for unlimited." and "pollIntervalMs?: number;" with "Suggested polling interval in integer milliseconds." (schema.ts adds `@format int`). A requirement the text states only as a type has no keyword, so the level is SHOULD.',
    specRefs: [ref('Tasks')],
  }),
  tasks({
    id: 'tasks-unknown-id-get',
    title: 'tasks/get for an unknown taskId is -32602',
    description:
      'tasks/get for a taskId the server never made answers the error -32602. The same request for the task the run made has to be accepted (the control).',
    level: 'MUST',
    derivation:
      'Protocol Errors: "Invalid or nonexistent `taskId`: `-32602` (Invalid params)" and "Servers **MUST** return this error for `tasks/get`."',
    specRefs: [ref('Protocol Errors')],
  }),
  tasks({
    id: 'tasks-unknown-id-update-cancel',
    title: 'tasks/update and tasks/cancel for an unknown taskId are -32602',
    description:
      'tasks/update and tasks/cancel for a taskId the server never made answer the error -32602. The same requests for a task the run made have to be accepted (the controls: tasks-update-ack and tasks-cancel-ack).',
    level: 'SHOULD',
    derivation:
      'Protocol Errors: "Servers **SHOULD** return this error for `tasks/update` and `tasks/cancel`."',
    specRefs: [ref('Protocol Errors')],
  }),
  tasks({
    id: 'tasks-cancel-ack',
    title: 'tasks/cancel is acknowledged with an empty result',
    description:
      'tasks/cancel for a task the run made (a second one, not polled before) answers a result with resultType "complete" and nothing else but _meta. An error is a failure only when tasks/get shows the task still working or input_required; for a task that already ended it says nothing and is could-not-run.',
    level: 'MUST',
    derivation:
      'Task Cancellation: "On success, the server **MUST** acknowledge the request with an empty result." and "The `resultType` field **MUST** be set to `"complete"` on `CancelTaskResult` as it is the standard result shape for the `tasks/cancel` request."',
    specRefs: [ref('Task Cancellation')],
  }),
  tasks({
    id: 'tasks-update-ack',
    title: 'tasks/update is acknowledged with an empty result',
    description:
      'tasks/update with an empty inputResponses map for a task the run made answers a result with resultType "complete" and nothing else but _meta. An error says nothing about the acknowledgement (no key is outstanding, which the text says a server SHOULD ignore): could-not-run.',
    level: 'MUST',
    derivation:
      'Task Update Requests: "On success, the server **MUST** acknowledge the request with an empty result." and "The `resultType` field **MUST** be set to `"complete"` on `UpdateTaskResult` as it is the standard result shape for the `tasks/update` request."',
    specRefs: [ref('Task Update Requests')],
  }),
  tasks({
    id: 'tasks-failed-status-message',
    title: 'A failed task has a statusMessage',
    description:
      'A tasks/get answer with status failed has a statusMessage string. If the run saw no failed task, the check is not-applicable (not-offered).',
    level: 'SHOULD',
    derivation:
      'Task Execution Errors: "The `tasks/get` response **SHOULD** include a `statusMessage` field with diagnostic information about the failure, and **MUST** include the `error` field with the JSON-RPC error."',
    specRefs: [ref('Task Execution Errors')],
  }),
  tasks({
    id: 'tasks-http-name-header',
    title: 'tasks/get with Mcp-Name set to the taskId is accepted',
    description:
      'Over Streamable HTTP, tasks/get sent with Mcp-Name equal to params.taskId and Mcp-Method equal to tasks/get is answered with a result, not with the HeaderMismatch error (-32020).',
    level: 'SHOULD',
    derived: true,
    derivation:
      'Streamable HTTP: Routing Headers: "the client **MUST** set the `Mcp-Name` header to the value of `params.taskId`." The sentence is about the client; that a server accepts a request that does it is read from it, and no sentence says MUST or SHOULD about the server, so the level is SHOULD.',
    specRefs: [ref('Streamable HTTP: Routing Headers')],
    transports: ['http'],
  }),
  tasks({
    id: 'tasks-input-request-keys-unique',
    title: 'An inputRequests key never names two different requests',
    description:
      'Across the tasks/get answers of one task, a key of inputRequests that appears again holds the same request. At least two answers with inputRequests are needed, otherwise the check is not-applicable (not-offered). That a key is not reused after its response was delivered is not judged: the run never answers a request.',
    level: 'MUST',
    derived: true,
    derivation:
      'Task Update Requests: "Each request key in `inputRequests` **MUST** be unique over the lifetime of a single task. A server **MUST NOT** reuse a key for a subsequent server-to-client request after a response for that key has been delivered, and **MUST NOT** use the same key to refer to two distinct requests over a task\'s lifetime." The check judges the second half only, which is the part a client that never answers can see.',
    specRefs: [ref('Task Update Requests')],
  }),
];
