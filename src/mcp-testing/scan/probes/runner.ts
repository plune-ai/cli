import { randomBytes } from 'node:crypto';
import type { ConnectTarget } from '../../connect/options.js';
import { createRedactor, describeTarget, maskUrl, redactorFor } from '../../connect/redact.js';
import {
  DEFAULT_MAX_CALLS,
  DEFAULT_MAX_REQUESTS,
  ProbeGuard,
  canonical,
  type Credential,
  type Frame,
  type Refusal,
  type Reply,
} from './guard.js';
import { httpTransport } from './http.js';
import { markerVerdict, pageReachable, startPage, type Page } from './page.js';
import { stdioTransport } from './stdio.js';
import { openSession, type Session } from '../../connect/session.js';
import type { ProbeJournal } from './journal.js';
import { LEAK_PATTERNS, errorTextOf, findLeak } from './leak.js';
import { isThisMachine } from './local.js';
import type { ProbeEntry, ProbeReason, ProbeRow } from './types.js';

/**
 * Runs the declared probes against one server that the person says is theirs, and reports a row for every probe: what
 * the server did, or why the probe did not run. A verdict of "violated" comes only from a server's own answer to a call
 * the person declared. Timeout, 429, 5xx, a redirect or any other status that does not decide it is "not run", with
 * its reason. A finding is built from fixed fields (probe id, rule, tool, category): never an error message, a response
 * body or an argument value.
 */

/** The rule of a malformed probe (`malformed: true`): not a rule of an `as`, so it is not in the map below. */
export const LEAK_RULE = 'scan/probe/error-detail-leak';
export const FETCH_RULE = 'scan/probe/untrusted-content-verbatim';

export const PROBE_RULE_OF = {
  none: 'scan/probe/unauthenticated-call',
  garbage: 'scan/probe/garbage-token-accepted',
  'account-b': 'scan/probe/cross-account-access',
} as const;

export interface ProbeFinding {
  rule: (typeof PROBE_RULE_OF)[keyof typeof PROBE_RULE_OF] | typeof LEAK_RULE | typeof FETCH_RULE;
  id: string;
  tool: string;
  severity: 'error' | 'info' | 'advice';
  message: string;
}

export interface ProbeSection {
  rows: ProbeRow[];
  findings: ProbeFinding[];
  calls: number;
  requests: number;
  /** Whether the public metadata of the target's origin answered (asked without a token); null when not asked. */
  metadata: 'found' | 'not-found' | 'unreachable' | null;
  /** A line of the journal could not be written: the journal is incomplete. */
  journalFailed?: boolean;
}

export interface ProbeRunOptions {
  /** The parsed probe file; undefined when none was given. */
  entries: ProbeEntry[] | undefined;
  target: ConnectTarget | undefined;
  tokens: { accountA?: string; accountB?: string };
  confirmHost?: string;
  maxCalls?: number;
  maxRequests?: number;
  timeoutMs: number;
  /** `--yes`: the command of a stdio server may be started by a probe. */
  yes?: boolean;
  clientVersion?: string;
  /** Where the frames and answers are written (`--journal`), opened before anything is sent. */
  journal?: ProbeJournal;
  /** The line "probes will go to ..." goes here, before the first frame. */
  announce: (line: string) => void;
}

const REVISION = '2025-06-18';
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

const REASON_OF: Record<Refusal, ProbeReason> = {
  budget: 'budget',
  'transport-stopped': 'transport-stopped',
  destructive: 'destructive',
  'journal-failed': 'journal-failed',
  undeclared: 'inconclusive',
  'tools-unknown': 'inconclusive',
};

type Decision =
  /** HTTP 401 or 403: the only answer that is a refusal by itself. */
  | { kind: 'refused' }
  /** A JSON-RPC error: the server did not run it, but nothing says why. */
  | { kind: 'rpc-error'; message: unknown }
  | { kind: 'ok'; message: unknown; sessionId?: string }
  | { kind: 'inconclusive' };

/** What a reply decides. Only an answer of the server decides; anything else is "not run". */
function decide(reply: Reply, expectMessage: boolean): Decision {
  if (reply.kind === 'failure') return { kind: 'inconclusive' };
  const s = reply.status;
  if (s === 401 || s === 403) return { kind: 'refused' };
  if (s < 200 || s >= 300) return { kind: 'inconclusive' };
  if (!expectMessage) return { kind: 'ok', message: undefined };
  const message = reply.message as { error?: unknown; result?: unknown } | undefined;
  if (message === undefined) return { kind: 'inconclusive' };
  // The code and the text of an error are not read: whether it is about authorization is not guessed.
  if (message.error !== undefined) return { kind: 'rpc-error', message };
  // "Ran" is a result that is an object. An answer with neither a result nor an error, or a result that is not an
  // object, is not a run and not a refusal: it decides nothing.
  if (
    !('result' in message) ||
    typeof message.result !== 'object' ||
    message.result === null ||
    Array.isArray(message.result)
  )
    return { kind: 'inconclusive' };
  return {
    kind: 'ok',
    message: message.result,
    ...(reply.sessionId === undefined ? {} : { sessionId: reply.sessionId }),
  };
}

/** What one probe came to, before the expectation and the control are applied. */
type Attempt =
  | { kind: 'allowed'; result?: unknown }
  | { kind: 'http-refused'; step: string }
  /**
   * A JSON-RPC error or `isError` on the declared call itself: a refusal only if a control proves the call can run.
   * `text` is the text of the error, for the leak patterns; it is never stored or printed.
   */
  | { kind: 'errored'; text: string }
  | { kind: 'not-run'; reason: ProbeReason };

const notRun = (e: ProbeEntry, reason: ProbeReason): ProbeRow => ({
  id: e.id,
  tool: e.tool,
  as: e.as,
  expect: e.expect ?? 'none',
  answer: null,
  outcome: 'not-run',
  reason,
});

export async function runProbes(opts: ProbeRunOptions): Promise<ProbeSection> {
  // What a run starts (a stdio child, the page of the scan) is stopped on every way out, a thrown error included.
  const cleanups: (() => Promise<void>)[] = [];
  try {
    return await runProbesWith(opts, cleanups);
  } finally {
    await Promise.allSettled(cleanups.map((stop) => stop()));
    opts.journal?.close?.();
  }
}

async function runProbesWith(
  opts: ProbeRunOptions,
  cleanups: (() => Promise<void>)[],
): Promise<ProbeSection> {
  const section: ProbeSection = { rows: [], findings: [], calls: 0, requests: 0, metadata: null };
  const all = (reason: ProbeReason) => {
    section.rows =
      opts.entries === undefined
        ? [
            {
              id: '',
              tool: '',
              as: '',
              expect: 'none',
              answer: null,
              outcome: 'not-run',
              reason: 'no-probe-file',
            },
          ]
        : opts.entries.map((e) => notRun(e, reason));
    return section;
  };
  if (opts.entries === undefined) return all('no-probe-file');
  const { target } = opts;
  if (target === undefined) return all('no-target');
  const stdio = target.kind === 'stdio';
  if (target.kind === 'stdio') {
    // The command is shown in full, so the person sees what a probe would start. It is started only with --yes.
    // The arguments go through the masking the connection layer already applies to a command line.
    const shown = describeTarget(target, redactorFor(target)) as {
      command: string;
      args: string[];
    };
    opts.announce(
      `probes target the server started by: ${[shown.command, ...shown.args].join(' ')}`,
    );
    if (opts.yes !== true) return all('no-yes');
  } else {
    if (target.kind === 'sse') return all('no-target');
    const url = new URL(target.url);
    if (!isThisMachine(target.url) && opts.confirmHost?.toLowerCase() !== url.host.toLowerCase())
      return all('no-consent');
    opts.announce(`probes will go to ${maskUrl(target.url)}`);
  }

  const garbage = `plune-probe-${randomBytes(24).toString('hex')}`;
  const secrets = [garbage, opts.tokens.accountA, opts.tokens.accountB].filter(
    (t): t is string => t !== undefined,
  );
  const forms = secrets.flatMap((t) => [t, b64(t), b64url(t)]);
  const redact =
    target.kind === 'stdio'
      ? createRedactor(forms, { named: Object.values(target.env) })
      : createRedactor(forms);
  let session: Session | undefined;
  if (target.kind === 'stdio') {
    try {
      session = await openSession(
        {
          target,
          timeoutMs: opts.timeoutMs,
          ...(opts.clientVersion === undefined ? {} : { clientVersion: opts.clientVersion }),
        },
        { modern: { version: REVISION } },
      );
    } catch {
      return all('start-failed');
    }
    const started = session;
    cleanups.push(() => started.close());
  }
  const guard = new ProbeGuard(
    opts.entries,
    {
      maxCalls: opts.maxCalls ?? DEFAULT_MAX_CALLS,
      maxRequests: opts.maxRequests ?? DEFAULT_MAX_REQUESTS,
    },
    session !== undefined
      ? stdioTransport(session, opts.timeoutMs)
      : httpTransport((target as { url: string }).url, redact, opts.timeoutMs),
    opts.journal,
  );
  opts.journal?.bind?.(redact);
  try {
    opts.journal?.record({
      dir: 'meta',
      ...(target.kind === 'stdio' ? { transport: 'stdio' } : { url: maskUrl(target.url) }),
      maxCalls: opts.maxCalls ?? DEFAULT_MAX_CALLS,
      maxRequests: opts.maxRequests ?? DEFAULT_MAX_REQUESTS,
      probes: opts.entries.length,
    });
  } catch {
    return all('journal-failed');
  }

  const meta = stdio ? ({ sent: false } as const) : await guard.send({ type: 'discovery' });
  if (meta.sent)
    section.metadata =
      meta.reply.kind === 'failure'
        ? 'unreachable'
        : meta.reply.status === 200
          ? 'found'
          : meta.reply.status === 404
            ? 'not-found'
            : 'unreachable';

  let listed: Set<string> | undefined;
  /** One probe: the server's answer to the declared call, or why there is none. */
  async function attempt(entry: ProbeEntry, credential: Credential): Promise<Attempt> {
    type Step = { stop: Attempt } | { ok: Decision & { kind: 'ok' } };
    const step = async (frame: Frame, name: string, expectMessage: boolean): Promise<Step> => {
      const sent = await guard.send(frame);
      if (!sent.sent) return { stop: { kind: 'not-run', reason: REASON_OF[sent.refusal] } };
      const d = decide(sent.reply, expectMessage);
      if (d.kind === 'refused') return { stop: { kind: 'http-refused', step: name } };
      // Before the call, any failure but 401/403 says nothing about the call: it is not run.
      if (d.kind === 'inconclusive' || (d.kind === 'rpc-error' && name !== 'tools/call'))
        return { stop: { kind: 'not-run', reason: 'inconclusive' } };
      if (d.kind === 'rpc-error')
        return { stop: { kind: 'errored', text: errorTextOf(d.message) } };
      return { ok: d };
    };
    const init = await step(
      {
        type: 'rpc',
        method: 'initialize',
        params: {
          protocolVersion: REVISION,
          capabilities: {},
          clientInfo: { name: 'plune-mcp-scan', version: '0' },
        },
        credential,
      },
      'initialize',
      true,
    );
    if ('stop' in init) return init.stop;
    const sessionId = init.ok.sessionId;
    const withSession = sessionId === undefined ? {} : { sessionId };
    const hello = await step(
      {
        type: 'rpc',
        method: 'notifications/initialized',
        notification: true,
        credential,
        ...withSession,
      },
      'notifications/initialized',
      false,
    );
    if ('stop' in hello) return hello.stop;
    if (listed === undefined) {
      const list = await step(
        { type: 'rpc', method: 'tools/list', credential, ...withSession },
        'tools/list',
        true,
      );
      if ('stop' in list) return list.stop;
      const tools = (list.ok.message as { tools?: unknown } | undefined)?.tools;
      if (!Array.isArray(tools)) return { kind: 'not-run', reason: 'inconclusive' };
      guard.setListedTools(tools);
      listed = new Set(
        tools.flatMap((t) =>
          typeof (t as { name?: unknown })?.name === 'string' ? [(t as { name: string }).name] : [],
        ),
      );
    }
    if (!listed.has(entry.tool)) return { kind: 'not-run', reason: 'tool-missing' };
    // A malformed probe sends the derived arguments; the wrapper allows exactly those for it.
    let args = entry.arguments;
    if (entry.fetches === true) {
      const f = guard.fetchArgumentsFor(entry);
      if (f === undefined) return { kind: 'not-run', reason: 'inconclusive' };
      args = f;
    } else if (entry.malformed === true) {
      const m = guard.malformedFor(entry.tool);
      if ('reason' in m) return { kind: 'not-run', reason: m.reason };
      args = m.args;
    }
    const call = await step(
      {
        type: 'rpc',
        method: 'tools/call',
        params: { name: entry.tool, arguments: args },
        probe: entry.id,
        credential,
        ...withSession,
      },
      'tools/call',
      true,
    );
    if ('stop' in call) return call.stop;
    return (call.ok.message as { isError?: unknown } | undefined)?.isError === true
      ? { kind: 'errored', text: errorTextOf(call.ok.message) }
      : { kind: 'allowed', result: call.ok.message };
  }

  /** The controls that ran and were allowed, by tool and arguments: the id of the probe. */
  const controls = new Map<string, string>();
  /** Calls that have a control in the file, and those whose control was refused by HTTP 401 or 403. */
  const hasControl = new Set<string>();
  const controlRefused = new Set<string>();
  const isControl = (e: ProbeEntry) => e.as === 'account-a' && e.expect === 'allow';
  const keyOf = (e: ProbeEntry) => `${e.tool}
${canonical(e.arguments)}`;
  for (const e of opts.entries) if (isControl(e)) hasControl.add(keyOf(e));

  // Controls first: a probe that expects a refusal is read against what the control showed.
  const order = [...opts.entries.filter(isControl), ...opts.entries.filter((e) => !isControl(e))];
  let page: Page | undefined;
  for (const entry of order) {
    let credential: Credential | undefined;
    let missing: ProbeReason | undefined;
    // On stdio there is no credential: only the probes that are about the answer (malformed, fetches) have anything to run.
    if (stdio && entry.malformed !== true && entry.fetches !== true) {
      section.rows.push(notRun(entry, 'stdio'));
      continue;
    }
    if (entry.fetches === true) {
      if (!pageReachable(target)) {
        section.rows.push(notRun(entry, 'remote-server'));
        continue;
      }
      if (page === undefined) {
        try {
          page = await startPage();
        } catch {
          section.rows.push(notRun(entry, 'inconclusive'));
          continue;
        }
        const started = page;
        cleanups.push(() => started.close());
        guard.setPageUrl(page.url);
      }
    }
    if (stdio) credential = { kind: 'none' };
    else
      switch (entry.as) {
        case 'none':
          credential = { kind: 'none' };
          break;
        case 'garbage':
          credential = { kind: 'bearer', token: garbage };
          break;
        case 'account-a':
          if (opts.tokens.accountA === undefined) missing = 'no-credential';
          else credential = { kind: 'bearer', token: opts.tokens.accountA };
          break;
        case 'account-b':
          if (opts.tokens.accountB === undefined) missing = 'no-account-b';
          else credential = { kind: 'bearer', token: opts.tokens.accountB };
          break;
        case 'wrong-audience':
          missing = 'wrong-audience';
          break;
      }
    if (credential === undefined) {
      section.rows.push(notRun(entry, missing!));
      continue;
    }
    const got = await attempt(entry, credential);
    if (got.kind === 'not-run') {
      section.rows.push(notRun(entry, got.reason));
      continue;
    }
    if (entry.fetches === true) {
      const base = { id: entry.id, tool: entry.tool, as: entry.as, expect: 'none' } as const;
      if (got.kind === 'http-refused') {
        section.rows.push({
          ...base,
          answer: 'refused',
          refusedAt: got.step,
          outcome: 'as-expected',
        });
        continue;
      }
      const verdict = got.kind === 'allowed' ? markerVerdict(got.result, page!.marker) : undefined;
      section.rows.push({
        ...base,
        answer: got.kind === 'errored' ? 'refused' : 'allowed',
        outcome: 'as-expected',
        note:
          verdict === undefined
            ? 'the call failed; there is nothing to compare'
            : verdict === 'verbatim'
              ? 'the marker came back verbatim, with no boundary'
              : verdict === 'bounded'
                ? 'the marker came back with a boundary'
                : 'the marker did not come back',
      });
      if (verdict === 'verbatim')
        section.findings.push({
          rule: FETCH_RULE,
          id: entry.id,
          tool: entry.tool,
          severity: 'advice',
          message: `${entry.tool}: returned the probe marker verbatim with no boundary; treat its output as untrusted (advice)`,
        });
      continue;
    }
    if (entry.malformed === true) {
      // No expectation and no control: the answer is searched for the patterns, and the row says what was found.
      const base = { id: entry.id, tool: entry.tool, as: entry.as, expect: 'none' } as const;
      if (got.kind === 'http-refused') {
        section.rows.push({
          ...base,
          answer: 'refused',
          refusedAt: got.step,
          outcome: 'as-expected',
        });
        continue;
      }
      const hit = got.kind === 'errored' ? findLeak(got.text) : undefined;
      section.rows.push({
        ...base,
        answer: got.kind === 'errored' ? 'refused' : 'allowed',
        outcome: 'as-expected',
        note:
          got.kind === 'allowed'
            ? 'ran; no error text to read'
            : hit === undefined
              ? 'no pattern matched'
              : `pattern ${hit}`,
      });
      if (hit !== undefined)
        section.findings.push({
          rule: LEAK_RULE,
          id: entry.id,
          tool: entry.tool,
          severity: 'advice',
          message: `${entry.tool}: invalid arguments answered with ${LEAK_PATTERNS.find((p) => p.id === hit)!.what} (pattern ${hit}) (advice)`,
        });
      continue;
    }
    const expect = entry.expect ?? 'none';
    const proven = controls.get(keyOf(entry));
    const base = { id: entry.id, tool: entry.tool, as: entry.as, expect } as const;
    // A refuse probe is read against its control; HTTP 401 or 403 stands alone, and the row says it has none.
    const withControl = expect === 'refuse' ? { control: proven ?? null } : {};
    if (got.kind === 'http-refused') {
      if (isControl(entry)) controlRefused.add(keyOf(entry));
      // The control of this call exists and did not run allowed: a refusal of this probe proves nothing, since the
      // server may refuse everyone for it. HTTP 401 or 403 stands alone only without a control, or beside a good one.
      if (expect === 'refuse' && proven === undefined && hasControl.has(keyOf(entry))) {
        section.rows.push({
          ...notRun(entry, 'no-control'),
          ...(controlRefused.has(keyOf(entry))
            ? {
                note: 'the control was refused too (HTTP 401 or 403): the server refuses everyone for this call',
              }
            : {}),
        });
        continue;
      }
      section.rows.push({
        ...base,
        answer: 'refused',
        refusedAt: got.step,
        outcome: expect === 'allow' ? 'observed' : 'as-expected',
        ...withControl,
      });
      continue;
    }
    if (got.kind === 'errored') {
      if (expect === 'refuse' && proven !== undefined)
        section.rows.push({ ...base, answer: 'refused', outcome: 'as-expected', control: proven });
      else section.rows.push(notRun(entry, expect === 'refuse' ? 'no-control' : 'inconclusive'));
      continue;
    }
    // The call ran.
    // A call that ran with no valid credentials is a violation by itself; for another account it needs the control.
    if (
      expect === 'refuse' &&
      proven === undefined &&
      entry.as !== 'none' &&
      entry.as !== 'garbage'
    ) {
      section.rows.push(notRun(entry, 'no-control'));
      continue;
    }
    if (isControl(entry)) controls.set(keyOf(entry), entry.id);
    const rule =
      entry.as in PROBE_RULE_OF ? PROBE_RULE_OF[entry.as as keyof typeof PROBE_RULE_OF] : undefined;
    if (rule === undefined || expect === 'allow') {
      section.rows.push({
        ...base,
        answer: 'allowed',
        outcome: rule === undefined && expect === 'refuse' ? 'observed' : 'as-expected',
        ...withControl,
      });
      continue;
    }
    const violated = expect === 'refuse';
    const who =
      entry.as === 'none'
        ? 'without credentials'
        : entry.as === 'garbage'
          ? 'with a random token'
          : 'for account B';
    section.rows.push({
      ...base,
      answer: 'allowed',
      outcome: violated ? 'violated' : 'observed',
      ...withControl,
    });
    section.findings.push({
      rule,
      id: entry.id,
      tool: entry.tool,
      severity: violated ? 'error' : 'info',
      message: violated
        ? `probe ${entry.id}: tool "${entry.tool}" ran ${who}; the probe file expects a refusal`
        : `probe ${entry.id}: tool "${entry.tool}" answered ${who}`,
    });
  }
  const at = new Map(opts.entries.map((e, i) => [e.id, i]));
  section.rows.sort((a, b) => (at.get(a.id) ?? 0) - (at.get(b.id) ?? 0));
  if (guard.journalFailed) section.journalFailed = true;
  section.calls = guard.calls;
  section.requests = guard.requests;
  return section;
}
