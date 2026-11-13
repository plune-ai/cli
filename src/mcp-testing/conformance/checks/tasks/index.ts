/**
 * The tasks suite: the Tasks extension (tasks-catalog.ts). Only the modern era, and only a server that declares
 * `io.modelcontextprotocol/tasks` in the capabilities of server/discover: any other server is not-applicable.
 *
 * What a run does, and its bounds. Nothing is called that --fixture does not name. A task comes from a --fixture tool
 * called with the extension declared: the first of at most 3 entries that makes one is the task the checks read (A); a
 * second call makes the task the acknowledgement checks cancel (B); one call without the declaration may make a third
 * (U), if the server wrongly hands it out. So a run makes at most 3 tasks and calls a fixture tool at most 5 times. A is
 * polled at most 6 times and for at most 5 seconds, by the interval the server names kept between 20 and 1000 ms. Every
 * task not seen finished is cancelled after the last check, and one that is still not finished, or whose state is not
 * known, is told in the report ("Left behind"). The run never answers an inputRequests entry.
 */

import { headerValue } from '../../../connect/session.js';
import type { CheckOutcome } from '../../outcome.js';
import { quoter } from '../apps/view.js';
import type { ConformanceCheck, ConformanceContext } from '../index.js';
import { META, paramHeaders } from '../modern/meta.js';
import { tools } from '../tools.js';
import {
  call,
  capabilities,
  failed,
  isObject,
  isOutcome,
  notOffered,
  passed,
  prerequisite,
  some,
  walk,
  type Answer,
} from '../wire.js';

export const EXT = 'io.modelcontextprotocol/tasks';
const STATUSES = ['working', 'input_required', 'completed', 'failed', 'cancelled'];
const ENDED = ['completed', 'failed', 'cancelled'];
const LIVE = ['working', 'input_required'];
const MAX_CALLS = 3;
const MAX_POLLS = 6;
const MAX_WAIT_MS = 5000;
const MIN_POLL_MS = 20;
const MAX_POLL_MS = 1000;
const MAX_KEYS = 64;
const MAX_JSON = 65_536;
const UNKNOWN_ID = 'plune-conformance-no-such-task';
// No nested quantifier and a length checked first: a date-time a server chooses cannot make this backtrack.
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/** A task the run made: ended says tasks/get showed it finished. */
interface Made {
  tool: string;
  id: string;
  ended: boolean;
  cancelSent: boolean;
}

interface State {
  made: Made[];
  /** Tools whose call answered a task handle without resultType "task". */
  untyped: string[];
  /** Answers of calls that made no task. */
  standard: Answer[];
  /** The answer to the call that made A, when it has resultType "task" (its id may still be unusable). */
  create?: Record<string, unknown>;
  tool?: { name: string; arguments: Record<string, unknown>; def: Record<string, unknown> };
  a?: Made;
}

const declaredMeta = (): Record<string, unknown> => ({
  _meta: { [META.capabilities]: { extensions: { [EXT]: {} } } },
});

/** What an answer was, in a few words. Unlike said(), never the text of a page that is not JSON-RPC. */
function saw(a: Answer): string {
  if (a.kind === 'result') return 'a result';
  if (a.kind === 'error')
    return `error ${typeof a.code === 'number' ? String(a.code) : 'with no numeric code'}${a.message === '' ? '' : ` (${a.message.slice(0, 120)})`}`;
  return `no JSON-RPC answer${a.status === undefined ? '' : ` (HTTP ${a.status})`}`;
}

const declares = (ctx: ConformanceContext): boolean => {
  const e = capabilities(ctx)['extensions'];
  return isObject(e) && e[EXT] !== undefined && e[EXT] !== null;
};

const gate = (ctx: ConformanceContext): CheckOutcome | undefined =>
  declares(ctx)
    ? undefined
    : {
        state: 'not-applicable',
        reason: 'capability-not-declared',
        actual: `The server does not declare ${EXT} in the capabilities of server/discover.`,
      };

/** An answer that says nothing about the server: no JSON-RPC answer, or a status of the transport (429, 5xx, 3xx). */
function unjudgeable(a: Answer): CheckOutcome | undefined {
  const s = a.status;
  if (a.kind === 'other' || (s !== undefined && (s === 429 || s >= 500 || (s >= 300 && s < 400))))
    return {
      state: 'could-not-run',
      reason: 'transport-error',
      actual: `The server answered ${saw(a)}.`,
    };
  return undefined;
}

/** One request of the extension. `taskId`: over HTTP, Mcp-Name is set to it. */
function ask(
  ctx: ConformanceContext,
  method: string,
  params: Record<string, unknown>,
  declare: boolean,
): Promise<Answer> {
  const id = params['taskId'];
  return call(
    ctx,
    method,
    declare ? { ...params, ...declaredMeta() } : params,
    ctx.transport === 'http' && typeof id === 'string'
      ? { headers: [['Mcp-Name', headerValue(id)]] }
      : undefined,
  );
}

/** A --fixture tool called, with or without the extension declared. */
function invoke(ctx: ConformanceContext, s: State, declare: boolean): Promise<Answer> {
  const t = s.tool!;
  const params = { name: t.name, arguments: t.arguments };
  return call(
    ctx,
    'tools/call',
    declare ? { ...params, ...declaredMeta() } : params,
    // A modern client over HTTP mirrors the x-mcp-header parameters into Mcp-Param headers.
    ctx.transport === 'http' ? { headers: paramHeaders(t.def, t.arguments) } : undefined,
  );
}

type Kind = 'task' | 'untyped' | 'standard';
function classify(a: Answer): Kind {
  if (a.kind !== 'result') return 'standard';
  if (a.result['resultType'] === 'task') return 'task';
  const r = a.result;
  return typeof r['taskId'] === 'string' &&
    r['taskId'] !== '' &&
    STATUSES.includes(r['status'] as string)
    ? 'untyped'
    : 'standard';
}

/** Records a task handle the run got; the Made it can be used as, when its id is a usable string. */
function record(s: State, tool: string, a: Answer): Made | undefined {
  if (a.kind !== 'result') return undefined;
  const id = a.result['taskId'];
  if (typeof id !== 'string' || id === '') return undefined;
  const m: Made = { tool, id, ended: false, cancelSent: false };
  s.made.push(m);
  return m;
}

const state = (ctx: ConformanceContext): Promise<State> =>
  ctx.memo('tasks state', async () => {
    const s: State = { made: [], untyped: [], standard: [] };
    ctx.onEnd(() => end(ctx, s));
    return s;
  });

/** Ends what the run made: a task not seen finished is cancelled, and one that still runs is told. */
async function end(ctx: ConformanceContext, s: State): Promise<string | undefined> {
  const q = quoter(ctx);
  const left: string[] = [];
  for (const m of s.made) {
    if (m.ended) continue;
    const who = `${q(m.id)} (made by ${q(m.tool)})`;
    if (!m.cancelSent) {
      m.cancelSent = true;
      const c = await ask(ctx, 'tasks/cancel', { taskId: m.id }, true);
      if (c.kind !== 'result') {
        left.push(`${who}: tasks/cancel answered ${saw(c)}, so whether it still runs is unknown`);
        continue;
      }
    }
    const g = await ask(ctx, 'tasks/get', { taskId: m.id }, true);
    const status = g.kind === 'result' ? g.result['status'] : undefined;
    if (typeof status === 'string' && ENDED.includes(status)) continue;
    left.push(
      `${who} was left running: tasks/cancel was acknowledged, and tasks/get then ${g.kind === 'result' ? `showed ${q(status)}` : `answered ${saw(g)}`}`,
    );
  }
  return left.length === 0
    ? undefined
    : `${left.length} task${left.length === 1 ? '' : 's'} created by this run and not seen finished: ${left.join('; ')}.`;
}

const needsInput = (actual: string): CheckOutcome => ({
  state: 'could-not-run',
  reason: 'needs-input',
  actual,
});

/** The tasks of the run, made once: A. The outcome when the checks cannot run at all. */
function created(ctx: ConformanceContext): Promise<CheckOutcome | State> {
  return ctx.memo('tasks created', async () => {
    const s = await state(ctx);
    if (ctx.fixture === undefined)
      return needsInput(
        'No --fixture: no tool is called without one. Name a tool that makes a task, with safe arguments, in a fixture file to run this check.',
      );
    const list = await tools(ctx);
    if (isOutcome(list))
      return list.state === 'not-applicable'
        ? prerequisite('The server declares no tools capability, so no tool can make a task.')
        : list;
    let calls = 0;
    for (const c of ctx.fixture) {
      if (calls >= MAX_CALLS || s.a !== undefined) break;
      const def = list.find(
        (t): t is Record<string, unknown> => isObject(t) && t['name'] === c.tool,
      );
      if (def === undefined) continue;
      calls++;
      s.tool = { name: c.tool, arguments: c.arguments, def };
      const a = await invoke(ctx, s, true);
      const kind = classify(a);
      if (kind === 'task' && a.kind === 'result') {
        s.create = a.result;
        s.a = record(s, c.tool, a);
      } else if (kind === 'untyped') s.untyped.push(c.tool);
      else s.standard.push(a);
    }
    if (s.tool === undefined)
      return needsInput(
        'No --fixture call names a tool the server lists, and no other tool is called by this suite.',
      );
    return s;
  });
}

async function ready(ctx: ConformanceContext): Promise<CheckOutcome | State> {
  const g = gate(ctx);
  if (g !== undefined) return g;
  return created(ctx);
}

/** The state with a task A to read, or the outcome of a check that needs one. */
async function withTask(ctx: ConformanceContext): Promise<CheckOutcome | (State & { a: Made })> {
  const s = await ready(ctx);
  if ('state' in s) return s;
  if (s.a !== undefined) return s as State & { a: Made };
  const q = quoter(ctx);
  if (s.untyped.length > 0)
    return prerequisite(
      `${some(
        s.untyped.map((t) => q(t)),
        3,
      )} answered a task handle without resultType "task" (tasks-result-type judges it), so there is no task to read.`,
    );
  if (s.create !== undefined)
    return prerequisite(
      'The task handle has no usable taskId (tasks-result-type judges it), so there is no task to read.',
    );
  return needsInput(
    `No --fixture call made a task although the extension was declared (${s.standard.length} call${s.standard.length === 1 ? '' : 's'} answered an ordinary result or an error): name a tool that makes one.`,
  );
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The tasks/get answers of A, in order: at most MAX_POLLS, within MAX_WAIT_MS, until the task has ended. */
function observed(ctx: ConformanceContext, s: State & { a: Made }): Promise<Answer[]> {
  return ctx.memo('tasks observed', async () => {
    const out: Answer[] = [];
    const start = Date.now();
    for (let i = 0; i < MAX_POLLS; i++) {
      const a = await ask(ctx, 'tasks/get', { taskId: s.a.id }, true);
      out.push(a);
      if (a.kind !== 'result') break;
      const status = a.result['status'];
      if (typeof status === 'string' && ENDED.includes(status)) {
        s.a.ended = true;
        break;
      }
      const left = MAX_WAIT_MS - (Date.now() - start);
      if (left <= 0 || i === MAX_POLLS - 1) break;
      const hint = a.result['pollIntervalMs'];
      const asked = typeof hint === 'number' && Number.isSafeInteger(hint) ? hint : 100;
      await sleep(Math.min(left, Math.max(MIN_POLL_MS, Math.min(MAX_POLL_MS, asked))));
    }
    return out;
  });
}

const results = (answers: Answer[]): Record<string, unknown>[] =>
  answers.flatMap((a) => (a.kind === 'result' ? [a.result] : []));

/** A, and what tasks/get answered for it; the first answer is the control of every check that refuses something. */
async function polled(
  ctx: ConformanceContext,
): Promise<CheckOutcome | { s: State & { a: Made }; polls: Answer[] }> {
  const s = await withTask(ctx);
  if ('state' in s) return s;
  return { s, polls: await observed(ctx, s) };
}

/** The control of a check that expects a refusal: tasks/get for the task the run made was accepted. */
function control(polls: Answer[]): CheckOutcome | undefined {
  const first = polls[0];
  if (first === undefined)
    return prerequisite('tasks/get for the task the run made was not asked.');
  return first.kind === 'result'
    ? undefined
    : (unjudgeable(first) ??
        prerequisite(
          `The control, tasks/get for the task the run made, answered ${saw(first)}: tasks-get-status-shape judges it.`,
        ));
}

const resultType: ConformanceCheck = async (ctx) => {
  const s = await ready(ctx);
  if ('state' in s) return s;
  const q = quoter(ctx);
  const bad: string[] = [];
  for (const t of s.untyped)
    bad.push(`${q(t)} answered a task handle (taskId, status) without resultType "task"`);
  if (s.create !== undefined) {
    const id = s.create['taskId'];
    if (typeof id !== 'string' || id === '') bad.push('the task handle has no string taskId');
    if (!STATUSES.includes(s.create['status'] as string))
      bad.push(`the task handle has status ${q(s.create['status'])}`);
  }
  const others: [string, unknown][] = [
    [
      'a call that made no task',
      s.standard.flatMap((a) => (a.kind === 'result' ? [a.result] : [])),
    ],
  ];
  const listed = await walk(ctx, 'tools/list', 'tools');
  others.push(['tools/list', listed.results]);
  if (ctx.discover?.kind === 'result') others.push(['server/discover', [ctx.discover.result]]);
  const task = s.a === undefined ? undefined : await observed(ctx, s as State & { a: Made });
  if (task !== undefined) others.push(['tasks/get', results(task)]);
  for (const [what, list] of others)
    if (Array.isArray(list) && list.some((r) => isObject(r) && r['resultType'] === 'task'))
      bad.push(`${what} answered a result with resultType "task"`);
  if (bad.length > 0)
    return failed(
      `${some(bad, 4)}.`,
      'Set resultType to "task" on the result that makes a task (taskId, status, createdAt, lastUpdatedAt, ttlMs), and on no other result.',
    );
  if (s.create === undefined)
    return needsInput(
      'No --fixture call made a task although the extension was declared: name a tool that makes one.',
    );
  return passed(
    'The task handle has resultType "task", a taskId and a status, and no other result the run got has resultType "task".',
  );
};

/** The task a call made for a client that declared nothing, memoised: one call. */
function undeclaredCall(ctx: ConformanceContext, s: State): Promise<{ a: Answer; kind: Kind }> {
  return ctx.memo('tasks undeclared call', async () => {
    const a = await invoke(ctx, s, false);
    const kind = classify(a);
    if (kind !== 'standard') record(s, s.tool!.name, a);
    return { a, kind };
  });
}

const undeclaredNoTask: ConformanceCheck = async (ctx) => {
  const s = await withTask(ctx);
  if ('state' in s) return s;
  const q = quoter(ctx);
  const u = await undeclaredCall(ctx, s);
  const no = unjudgeable(u.a);
  if (no !== undefined) return no;
  if (u.kind !== 'standard')
    return failed(
      `${q(s.tool!.name)} made a task for a client that did not declare the extension (resultType ${q(u.a.kind === 'result' ? u.a.result['resultType'] : undefined)}).`,
      'Return a task only to a client whose request declares io.modelcontextprotocol/tasks; answer another one with an ordinary result or the error -32021.',
    );
  return passed(
    `${q(s.tool!.name)} made a task with the extension declared, and answered ${saw(u.a)} without it.`,
  );
};

const undeclaredError: ConformanceCheck = async (ctx) => {
  const p = await polled(ctx);
  if ('state' in p) return p;
  const c = control(p.polls);
  if (c !== undefined) return c;
  const bad: string[] = [];
  for (const [method, params] of [
    ['tasks/get', { taskId: p.s.a.id }],
    ['tasks/update', { taskId: p.s.a.id, inputResponses: {} }],
    ['tasks/cancel', { taskId: p.s.a.id }],
  ] as const) {
    const a = await ask(ctx, method, params, false);
    const no = unjudgeable(a);
    if (no !== undefined) return no;
    if (a.kind === 'result') {
      bad.push(`${method} was served`);
      continue;
    }
    if (a.kind !== 'error') continue;
    if (a.code !== -32021) {
      bad.push(`${method} answered ${saw(a)}`);
      continue;
    }
    const data = isObject(a.frame['error']) ? a.frame['error']['data'] : undefined;
    const need =
      isObject(data) && isObject(data['requiredCapabilities'])
        ? data['requiredCapabilities']['extensions']
        : undefined;
    if (!isObject(need) || need[EXT] === undefined)
      bad.push(
        `${method} answered -32021 without data.requiredCapabilities.extensions naming the extension`,
      );
  }
  if (bad.length > 0)
    return failed(
      `Without the extension declared: ${some(bad, 3)}.`,
      `Answer tasks/get, tasks/update and tasks/cancel from a client that did not declare ${EXT} with -32021 and data.requiredCapabilities.extensions.`,
    );
  return passed(
    'tasks/get, tasks/update and tasks/cancel without the declaration each answered -32021 naming the extension.',
  );
};

/** What is wrong with a tasks/get answer, by the interface Task. */
function shapeProblems(ctx: ConformanceContext, r: Record<string, unknown>, id: string): string[] {
  const q = quoter(ctx);
  const out: string[] = [];
  if (r['resultType'] !== 'complete')
    out.push(
      `resultType is ${r['resultType'] === undefined ? 'missing' : q(r['resultType'])}, not "complete"`,
    );
  if (r['taskId'] !== id) out.push('taskId is not the one asked for');
  if (typeof r['status'] !== 'string' || !STATUSES.includes(r['status']))
    out.push(`status is ${r['status'] === undefined ? 'missing' : q(r['status'])}`);
  for (const k of ['createdAt', 'lastUpdatedAt']) {
    const v = r[k];
    if (typeof v !== 'string' || v.length > 64 || !DATE_TIME.test(v))
      out.push(`${k} is not an ISO 8601 date-time`);
  }
  if (!('ttlMs' in r)) out.push('ttlMs is missing');
  return out;
}

const statusShape: ConformanceCheck = async (ctx) => {
  const p = await polled(ctx);
  if ('state' in p) return p;
  const bad: string[] = [];
  let judged = 0;
  for (const [i, a] of p.polls.entries()) {
    if (a.kind !== 'result') {
      const no = unjudgeable(a);
      if (no !== undefined) return no;
      bad.push(`poll ${i + 1}: tasks/get for the task the server made answered ${saw(a)}`);
      continue;
    }
    judged++;
    bad.push(...shapeProblems(ctx, a.result, p.s.a.id).map((m) => `poll ${i + 1}: ${m}`));
  }
  if (bad.length > 0)
    return failed(
      `${some(bad, 4)}.`,
      'Answer tasks/get with resultType "complete", the taskId, a status of the specification, createdAt and lastUpdatedAt as ISO 8601 date-times, and ttlMs.',
    );
  return passed(
    `${judged} tasks/get answer${judged === 1 ? '' : 's'}, each with resultType "complete" and the fields of a task.`,
  );
};

const statusPayload: ConformanceCheck = async (ctx) => {
  const p = await polled(ctx);
  if ('state' in p) return p;
  const q = quoter(ctx);
  const need: Record<string, string> = {
    completed: 'result',
    failed: 'error',
    input_required: 'inputRequests',
  };
  const bad: string[] = [];
  const seen: string[] = [];
  for (const r of results(p.polls)) {
    const status = r['status'];
    if (typeof status !== 'string' || !Object.hasOwn(need, status)) continue;
    const field = need[status]!;
    if (!seen.includes(status)) seen.push(status);
    if (!isObject(r[field])) bad.push(`a ${q(status)} task has no ${field} object`);
  }
  if (bad.length > 0)
    return failed(
      `${some(bad, 3)}.`,
      'Give a completed task a result, a failed task an error and an input_required task inputRequests.',
    );
  if (seen.length === 0)
    return notOffered(
      'No task the run polled reached completed, failed or input_required within the bounds of the run.',
    );
  return passed(`Seen: ${some(seen)}; each with the field the specification asks for.`);
};

const ttlPoll: ConformanceCheck = async (ctx) => {
  const s = await withTask(ctx);
  if ('state' in s) return s;
  const polls = await observed(ctx, s);
  const bad: string[] = [];
  const all: [string, Record<string, unknown>][] = [
    ...(s.create === undefined
      ? []
      : [['the task handle', s.create] as [string, Record<string, unknown>]]),
    ...results(polls).map((r, i) => [`poll ${i + 1}`, r] as [string, Record<string, unknown>]),
  ];
  for (const [where, r] of all) {
    const ttl = r['ttlMs'];
    if (ttl !== null && !(typeof ttl === 'number' && Number.isSafeInteger(ttl)))
      bad.push(`${where}: ttlMs is ${ttl === undefined ? 'missing' : 'not an integer or null'}`);
    const poll = r['pollIntervalMs'];
    if (poll !== undefined && !(typeof poll === 'number' && Number.isSafeInteger(poll)))
      bad.push(`${where}: pollIntervalMs is not an integer`);
  }
  if (bad.length > 0)
    return failed(
      `${some(bad, 3)}.`,
      'Give ttlMs as an integer number of milliseconds or null, and pollIntervalMs as an integer.',
    );
  return passed(
    `${all.length} task object${all.length === 1 ? '' : 's'}: ttlMs an integer or null, pollIntervalMs an integer where given.`,
  );
};

const unknownGet: ConformanceCheck = async (ctx) => {
  const p = await polled(ctx);
  if ('state' in p) return p;
  const c = control(p.polls);
  if (c !== undefined) return c;
  const a = await ask(ctx, 'tasks/get', { taskId: UNKNOWN_ID }, true);
  const no = unjudgeable(a);
  if (no !== undefined) return no;
  if (a.kind === 'error' && a.code === -32602)
    return passed('tasks/get for an unknown taskId answered -32602.');
  return failed(
    `tasks/get for a taskId the server never made answered ${saw(a)}.`,
    'Answer tasks/get for an invalid or nonexistent taskId with the error -32602 (Invalid params).',
  );
};

/** The second task (B), and tasks/update and tasks/cancel for it, asked once per run. */
function acks(
  ctx: ConformanceContext,
  s: State & { a: Made },
): Promise<{ update: Answer; cancel: Answer; after?: Answer } | undefined> {
  return ctx.memo('tasks acks', async () => {
    const made = await invoke(ctx, s, true);
    if (classify(made) !== 'task') return undefined;
    const b = record(s, s.tool!.name, made);
    if (b === undefined) return undefined;
    const update = await ask(ctx, 'tasks/update', { taskId: b.id, inputResponses: {} }, true);
    const cancel = await ask(ctx, 'tasks/cancel', { taskId: b.id }, true);
    b.cancelSent = true;
    // An error for a cancel says something only about a task that was still running when it was asked.
    const after =
      cancel.kind === 'error' ? await ask(ctx, 'tasks/get', { taskId: b.id }, true) : undefined;
    return { update, cancel, ...(after === undefined ? {} : { after }) };
  });
}

/** What is wrong with the acknowledgement of tasks/update or tasks/cancel: it is an empty result of resultType "complete". */
function ackProblem(ctx: ConformanceContext, r: Record<string, unknown>): string | undefined {
  const q = quoter(ctx);
  if (r['resultType'] !== 'complete')
    return `resultType is ${r['resultType'] === undefined ? 'missing' : q(r['resultType'])}, not "complete"`;
  const extra = Object.keys(r).filter((k) => k !== 'resultType' && k !== '_meta');
  return extra.length === 0
    ? undefined
    : `the result is not empty (${some(
        extra.slice(0, 5).map((k) => q(k)),
        5,
      )})`;
}

const NO_SECOND =
  'The --fixture tool made no second task, which the acknowledgement checks need (the first one was polled).';

const cancelAck: ConformanceCheck = async (ctx) => {
  const s = await withTask(ctx);
  if ('state' in s) return s;
  const r = await acks(ctx, s);
  if (r === undefined) return needsInput(NO_SECOND);
  const no = unjudgeable(r.cancel);
  if (no !== undefined) return no;
  if (r.cancel.kind === 'result') {
    const p = ackProblem(ctx, r.cancel.result);
    return p === undefined
      ? passed('tasks/cancel answered an empty result with resultType "complete".')
      : failed(
          `tasks/cancel: ${p}.`,
          'Acknowledge tasks/cancel with an empty result that has resultType "complete".',
        );
  }
  const status = r.after?.kind === 'result' ? r.after.result['status'] : undefined;
  if (typeof status === 'string' && LIVE.includes(status))
    return failed(
      `tasks/cancel for a task that was still ${status} answered ${saw(r.cancel)}.`,
      "Acknowledge tasks/cancel with an empty result; whether the work stops is the server's decision.",
    );
  return prerequisite(
    `tasks/cancel answered ${saw(r.cancel)}, and the task was not seen running afterwards, so it may have ended before: not judged.`,
  );
};

const updateAck: ConformanceCheck = async (ctx) => {
  const s = await withTask(ctx);
  if ('state' in s) return s;
  const r = await acks(ctx, s);
  if (r === undefined) return needsInput(NO_SECOND);
  const no = unjudgeable(r.update);
  if (no !== undefined) return no;
  if (r.update.kind === 'result') {
    const p = ackProblem(ctx, r.update.result);
    return p === undefined
      ? passed('tasks/update answered an empty result with resultType "complete".')
      : failed(
          `tasks/update: ${p}.`,
          'Acknowledge tasks/update with an empty result that has resultType "complete".',
        );
  }
  return prerequisite(
    `tasks/update with no outstanding key answered ${saw(r.update)}: the acknowledgement was not seen, so it is not judged.`,
  );
};

const unknownUpdateCancel: ConformanceCheck = async (ctx) => {
  const s = await withTask(ctx);
  if ('state' in s) return s;
  const r = await acks(ctx, s);
  if (r === undefined) return needsInput(NO_SECOND);
  if (r.update.kind !== 'result' || r.cancel.kind !== 'result')
    return prerequisite(
      'The controls, tasks/update and tasks/cancel for a task the run made, were not accepted: tasks-update-ack and tasks-cancel-ack judge them.',
    );
  const bad: string[] = [];
  for (const [method, params] of [
    ['tasks/update', { taskId: UNKNOWN_ID, inputResponses: {} }],
    ['tasks/cancel', { taskId: UNKNOWN_ID }],
  ] as const) {
    const a = await ask(ctx, method, params, true);
    const no = unjudgeable(a);
    if (no !== undefined) return no;
    if (!(a.kind === 'error' && a.code === -32602)) bad.push(`${method} answered ${saw(a)}`);
  }
  if (bad.length > 0)
    return failed(
      `For a taskId the server never made: ${some(bad)}.`,
      'Answer tasks/update and tasks/cancel for an invalid or nonexistent taskId with -32602.',
    );
  return passed('tasks/update and tasks/cancel for an unknown taskId answered -32602.');
};

const failedMessage: ConformanceCheck = async (ctx) => {
  const p = await polled(ctx);
  if ('state' in p) return p;
  const fails = results(p.polls).filter((r) => r['status'] === 'failed');
  if (fails.length === 0) return notOffered('No task the run polled reached failed.');
  const without = fails.filter(
    (r) => typeof r['statusMessage'] !== 'string' || r['statusMessage'].trim() === '',
  );
  if (without.length > 0)
    return failed(
      `${without.length} of ${fails.length} failed task answer${fails.length === 1 ? '' : 's'} had no statusMessage.`,
      'Give a failed task a statusMessage with diagnostic information.',
    );
  return passed(
    `${fails.length} failed task answer${fails.length === 1 ? '' : 's'}, each with a statusMessage.`,
  );
};

const nameHeader: ConformanceCheck = async (ctx) => {
  const p = await polled(ctx);
  if ('state' in p) return p;
  const a = await ask(ctx, 'tasks/get', { taskId: p.s.a.id }, true);
  const no = unjudgeable(a);
  if (no !== undefined) return no;
  if (a.kind === 'result')
    return passed('tasks/get with Mcp-Name set to the taskId was answered with a result.');
  if (a.kind === 'error' && (a.code === -32020 || a.status === 400))
    return failed(
      `tasks/get with Mcp-Name set to the taskId was refused: ${saw(a)}.`,
      'Accept tasks/get, tasks/update and tasks/cancel whose Mcp-Name is the value of params.taskId.',
    );
  return prerequisite(
    `tasks/get with Mcp-Name answered ${saw(a)}, which is not a refusal of the header.`,
  );
};

const inputKeys: ConformanceCheck = async (ctx) => {
  const p = await polled(ctx);
  if ('state' in p) return p;
  const q = quoter(ctx);
  const seen = new Map<string, string>();
  const bad: string[] = [];
  let snapshots = 0;
  for (const r of results(p.polls)) {
    const requests = r['inputRequests'];
    if (!isObject(requests)) continue;
    snapshots++;
    for (const [key, value] of Object.entries(requests).slice(0, MAX_KEYS)) {
      const text = JSON.stringify(value) ?? '';
      if (text.length > MAX_JSON) continue;
      const before = seen.get(key);
      if (before !== undefined && before !== text) bad.push(q(key));
      seen.set(key, text);
    }
  }
  if (bad.length > 0)
    return failed(
      `The key ${some(bad, 3)} of inputRequests named a different request at a later poll.`,
      'Never use the same inputRequests key for two different requests over the life of a task.',
    );
  if (snapshots < 2)
    return notOffered(
      `inputRequests was seen in ${snapshots} poll${snapshots === 1 ? '' : 's'}: a key needs two to be compared.`,
    );
  return passed(
    `${snapshots} polls with inputRequests: each key named the same request every time.`,
  );
};

export const TASKS: Record<string, ConformanceCheck> = {
  'tasks-result-type': resultType,
  'tasks-undeclared-no-task': undeclaredNoTask,
  'tasks-undeclared-capability-error': undeclaredError,
  'tasks-get-status-shape': statusShape,
  'tasks-status-payload': statusPayload,
  'tasks-ttl-poll-integers': ttlPoll,
  'tasks-unknown-id-get': unknownGet,
  'tasks-unknown-id-update-cancel': unknownUpdateCancel,
  'tasks-cancel-ack': cancelAck,
  'tasks-update-ack': updateAck,
  'tasks-failed-status-message': failedMessage,
  'tasks-http-name-header': nameHeader,
  'tasks-input-request-keys-unique': inputKeys,
};
