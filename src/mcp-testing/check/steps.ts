import { ProtocolError } from '@modelcontextprotocol/client';
import { ConnectError, type Session } from '../connect/session.js';
import { asTools, callableTools, callTool, listAll, MAX_PAGES } from '../connect/tools.js';
import type { Step, StepResult } from './run.js';

// What `plune mcp check` asks a server after the handshake, as steps for the loop in run.ts, and the calls of
// `--smoke`. Each step says in one sentence what it saw; the command masks and prints it.

export interface CheckResult extends StepResult {
  /** The entries a list check read to its last page. */
  count?: number;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const METHOD_NOT_FOUND = -32601;

/** A request that did not end in an answer: no answer in time, a server that is gone, or a JSON-RPC error. */
function unanswered(err: unknown, method: string, timedOutDetail: string): CheckResult {
  // Credentials refused after the handshake: the same as before it, the command stops and says to pass them.
  if (err instanceof ConnectError && err.kind === 'auth') throw err;
  if (err instanceof ConnectError) {
    return err.kind === 'timeout'
      ? { state: 'could-not-run', detail: timedOutDetail, timedOut: true }
      : { state: 'failed', detail: `the connection was lost: ${err.message}` };
  }
  if (err instanceof ProtocolError)
    return { state: 'failed', detail: `${method} answered with a JSON-RPC error: ${err.message}` };
  throw err;
}

const LISTS = [
  { id: 'tools-list', method: 'tools/list', key: 'tools', capability: 'tools', noun: 'tool' },
  {
    id: 'resources-list',
    method: 'resources/list',
    key: 'resources',
    capability: 'resources',
    noun: 'resource',
  },
  {
    id: 'resource-templates-list',
    method: 'resources/templates/list',
    key: 'resourceTemplates',
    capability: 'resources',
    noun: 'resource template',
  },
  {
    id: 'prompts-list',
    method: 'prompts/list',
    key: 'prompts',
    capability: 'prompts',
    noun: 'prompt',
  },
] as const;

/**
 * The checks after the handshake, in their order. `protocol-version` and `capabilities` read the handshake only
 * (`offline`). A list whose capability the server did not declare is `not-applicable`; when the capabilities could
 * not be read at all, every list is `could-not-run`: a check that learned nothing must not look like a pass. The tool
 * list, once read, is left in `found.tools` for `--smoke`.
 */
export function healthSteps(
  session: Pick<Session, 'request' | 'handshake'>,
  opts: { timeoutMs: number; timedOutDetail: string },
  found: { tools?: unknown[] },
): Step<CheckResult>[] {
  const { offered, result } = session.handshake;
  let declared: Set<string> | undefined;

  const protocolVersion: Step<CheckResult> = {
    id: 'protocol-version',
    run: async () => {
      const version = isRecord(result) ? result.protocolVersion : undefined;
      if (typeof version !== 'string' || version === '')
        return {
          state: 'failed',
          detail: 'the initialize answer has no protocolVersion',
          offline: true,
        };
      // An older revision than the latest offered is the server's right: information, not a failure.
      const older =
        typeof offered === 'string' &&
        DATE.test(version) &&
        DATE.test(offered) &&
        version < offered;
      const detail = older
        ? `${version}, older than the ${offered} this client offered`
        : version === offered
          ? `${version}, the latest this client offered`
          : version;
      return { state: 'passed', detail, offline: true };
    },
  };

  const capabilities: Step<CheckResult> = {
    id: 'capabilities',
    run: async () => {
      const caps = isRecord(result) ? result.capabilities : undefined;
      if (!isRecord(caps))
        return {
          state: 'failed',
          detail: 'the initialize answer has no capabilities object',
          offline: true,
        };
      declared = new Set(Object.keys(caps));
      const names = Object.keys(caps).join(', ');
      return {
        state: 'passed',
        detail: `declared: ${names === '' ? 'nothing' : names}`,
        offline: true,
      };
    },
  };

  const lists = LISTS.map(
    (list): Step<CheckResult> => ({
      id: list.id,
      run: async (signal) => {
        if (declared === undefined)
          return {
            state: 'could-not-run',
            detail: 'the declared capabilities could not be read',
            offline: true,
          };
        if (!declared.has(list.capability))
          return {
            state: 'not-applicable',
            detail: `the server does not declare ${list.capability}`,
            offline: true,
          };
        try {
          const listing = await listAll(session, list.method, list.key, {
            timeoutMs: opts.timeoutMs,
            signal,
          });
          // Its time is up and its result goes nowhere; above all not into --smoke.
          if (signal.aborted) return { state: 'could-not-run', detail: opts.timedOutDetail };
          if (!listing.complete)
            return {
              state: 'could-not-run',
              detail: `${list.method} did not end within ${MAX_PAGES} pages`,
            };
          if (listing.malformed)
            return {
              state: 'failed',
              detail: `an answer to ${list.method} has no ${list.key} list`,
            };
          if (list.id === 'tools-list') found.tools = listing.items;
          return {
            state: 'passed',
            detail: `${plural(listing.items.length, list.noun, `${list.noun}s`)} in ${plural(listing.pages, 'page', 'pages')}`,
            count: listing.items.length,
          };
        } catch (err) {
          // Declaring resources does not oblige a server to offer templates of them.
          if (
            list.id === 'resource-templates-list' &&
            err instanceof ProtocolError &&
            err.code === METHOD_NOT_FOUND
          )
            return {
              state: 'not-applicable',
              detail:
                'the server declares resources but does not offer resource templates (Method not found)',
            };
          return unanswered(err, list.method, opts.timedOutDetail);
        }
      },
    }),
  );

  const ping: Step<CheckResult> = {
    id: 'ping',
    run: async () => {
      try {
        await session.request('ping', undefined, { timeoutMs: opts.timeoutMs });
        return { state: 'passed', detail: 'answered' };
      } catch (err) {
        return unanswered(err, 'ping', opts.timedOutDetail);
      }
    },
  };

  return [protocolVersion, capabilities, ...lists, ping];
}

/** The text of a tool result's text blocks, for an `isError` answer; short. */
function errorText(result: Record<string, unknown>): string {
  const blocks = Array.isArray(result.content) ? (result.content as unknown[]) : [];
  const text = blocks
    .flatMap((b) =>
      isRecord(b) && b.type === 'text' && typeof b.text === 'string' ? [b.text] : [],
    )
    .join(' ')
    .trim();
  if (text === '') return '(no text)';
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

/**
 * `--smoke`: a step per tool `callableTools` allows, up to `limit`, each called with `{}`; every other tool as
 * `not-applicable` with the reason it is not called. `called` keeps the list order; past the limit is `smoke-limit`.
 */
export function smokeSteps(
  session: Pick<Session, 'request'>,
  items: readonly unknown[],
  opts: { limit: number; timeoutMs: number; timedOutDetail: string; allowWrite: boolean },
): { called: Step[]; notCalled: { tool: string; detail: string }[] } {
  const { tools, unnamed } = asTools(items);
  const { safe, skipped } = callableTools(tools, unnamed, { allowWrite: opts.allowWrite });
  const called = safe.slice(0, opts.limit).map(
    (tool): Step => ({
      id: tool.name,
      run: async () => {
        const answer = await callTool(session, tool.name, opts.timeoutMs);
        switch (answer.kind) {
          case 'result':
            return isRecord(answer.result) && answer.result.isError === true
              ? { state: 'failed', detail: `isError: ${errorText(answer.result)}` }
              : { state: 'passed', detail: 'answered without isError' };
          case 'error':
            return { state: 'failed', detail: `a JSON-RPC error: ${answer.message}` };
          case 'timeout':
            return { state: 'could-not-run', detail: opts.timedOutDetail, timedOut: true };
          case 'lost':
            return { state: 'failed', detail: `the connection was lost: ${answer.message}` };
        }
      },
    }),
  );
  return {
    called,
    notCalled: [
      ...safe.slice(opts.limit).map((t) => ({ tool: t.name, detail: 'smoke-limit' })),
      ...skipped.map((s) => ({ tool: s.tool, detail: s.reason })),
    ],
  };
}
