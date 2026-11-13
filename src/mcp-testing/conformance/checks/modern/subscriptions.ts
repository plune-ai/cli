/**
 * subscriptions/listen (basic/patterns/subscriptions): one subscription per run for one kind of notification the
 * server declares, watched for WATCH_MS and then cancelled (stdio: notifications/cancelled; HTTP: the stream is
 * closed, which is the cancellation there). What came on it is read by three checks.
 */

import type { CheckOutcome } from '../../outcome.js';
import { exchange, rawRequest, type Exchange } from '../../raw-http.js';
import type { ConformanceCheck, ConformanceContext } from '../index.js';
import { message, target } from '../transport.js';
import { capabilities, eraParams, failed, isObject, nextId, notOffered, passed, said, answerOf, walk } from '../wire.js';
import { META } from './meta.js';

/** How long a subscription is watched. */
export const WATCH_MS = 1500;

interface Watched {
  id: string;
  /** The filter asked for: one field. */
  asked: string;
  /** The notification method that field asks for, and the uris for resource updates. */
  expects: { method: string; uris?: string[] };
  /** The notifications that came on the subscription, in order. */
  notes: Record<string, unknown>[];
  /** The response to subscriptions/listen, when one came. */
  response?: Record<string, unknown>;
  /** HTTP: the server closed the stream within the time. */
  ended: boolean;
  details: Exchange[];
}

const subId = (f: Record<string, unknown>): unknown => {
  const params = f['params'];
  const meta = isObject(params) ? params['_meta'] : isObject(f['result']) ? f['result']['_meta'] : undefined;
  return isObject(meta) ? meta[META.subscriptionId] : undefined;
};

/** The one filter field to ask for: the first kind the server declares; the rest stay unasked. */
async function filterOf(ctx: ConformanceContext): Promise<Pick<Watched, 'asked' | 'expects'> & { filter: Record<string, unknown> } | undefined> {
  const caps = capabilities(ctx);
  const flag = (cap: string, key: string) => isObject(caps[cap]) && (caps[cap] as Record<string, unknown>)[key] === true;
  if (flag('tools', 'listChanged'))
    return { asked: 'toolsListChanged', expects: { method: 'notifications/tools/list_changed' }, filter: { toolsListChanged: true } };
  if (flag('prompts', 'listChanged'))
    return { asked: 'promptsListChanged', expects: { method: 'notifications/prompts/list_changed' }, filter: { promptsListChanged: true } };
  if (flag('resources', 'listChanged'))
    return { asked: 'resourcesListChanged', expects: { method: 'notifications/resources/list_changed' }, filter: { resourcesListChanged: true } };
  if (flag('resources', 'subscribe')) {
    const first = (await walk(ctx, 'resources/list', 'resources')).items.find((r) => isObject(r) && typeof r['uri'] === 'string');
    if (isObject(first)) {
      const uris = [String(first['uri'])];
      return { asked: 'resourceSubscriptions', expects: { method: 'notifications/resources/updated', uris }, filter: { resourceSubscriptions: uris } };
    }
  }
  return undefined;
}

/** The subscription of the run, or the outcome when the server declares nothing to subscribe to. */
function watched(ctx: ConformanceContext): Promise<Watched | CheckOutcome> {
  return ctx.memo('subscription', async () => {
    const f = await filterOf(ctx);
    if (f === undefined)
      return {
        state: 'not-applicable',
        reason: 'capability-not-declared',
        actual: 'The server declares nothing to subscribe to (tools, prompts or resources listChanged, resources subscribe).',
      } satisfies CheckOutcome;
    const id = nextId();
    const params = { notifications: f.filter };
    const w: Watched = { id, asked: f.asked, expects: f.expects, notes: [], ended: false, details: [] };
    let frames: Record<string, unknown>[];
    if (ctx.transport === 'http') {
      const t = target(ctx);
      const req = message(ctx, { version: ctx.protocolVersion ?? '2026-07-28' }, 'subscriptions/listen', id, params);
      const res = await rawRequest(t, req, { timeoutMs: WATCH_MS });
      w.details.push(exchange(t, req, res));
      w.ended = res.ended;
      const parse = (text: string) => {
        try {
          return JSON.parse(text) as unknown;
        } catch {
          return undefined;
        }
      };
      const all = res.events.length > 0 ? res.events.map((e) => parse(e.data)) : [parse(res.body)];
      frames = all.filter(isObject);
    } else {
      const before = ctx.session.traffic().length;
      const body = { jsonrpc: '2.0', id, method: 'subscriptions/listen', params: eraParams(ctx, params) };
      await ctx.session.raw(JSON.stringify(body), id, { timeoutMs: WATCH_MS }).catch(() => undefined);
      frames = ctx.session.traffic().slice(before).map((t) => t.frame);
      // Over stdio a subscription ends by notifications/cancelled; nothing answers a notification.
      const cancel = { jsonrpc: '2.0', method: 'notifications/cancelled', params: eraParams(ctx, { requestId: id }) };
      await ctx.session.raw(JSON.stringify(cancel), nextId(), { timeoutMs: 0 }).catch(() => undefined);
    }
    for (const frame of frames) {
      if (frame['id'] === id && ('result' in frame || 'error' in frame)) {
        w.response = frame;
        break;
      }
      // Over stdio nothing else is asked while it is watched: a notification without an id is taken as the subscription's.
      const tag = subId(frame);
      if (typeof frame['method'] === 'string' && frame['id'] === undefined && (tag === id || tag === undefined)) w.notes.push(frame);
    }
    return w;
  });
}

const ACK = 'notifications/subscriptions/acknowledged';

const ackFirst: ConformanceCheck = async (ctx) => {
  const w = await watched(ctx);
  if ('state' in w) return w;
  const [first] = w.notes;
  const details = w.details;
  if (first === undefined) {
    const said_ = w.response === undefined ? 'nothing' : said(answerOf({ frame: w.response, text: '' }));
    return { ...failed(`subscriptions/listen for ${w.asked} got ${said_} within ${WATCH_MS / 1000} s, no acknowledgment.`, `Send ${ACK} as the first message of the subscription.`), details };
  }
  if (first['method'] !== ACK)
    return {
      ...failed(`The first message of the subscription is ${String(first['method'])}, not ${ACK}.`, `Send ${ACK} before any notification of the subscription.`),
      details,
    };
  if (subId(first) !== w.id)
    return {
      ...failed(`The acknowledgment carries subscriptionId ${JSON.stringify(subId(first)) ?? 'none'}, not ${JSON.stringify(w.id)}.`, 'Put the id of the subscriptions/listen request in _meta["io.modelcontextprotocol/subscriptionId"].'),
      details,
    };
  return { ...passed(`subscriptions/listen for ${w.asked}: ${ACK} came first, with the subscription id.`), details };
};

const filterAndTag: ConformanceCheck = async (ctx) => {
  const w = await watched(ctx);
  if ('state' in w) return w;
  const after = w.notes.filter((n) => n['method'] !== ACK);
  if (after.length === 0)
    return {
      state: 'could-not-run',
      reason: 'needs-input',
      actual: `Nothing changed in ${WATCH_MS / 1000} s on the subscription for ${w.asked}: no notification to judge.`,
      details: w.details,
    };
  const wrong: string[] = [];
  for (const n of after) {
    const params = isObject(n['params']) ? n['params'] : {};
    if (n['method'] !== w.expects.method) wrong.push(`${String(n['method'])} was not asked for`);
    else if (w.expects.uris !== undefined && !w.expects.uris.includes(String(params['uri']))) wrong.push(`an update of ${String(params['uri'])} was not asked for`);
    if (subId(n) !== w.id) wrong.push(`${String(n['method'])} carries no subscriptionId ${JSON.stringify(w.id)}`);
  }
  if (wrong.length > 0)
    return {
      ...failed(`Asked for ${w.asked} only: ${wrong.join('; ')}.`, 'Send only the notification types the subscription asked for, each with its subscriptionId in _meta.'),
      details: w.details,
    };
  return { ...passed(`${after.length} notification${after.length === 1 ? '' : 's'} of the kind asked for (${w.expects.method}), each with the subscription id.`), details: w.details };
};

const gracefulClose: ConformanceCheck = async (ctx) => {
  const w = await watched(ctx);
  if ('state' in w) return w;
  if (w.response !== undefined) {
    if (isObject(w.response['result'])) return { ...passed('The server ended the subscription with a result to subscriptions/listen.'), details: w.details };
    return {
      ...failed(`The server ended the subscription with ${said(answerOf({ frame: w.response, text: '' }))}.`, 'End a subscription with a successful subscriptions/listen result.'),
      details: w.details,
    };
  }
  if (w.ended)
    return {
      ...failed('The server closed the subscription stream without answering subscriptions/listen.', 'Answer subscriptions/listen with a result before closing its stream.'),
      details: w.details,
    };
  return { ...notOffered(`The server kept the subscription open for ${WATCH_MS / 1000} s; a cancel of the client asks for no response.`), details: w.details };
};

export const SUBSCRIPTIONS: Record<string, ConformanceCheck> = {
  'mod-sub-ack-first': ackFirst,
  'mod-sub-filter-and-tag': filterAndTag,
  'mod-sub-graceful-close': gracefulClose,
};
