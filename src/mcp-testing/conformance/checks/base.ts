/**
 * The base protocol: JSON-RPC 2.0 as MCP uses it (basic/index, Messages). The answer to invalid JSON, to an unknown
 * method and to plainly wrong parameters, and the id and members of a response, read from the frame as it came.
 */

import { ConnectError } from '../../connect/session.js';
import type { ConformanceCheck } from './index.js';
import { answerOf, call, declares, eraParams, failed, nextId, notDeclared, passed, said } from './wire.js';

/** A method no revision defines: what the server says to it is what it says to any unknown method. */
export const UNKNOWN_METHOD = 'plune-conformance/no-such-method';
/** How long a stdio server is given to answer invalid JSON once the message after it was answered. */
const QUIET_MS = 3000;

const parseError: ConformanceCheck = async (ctx) => {
  // A message cut off in the middle: invalid JSON, one line, its id unreadable.
  const broken = `{"jsonrpc": "2.0", "id": "${nextId()}", "method": "ping", "params": {`;
  const options = ctx.transport === 'stdio' ? { timeoutMs: QUIET_MS } : undefined;
  const parse = ctx.session.raw(broken, null, options).then(
    (reply) => ({ reply }),
    (err: unknown) => ({ err }),
  );
  // The message after it, so silence on stdio can be told from a server that stopped answering.
  const after = await call(ctx, UNKNOWN_METHOD).then(
    () => undefined,
    (err: unknown) => err,
  );
  const got = await parse;
  if ('err' in got) {
    const silent = ctx.transport === 'stdio' && got.err instanceof ConnectError && got.err.kind === 'timeout';
    if (!silent || after !== undefined) throw got.err;
    return failed(
      `Invalid JSON got no answer within ${QUIET_MS / 1000} s, while the message after it was answered.`,
      'Answer a message that is not valid JSON with the error -32700 (Parse error) and id: null.',
    );
  }
  const a = answerOf(got.reply);
  const id = got.reply.frame?.['id'];
  if (a.kind === 'error' && a.code === -32700 && (id === null || id === undefined))
    return passed(`Invalid JSON answered error -32700 with ${id === null ? 'id: null' : 'no id'}.`);
  return failed(
    `Invalid JSON answered ${said(a)}${a.kind === 'error' ? ` with id ${JSON.stringify(id)}` : ''}.`,
    'Answer a message that is not valid JSON with the error -32700 (Parse error) and id: null.',
  );
};

const unknownMethod: ConformanceCheck = async (ctx) => {
  const a = await call(ctx, UNKNOWN_METHOD);
  if (a.kind === 'error' && a.code === -32601) return passed(`${UNKNOWN_METHOD} answered error -32601.`);
  return failed(`${UNKNOWN_METHOD} answered ${said(a)}.`, 'Answer a method the server does not have with the error -32601 (Method not found).');
};

/** What is wrong with a response to the request `id`: its id, or not exactly one of result and error. */
function responseProblems(frame: Record<string, unknown> | undefined, id: string | number): string[] {
  if (frame === undefined) return ['no JSON-RPC response came back'];
  const problems: string[] = [];
  if (frame['id'] === null) problems.push('its id is null');
  else if (frame['id'] !== id) problems.push(`its id is ${JSON.stringify(frame['id'])}, not ${JSON.stringify(id)}`);
  const members = ['result', 'error'].filter((k) => k in frame);
  if (members.length !== 1) problems.push(members.length === 0 ? 'it has neither result nor error' : 'it has both result and error');
  if (frame['jsonrpc'] !== '2.0') problems.push('jsonrpc is not "2.0"');
  return problems;
}

// A string id and an integer id, each on a request that succeeds and on one that fails. On stdio an answer is
// matched by its id, so a wrong id there is a request that is never answered (could-not-run, timeout).
const responseId: ConformanceCheck = async (ctx) => {
  // A method every server of the era has: ping before 2026-07-28, server/discover from then on.
  const ok = ctx.era === 'legacy' ? 'ping' : 'server/discover';
  const probes: [string | number, string][] = [
    [nextId(), ok],
    [900_000_000 + Math.floor(Math.random() * 1_000_000), ok],
    [nextId(), UNKNOWN_METHOD],
  ];
  const problems: string[] = [];
  for (const [id, method] of probes) {
    const params = eraParams(ctx);
    const reply = await ctx.session.raw(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }), id);
    for (const p of responseProblems(reply.frame, id)) problems.push(`${method} with id ${JSON.stringify(id)}: ${p}`);
  }
  if (problems.length > 0)
    return failed(`${problems.join('; ')}.`, 'Answer every request with its own id and exactly one of result and error.');
  return passed(`${probes.length} requests (string and integer ids, a result and an error) each answered with their own id.`);
};

const invalidParams: ConformanceCheck = async (ctx) => {
  if (!declares(ctx, 'tools')) return notDeclared('tools');
  const a = await call(ctx, 'tools/call', { arguments: {} });
  if (a.kind === 'error' && a.code === -32602) return passed('tools/call without name answered error -32602.');
  const isError = a.kind === 'result' && a.result['isError'] === true ? ' with isError' : '';
  return failed(
    `tools/call without name answered ${said(a)}${isError}.`,
    'Answer a request that does not match its schema (tools/call without name) with the error -32602 (Invalid params).',
  );
};

export const BASE: Record<string, ConformanceCheck> = {
  'base-jsonrpc-parse-error': parseError,
  'base-unknown-method-error': unknownMethod,
  'base-response-id-matches': responseId,
  'base-invalid-params-error': invalidParams,
};
