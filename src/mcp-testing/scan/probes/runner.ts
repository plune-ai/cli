import { randomBytes } from 'node:crypto';
import type { ConnectTarget } from '../../connect/options.js';
import { createRedactor, maskUrl } from '../../connect/redact.js';
import { isLocal } from '../../conformance/raw-http.js';
import {
  DEFAULT_MAX_CALLS,
  DEFAULT_MAX_REQUESTS,
  ProbeGuard,
  type Credential,
  type Frame,
  type Refusal,
  type Reply,
} from './guard.js';
import { httpTransport } from './http.js';
import type { ProbeEntry, ProbeReason, ProbeRow } from './types.js';

/**
 * Runs the declared probes against one server that the person says is theirs, and reports a row for every probe: what
 * the server did, or why the probe did not run. A verdict of "violated" comes only from a server's own answer to a call
 * the person declared. Timeout, 429, 5xx, a redirect or any other status that does not decide it is "not run", with
 * its reason. A finding is built from fixed fields (probe id, rule, tool, category): never an error message, a response
 * body or an argument value.
 */

export const PROBE_RULE_OF = {
  none: 'scan/probe/unauthenticated-call',
  garbage: 'scan/probe/garbage-token-accepted',
  'account-b': 'scan/probe/cross-account-access',
} as const;

export interface ProbeFinding {
  rule: (typeof PROBE_RULE_OF)[keyof typeof PROBE_RULE_OF];
  id: string;
  tool: string;
  severity: 'error' | 'info';
  message: string;
}

export interface ProbeSection {
  rows: ProbeRow[];
  findings: ProbeFinding[];
  calls: number;
  requests: number;
  /** Whether the public metadata of the target's origin answered (asked without a token); null when not asked. */
  metadata: 'found' | 'not-found' | 'unreachable' | null;
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
  undeclared: 'inconclusive',
};

type Decision =
  | { kind: 'refused' }
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
  if (message.error !== undefined) return { kind: 'refused' };
  return {
    kind: 'ok',
    message: message.result,
    ...(reply.sessionId === undefined ? {} : { sessionId: reply.sessionId }),
  };
}

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
  if (target.kind === 'stdio') {
    // The command is shown in full, so the person sees what a probe would start; no probe of this version runs on it.
    opts.announce(
      `probes target the server started by: ${[target.command, ...target.args].join(' ')}`,
    );
    return all('stdio');
  }
  if (target.kind === 'sse') return all('no-target');
  const url = new URL(target.url);
  if (!isLocal(target.url) && opts.confirmHost?.toLowerCase() !== url.host.toLowerCase())
    return all('no-consent');
  opts.announce(`probes will go to ${maskUrl(target.url)}`);

  const garbage = `plune-probe-${randomBytes(24).toString('hex')}`;
  const secrets = [garbage, opts.tokens.accountA, opts.tokens.accountB].filter(
    (t): t is string => t !== undefined,
  );
  const redact = createRedactor(secrets.flatMap((t) => [t, b64(t), b64url(t)]));
  const guard = new ProbeGuard(
    opts.entries,
    {
      maxCalls: opts.maxCalls ?? DEFAULT_MAX_CALLS,
      maxRequests: opts.maxRequests ?? DEFAULT_MAX_REQUESTS,
    },
    httpTransport(target.url, redact, opts.timeoutMs),
  );

  const meta = await guard.send({ type: 'discovery' });
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
  async function attempt(
    entry: ProbeEntry,
    credential: Credential,
  ): Promise<{ answer: 'allowed' | 'refused' } | { reason: ProbeReason }> {
    const step = async (
      frame: Frame,
      expectMessage: boolean,
    ): Promise<
      { stop: { answer: 'refused' } | { reason: ProbeReason } } | { ok: Decision & { kind: 'ok' } }
    > => {
      const sent = await guard.send(frame);
      if (!sent.sent) return { stop: { reason: REASON_OF[sent.refusal] } };
      const d = decide(sent.reply, expectMessage);
      if (d.kind === 'refused') return { stop: { answer: 'refused' } };
      if (d.kind === 'inconclusive') return { stop: { reason: 'inconclusive' } };
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
      false,
    );
    if ('stop' in hello) return hello.stop;
    if (listed === undefined) {
      const list = await step(
        { type: 'rpc', method: 'tools/list', credential, ...withSession },
        true,
      );
      if ('stop' in list) return list.stop;
      const tools = (list.ok.message as { tools?: unknown } | undefined)?.tools;
      if (!Array.isArray(tools)) return { reason: 'inconclusive' };
      guard.setListedTools(tools);
      listed = new Set(
        tools.flatMap((t) =>
          typeof (t as { name?: unknown })?.name === 'string' ? [(t as { name: string }).name] : [],
        ),
      );
    }
    if (!listed.has(entry.tool)) return { reason: 'tool-missing' };
    const call = await step(
      {
        type: 'rpc',
        method: 'tools/call',
        params: { name: entry.tool, arguments: entry.arguments },
        credential,
        ...withSession,
      },
      true,
    );
    if ('stop' in call) return call.stop;
    return {
      answer:
        (call.ok.message as { isError?: unknown } | undefined)?.isError === true
          ? 'refused'
          : 'allowed',
    };
  }

  for (const entry of opts.entries) {
    let credential: Credential | undefined;
    let missing: ProbeReason | undefined;
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
    if ('reason' in got) {
      section.rows.push(notRun(entry, got.reason));
      continue;
    }
    const expect = entry.expect ?? 'none';
    const base = {
      id: entry.id,
      tool: entry.tool,
      as: entry.as,
      expect,
      answer: got.answer,
    } as const;
    if (got.answer === 'refused') {
      section.rows.push({ ...base, outcome: expect === 'allow' ? 'observed' : 'as-expected' });
      continue;
    }
    const rule =
      entry.as in PROBE_RULE_OF ? PROBE_RULE_OF[entry.as as keyof typeof PROBE_RULE_OF] : undefined;
    if (rule === undefined || expect === 'allow') {
      section.rows.push({
        ...base,
        outcome: rule === undefined && expect === 'refuse' ? 'observed' : 'as-expected',
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
    section.rows.push({ ...base, outcome: violated ? 'violated' : 'observed' });
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
  section.calls = guard.calls;
  section.requests = guard.requests;
  return section;
}
