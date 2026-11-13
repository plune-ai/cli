/**
 * The one catalog of `plune mcp conformance`: every check by its stable id, with the requirement it measures and
 * where that requirement is written. Check modules take their title and description from here by id and never repeat
 * them, so a report and `--list-checks` cannot disagree. Data only: no network, no process, no SDK.
 *
 * An id is kebab-case and is never renamed: a saved result is read by it. A check whose requirement changes gets a
 * new id. `level` is `MUST` only where the cited section says MUST, MUST NOT or REQUIRED about this behaviour of the
 * server; a level read from neighbouring provisions is `derived`, and `derivation` says from which. Without a keyword
 * the level is `SHOULD` at most.
 */

import type { RequirementLevel } from '../result.js';

export type Suite = 'protocol' | 'oauth' | 'tasks' | 'apps';
export const SUITES: readonly Suite[] = ['protocol', 'oauth', 'tasks', 'apps'];

/**
 * `check`: a requirement of the specification, with a level. `control`: a probe that has to hold for other checks to
 * mean anything; no score. `advice`: outside the specification; no score.
 */
export type CheckKind = 'check' | 'control' | 'advice';

/** `legacy`: revisions up to 2025-11-25, the `initialize` handshake. `modern`: 2026-07-28 on, `server/discover`. */
export type Era = 'legacy' | 'modern';
export type Transport = 'stdio' | 'http';

export interface SpecRef {
  /** The revision of the specification, as in its URL: `2025-11-25`. */
  revision: string;
  /** The page under the revision: `basic/lifecycle`. */
  page: string;
  /** The heading of the section on that page. */
  section: string;
}

export interface CatalogEntry {
  id: string;
  suite: Suite;
  title: string;
  description: string;
  kind: CheckKind;
  /** Null for `control` and `advice`: they have no level and no score. */
  level: RequirementLevel | null;
  /** The level is read from neighbouring provisions, not quoted. */
  derived: boolean;
  /** Which provisions, when `derived`. */
  derivation?: string;
  specRefs: SpecRef[];
  eras: Era[];
  transports: Transport[];
  /** It needs an input the user gives (a tool to call, a document to serve); without it, `could-not-run` (`needs-input`). */
  needsFixture: boolean;
}

/** Where a specification reference is published. */
export const specUrl = (ref: SpecRef): string =>
  `https://modelcontextprotocol.io/specification/${ref.revision}/${ref.page}`;

const L = '2025-11-25';
const M = '2026-07-28';
const BOTH: Era[] = ['legacy', 'modern'];
const ANY: Transport[] = ['stdio', 'http'];

type Spec = Omit<CatalogEntry, 'suite' | 'kind' | 'derived' | 'needsFixture'> &
  Partial<Pick<CatalogEntry, 'derived' | 'needsFixture'>>;
const check = (s: Spec): CatalogEntry => ({
  ...s,
  suite: 'protocol',
  kind: 'check',
  derived: s.derived ?? false,
  needsFixture: s.needsFixture ?? false,
});
const ref = (revision: string, page: string, section: string): SpecRef => ({ revision, page, section });
/** A control or an advice: no level, no score. */
const unscored = (kind: 'control' | 'advice', s: Omit<Spec, 'level'>): CatalogEntry => ({
  ...check({ ...s, level: null }),
  kind,
});
const HTTP: Transport[] = ['http'];
const LT = 'basic/transports';
const MT = 'basic/transports/streamable-http';

export const CATALOG: readonly CatalogEntry[] = [
  // Lifecycle
  check({
    id: 'life-initialize-result',
    title: 'initialize answers with protocolVersion, capabilities and serverInfo',
    description: 'The result of initialize holds the protocol version the server chose, its capabilities and its serverInfo.',
    level: 'MUST',
    specRefs: [ref(L, 'basic/lifecycle', 'Initialization')],
    eras: ['legacy'],
    transports: ANY,
  }),
  check({
    id: 'life-version-negotiation',
    title: 'The protocol version is negotiated',
    description:
      'Asked for a version it supports, the server answers with that version; asked for one it does not, with another version it supports.',
    level: 'MUST',
    specRefs: [ref(L, 'basic/lifecycle', 'Version Negotiation')],
    eras: ['legacy'],
    transports: ANY,
  }),
  check({
    id: 'life-capabilities-declared-served',
    title: 'Every declared capability is served',
    description:
      'For each capability declared (tools, resources, prompts, logging, completions), the matching request does not answer Method not found (-32601).',
    level: 'MUST',
    derived: true,
    derivation:
      'basic/lifecycle, Operation: only negotiated capabilities are used; the server pages: a server that supports a feature MUST declare its capability.',
    specRefs: [ref(L, 'basic/lifecycle', 'Operation')],
    eras: BOTH,
    transports: ANY,
  }),
  check({
    id: 'life-capabilities-served-declared',
    title: 'Every served list is declared',
    description: 'When tools/list, resources/list or prompts/list answers, the matching capability is declared.',
    level: 'MUST',
    specRefs: [
      ref(L, 'server/tools', 'Capabilities'),
      ref(L, 'server/resources', 'Capabilities'),
      ref(L, 'server/prompts', 'Capabilities'),
    ],
    eras: BOTH,
    transports: ANY,
  }),
  check({
    id: 'life-ping-empty-result',
    title: 'ping answers with an empty result',
    description: 'ping is answered promptly with result: {}.',
    level: 'MUST',
    specRefs: [ref(L, 'basic/utilities/ping', 'Behavior Requirements')],
    eras: ['legacy'],
    transports: ANY,
  }),
  // Base protocol
  check({
    id: 'base-jsonrpc-parse-error',
    title: 'Invalid JSON is a parse error',
    description: 'A message that is not valid JSON gets the error -32700 with id: null.',
    level: 'MUST',
    derived: true,
    derivation:
      'basic/index, Messages: MCP messages MUST follow JSON-RPC 2.0; JSON-RPC 2.0 section 5 gives -32700 and a null id to a parse error.',
    specRefs: [ref(L, 'basic/index', 'Messages')],
    eras: BOTH,
    transports: ANY,
  }),
  check({
    id: 'base-unknown-method-error',
    title: 'An unknown method is Method not found',
    description: 'A request for a method the server does not have gets the error -32601.',
    level: 'MUST',
    derived: true,
    derivation:
      'basic/index, Messages: MCP messages MUST follow JSON-RPC 2.0; JSON-RPC 2.0 section 5.1 names -32601 for a method that does not exist.',
    specRefs: [ref(L, 'basic/index', 'Messages')],
    eras: BOTH,
    transports: ANY,
  }),
  check({
    id: 'base-response-id-matches',
    title: 'A response carries the id of its request',
    description:
      'The id of a response is the id of the request; it holds exactly one of result and error; the id is not null for a valid request.',
    level: 'MUST',
    specRefs: [ref(L, 'basic/index', 'Responses'), ref(M, 'basic/index', 'Responses')],
    eras: BOTH,
    transports: ANY,
  }),
  check({
    id: 'base-invalid-params-error',
    title: 'Plainly wrong parameters are Invalid params',
    description: 'A request with plainly wrong parameters (tools/call without name) gets -32602, not -32603 and not a result.',
    level: 'SHOULD',
    specRefs: [ref(L, 'server/tools', 'Error Handling')],
    eras: BOTH,
    transports: ANY,
  }),
  // Tools
  check({
    id: 'tools-list-shape',
    title: 'Every listed tool has a name and an inputSchema object',
    description: 'Each entry of tools/list has a string name and an inputSchema that is an object, not null.',
    level: 'MUST',
    specRefs: [ref(L, 'server/tools', 'Tool')],
    eras: BOTH,
    transports: ANY,
  }),
  check({
    id: 'tools-input-schema-valid',
    title: 'Every inputSchema is a valid object schema',
    description:
      'Each inputSchema has type: "object" and is valid in its declared ($schema) or default (2020-12) dialect; an unknown dialect is reported, not a crash.',
    level: 'MUST',
    specRefs: [ref(L, 'basic/index', 'JSON Schema Usage')],
    eras: BOTH,
    transports: ANY,
  }),
  check({
    id: 'tools-output-schema-valid',
    title: 'Every outputSchema is a valid schema',
    description:
      'An outputSchema, when given, is valid in its dialect; before 2026-07-28 its root is an object, from then on any type.',
    level: 'MUST',
    specRefs: [ref(L, 'server/tools', 'Output Schema'), ref(M, 'changelog', 'Minor changes')],
    eras: BOTH,
    transports: ANY,
  }),
  check({
    id: 'tools-structured-conformant',
    title: 'structuredContent conforms to the outputSchema',
    description: 'The structuredContent of a call (from the fixture) conforms to the tool\'s outputSchema.',
    level: 'MUST',
    specRefs: [ref(L, 'server/tools', 'Output Schema')],
    eras: BOTH,
    transports: ANY,
    needsFixture: true,
  }),
  check({
    id: 'tools-structured-has-text',
    title: 'structuredContent is also given as text',
    description: 'A result with structuredContent also has a text block with the serialized JSON.',
    level: 'SHOULD',
    specRefs: [ref(L, 'server/tools', 'Structured Content')],
    eras: BOTH,
    transports: ANY,
    needsFixture: true,
  }),
  check({
    id: 'tools-name-format',
    title: 'Tool names use the allowed characters',
    description: 'Each tool name is 1 to 128 characters of A-Z, a-z, 0-9, _, - and ., without spaces or commas.',
    level: 'SHOULD',
    specRefs: [ref(L, 'server/tools', 'Tool Names')],
    eras: BOTH,
    transports: ANY,
  }),
  check({
    id: 'tools-name-unique',
    title: 'Tool names are unique',
    description: 'No two tools of the server share a name, across every page of tools/list.',
    level: 'SHOULD',
    specRefs: [ref(L, 'server/tools', 'Tool Names')],
    eras: BOTH,
    transports: ANY,
  }),
  check({
    id: 'tools-call-unknown-error',
    title: 'Calling an unknown tool is a protocol error',
    description: 'tools/call for a tool that does not exist gets a JSON-RPC error, not a result with isError.',
    level: 'SHOULD',
    specRefs: [ref(L, 'server/tools', 'Error Handling')],
    eras: BOTH,
    transports: ANY,
  }),
  check({
    id: 'tools-list-order-stable',
    title: 'tools/list keeps its order',
    description: 'Two calls of tools/list give the tools in the same order.',
    level: 'SHOULD',
    specRefs: [ref(M, 'server/tools', 'Capabilities')],
    eras: ['modern'],
    transports: ANY,
  }),
  // Resources
  check({
    id: 'resources-list-shape',
    title: 'Every listed resource has a uri and a name',
    description: 'Each entry of resources/list has uri and name.',
    level: 'MUST',
    derived: true,
    derivation: 'server/resources, Resource: uri and name are listed without "Optional"; no keyword.',
    specRefs: [ref(L, 'server/resources', 'Resource')],
    eras: BOTH,
    transports: ANY,
  }),
  check({
    id: 'resources-read-listed',
    title: 'A listed resource can be read',
    description:
      'resources/read of the first listed resource answers with contents, each with a uri and exactly one of text and blob.',
    level: 'MUST',
    derived: true,
    derivation: 'server/resources, Resource Contents: a content is text or binary data under its uri; no keyword.',
    specRefs: [ref(L, 'server/resources', 'Resource Contents')],
    eras: BOTH,
    transports: ANY,
  }),
  check({
    id: 'resources-read-not-found',
    title: 'Reading an unknown resource is an error',
    description: 'resources/read of a uri that does not exist gets -32002, not empty contents.',
    level: 'SHOULD',
    specRefs: [ref(L, 'server/resources', 'Error Handling')],
    eras: ['legacy'],
    transports: ANY,
  }),
  check({
    id: 'resources-templates-shape',
    title: 'Every resource template has a uriTemplate and a name',
    description: 'Each entry of resources/templates/list has uriTemplate and name.',
    level: 'MUST',
    derived: true,
    derivation: 'server/resources, Resource Templates: every example template has uriTemplate and name; no keyword.',
    specRefs: [ref(L, 'server/resources', 'Resource Templates')],
    eras: BOTH,
    transports: ANY,
  }),
  // Prompts
  check({
    id: 'prompts-list-shape',
    title: 'Every listed prompt has a name',
    description: 'Each entry of prompts/list has name; arguments, when given, is a list of objects with name.',
    level: 'MUST',
    derived: true,
    derivation: 'server/prompts, Prompt: name is listed without "Optional", arguments is optional; no keyword.',
    specRefs: [ref(L, 'server/prompts', 'Prompt')],
    eras: BOTH,
    transports: ANY,
  }),
  check({
    id: 'prompts-get-unknown-error',
    title: 'Getting an unknown prompt is an error',
    description: 'prompts/get with a name that does not exist gets a JSON-RPC error.',
    level: 'SHOULD',
    specRefs: [ref(L, 'server/prompts', 'Error Handling')],
    eras: BOTH,
    transports: ANY,
  }),
  // Pagination
  check({
    id: 'pagination-walk-complete',
    title: 'Paging through a list ends, without repeats',
    description: 'Following nextCursor ends within the page limit and no entry comes back on a later page.',
    level: 'SHOULD',
    specRefs: [ref(L, 'server/utilities/pagination', 'Implementation Guidelines')],
    eras: BOTH,
    transports: ANY,
  }),
  check({
    id: 'pagination-invalid-cursor',
    title: 'An invalid cursor is Invalid params',
    description: 'A list request with a cursor the server never gave gets -32602.',
    level: 'SHOULD',
    specRefs: [ref(L, 'server/utilities/pagination', 'Error Handling')],
    eras: BOTH,
    transports: ANY,
  }),
  // Utilities
  check({
    id: 'logging-set-level',
    title: 'logging/setLevel is accepted when logging is declared',
    description: 'A server that declares logging accepts logging/setLevel.',
    level: 'SHOULD',
    derived: true,
    derivation:
      'server/utilities/logging: the MUST is on declaring the capability, not on handling logging/setLevel, so handling it is a SHOULD.',
    specRefs: [ref(L, 'server/utilities/logging', 'Capabilities')],
    eras: ['legacy'],
    transports: ANY,
  }),
  check({
    id: 'completion-complete',
    title: 'completion/complete answers when completions is declared',
    description: 'A server that declares completions answers completion/complete with a valid result.',
    level: 'SHOULD',
    derived: true,
    derivation:
      'server/utilities/completion, Capabilities: the MUST is on declaring the capability, not on the answer to completion/complete, so the answer is a SHOULD.',
    specRefs: [ref(L, 'server/utilities/completion', 'Capabilities')],
    eras: BOTH,
    transports: ANY,
  }),
  // Streamable HTTP on the wire: raw requests, never an MCP client (../raw-http.ts).
  check({
    id: 'http-notification-202',
    title: 'A notification POST is 202 with no body, or an error status',
    description:
      'A POST holding only a notification the server accepts gets 202 Accepted and an empty body; one it does not accept gets an HTTP error status. Another 2xx, or a 202 with a body, fails.',
    level: 'MUST',
    specRefs: [ref(L, LT, 'Sending Messages to the Server'), ref(M, MT, 'Sending Messages')],
    eras: BOTH,
    transports: HTTP,
  }),
  check({
    id: 'http-request-content-type',
    title: 'A request is answered as application/json or text/event-stream',
    description: 'The answer to a JSON-RPC request has Content-Type application/json or text/event-stream.',
    level: 'MUST',
    specRefs: [ref(L, LT, 'Sending Messages to the Server'), ref(M, MT, 'Sending Messages')],
    eras: BOTH,
    transports: HTTP,
  }),
  check({
    id: 'http-response-utf8',
    title: 'The answer is UTF-8 JSON',
    description:
      'The body of the answer to a request is valid UTF-8, and its message (or the data of each SSE event) is JSON.',
    level: 'MUST',
    specRefs: [ref(L, LT, 'Transports')],
    eras: BOTH,
    transports: HTTP,
  }),
  check({
    id: 'http-single-endpoint',
    title: 'The MCP endpoint takes POST',
    description:
      'The URL under test takes a valid JSON-RPC request by POST: not 404 (other than a JSON-RPC -32601) and not 405.',
    level: 'MUST',
    specRefs: [ref(L, LT, 'Streamable HTTP'), ref(M, MT, 'Streamable HTTP')],
    eras: BOTH,
    transports: HTTP,
  }),
  check({
    id: 'http-get-stream-or-405',
    title: 'GET opens an SSE stream or is 405',
    description: 'A GET with Accept: text/event-stream gets Content-Type text/event-stream or 405 Method Not Allowed.',
    level: 'MUST',
    specRefs: [ref(L, LT, 'Listening for Messages from the Server')],
    eras: ['legacy'],
    transports: HTTP,
  }),
  check({
    id: 'http-modern-get-delete-405',
    title: 'A modern-only server answers GET and DELETE with 405',
    description:
      'A server of the 2026-07-28 revision only answers GET and DELETE on its endpoint with 405 Method Not Allowed. A server that also answers initialize (dual-era) is not-applicable.',
    level: 'SHOULD',
    specRefs: [ref(M, MT, 'Earlier Streamable HTTP Revisions')],
    eras: ['modern'],
    transports: HTTP,
  }),
  check({
    id: 'http-session-id-visible-ascii',
    title: 'A session id is visible ASCII',
    description: 'An MCP-Session-Id the server assigns holds only characters 0x21 to 0x7E. Without one, not-applicable.',
    level: 'MUST',
    specRefs: [ref(L, LT, 'Session Management')],
    eras: ['legacy'],
    transports: HTTP,
  }),
  check({
    id: 'http-session-required-400',
    title: 'A request without the session id is 400',
    description:
      'When the server assigned a session id, a request other than initialize without MCP-Session-Id gets 400 Bad Request.',
    level: 'SHOULD',
    specRefs: [ref(L, LT, 'Session Management')],
    eras: ['legacy'],
    transports: HTTP,
  }),
  check({
    id: 'http-protocol-version-header-invalid-400',
    title: 'An invalid MCP-Protocol-Version is 400',
    description: 'A request after initialize with an MCP-Protocol-Version that is not a revision gets 400 Bad Request.',
    level: 'MUST',
    specRefs: [ref(L, LT, 'Protocol Version Header')],
    eras: ['legacy'],
    transports: HTTP,
  }),
  check({
    id: 'http-concurrent-posts-matched',
    title: 'Concurrent POSTs each get their own answer',
    description: 'Several POSTs sent at once, each with its own id, are each answered with the id of their request.',
    level: 'MUST',
    derived: true,
    derivation:
      'basic/transports: every JSON-RPC message MUST be a new HTTP POST request; basic/index, Responses: a response carries the id of its request. Nothing is said of concurrency itself.',
    specRefs: [ref(L, LT, 'Sending Messages to the Server'), ref(M, 'basic/index', 'Responses')],
    eras: BOTH,
    transports: HTTP,
  }),
  check({
    id: 'http-sse-event-ids-unique',
    title: 'SSE event ids are unique in the session',
    description:
      'When the server gives SSE events an id, no id comes back twice across the streams of the session. Without ids, not-applicable.',
    level: 'MUST',
    specRefs: [ref(L, LT, 'Resumability and Redelivery')],
    eras: ['legacy'],
    transports: HTTP,
  }),
  check({
    id: 'http-sse-stream-closes',
    title: 'The SSE stream of a request ends after its response',
    description: 'When a request is answered over SSE, the server closes the stream once the response is sent.',
    level: 'SHOULD',
    specRefs: [ref(L, LT, 'Sending Messages to the Server'), ref(M, MT, 'Receiving Messages')],
    eras: BOTH,
    transports: HTTP,
  }),
  check({
    id: 'http-sse-no-server-requests',
    title: 'The SSE stream of a request holds no request of the server',
    description:
      'The SSE answer to a request holds its response and notifications, never a JSON-RPC request of the server.',
    level: 'MUST',
    specRefs: [ref(M, MT, 'Receiving Messages')],
    eras: ['modern'],
    transports: HTTP,
  }),
  check({
    id: 'http-accel-buffering-header',
    title: 'An SSE answer sends X-Accel-Buffering: no',
    description: 'A response that opens an SSE stream has the header X-Accel-Buffering: no.',
    level: 'SHOULD',
    specRefs: [ref(M, MT, 'Receiving Messages')],
    eras: ['modern'],
    transports: HTTP,
  }),
  check({
    id: 'http-close-cancels',
    title: 'Closing the SSE stream cancels the request',
    description:
      'Closing the SSE answer of a long call is taken as its cancellation: the server sends nothing more for it. It shows only in the effects of a tool, so this run cannot see it yet: could-not-run (needs-input).',
    level: 'MUST',
    specRefs: [ref(M, MT, 'Cancellation')],
    eras: ['modern'],
    transports: HTTP,
    needsFixture: true,
  }),
  // These two change the server's state, each in a session of its own made for it, so they come last.
  check({
    id: 'http-session-terminated-404',
    title: 'A terminated session is 404',
    description:
      'After a DELETE with MCP-Session-Id that the server takes (not 405), a request with that session id gets 404 Not Found. Only a session this run made is deleted.',
    level: 'MUST',
    specRefs: [ref(L, LT, 'Session Management')],
    eras: ['legacy'],
    transports: HTTP,
  }),
  check({
    id: 'http-sse-no-broadcast',
    title: 'A message goes to one SSE stream, not to each',
    description:
      'With two GET streams open, a message of the server (made by the first --fixture call) arrives on one of them only.',
    level: 'MUST',
    specRefs: [ref(L, LT, 'Multiple Connections')],
    eras: ['legacy'],
    transports: HTTP,
    needsFixture: true,
  }),
  // A local server against DNS rebinding: only for localhost, 127.0.0.1, [::1] and *.localhost.
  check({
    id: 'http-origin-invalid-403',
    title: 'A foreign Origin is refused with 403',
    description:
      'A request with Origin: https://evil.example gets 403 Forbidden. It proves nothing when the control with a localhost Origin is refused as well: then could-not-run (prerequisite-failed).',
    level: 'MUST',
    specRefs: [ref(L, LT, 'Security Warning'), ref(M, MT, 'Security & Endpoint')],
    eras: BOTH,
    transports: HTTP,
  }),
  unscored('control', {
    id: 'http-origin-localhost-accepted',
    title: 'An Origin of localhost is accepted',
    description:
      'A request with Origin: http://localhost:<port> is accepted. Not a requirement: without it, a 403 to a foreign Origin shows a server that refuses everything, not a protection.',
    specRefs: [ref(L, LT, 'Security Warning'), ref(M, MT, 'Security & Endpoint')],
    eras: BOTH,
    transports: HTTP,
  }),
  unscored('control', {
    id: 'http-origin-absent-accepted',
    title: 'A request without Origin is accepted',
    description:
      'A request with no Origin (not from a browser) is accepted: the specification speaks only of an Origin that is present and invalid.',
    specRefs: [ref(L, LT, 'Security Warning'), ref(M, MT, 'Security & Endpoint')],
    eras: BOTH,
    transports: HTTP,
  }),
  check({
    id: 'http-bind-loopback',
    title: 'A local server listens on loopback only',
    description:
      'The port of a local server cannot be reached at an outside address of this machine. Without an outside address to try, could-not-run (needs-input).',
    level: 'SHOULD',
    specRefs: [ref(L, LT, 'Security Warning'), ref(M, MT, 'Security & Endpoint')],
    eras: BOTH,
    transports: HTTP,
  }),
  unscored('advice', {
    id: 'http-host-rebinding-advice',
    title: 'A foreign Host is refused (advice outside the specification)',
    description:
      'Not a requirement of the specification, practical advice: a local server that accepts a request with Host: evil.example relies on the Origin check alone against DNS rebinding.',
    specRefs: [ref(L, LT, 'Security Warning'), ref(M, MT, 'Security & Endpoint')],
    eras: BOTH,
    transports: HTTP,
  }),
  // stdio
  check({
    id: 'stdio-stdout-clean',
    title: 'stdout holds only MCP messages',
    description: 'Every line the server writes to stdout is one whole JSON-RPC message, with no newline inside it.',
    level: 'MUST',
    specRefs: [ref(L, 'basic/transports', 'stdio'), ref(M, 'basic/transports/stdio', 'stdio')],
    eras: BOTH,
    transports: ['stdio'],
  }),
  check({
    id: 'stdio-exit-on-eof',
    title: 'The server exits when stdin closes',
    description: 'After its stdin is closed the server process ends within a short time.',
    level: 'SHOULD',
    specRefs: [ref(M, 'basic/transports/stdio', 'Shutdown')],
    eras: BOTH,
    transports: ['stdio'],
  }),
];

const BY_ID = new Map(CATALOG.map((e) => [e.id, e]));

/** The entry of an id, or undefined for an id the catalog does not have. */
export const catalogEntry = (id: string): CatalogEntry | undefined => BY_ID.get(id);
