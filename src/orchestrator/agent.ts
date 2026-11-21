// The tool loop of one dataset row of an eval with an `mcp` server: the model is offered the server's tools, each
// call it asks for runs on the server, the answer goes back, and so on until the model answers or a limit stops it.
// Pure given its deps, like `runRow`: the session, the provider and the clock come in; nothing here opens a socket.
// Never cached: a stored answer about a call does not show that the server still answers so, which is what is tested.

import type {
  AgentAdvice,
  AgentCall,
  AgentRecord,
  AgentStep,
  AgentTranscript,
  RowResult,
  RunError,
  Usage,
} from '../types/results.js';
import type { McpLimits } from '../types/config.js';
import type { AgentMessage, ToolCall, ToolSpec } from '../types/provider.js';
import type { Redactor } from '../mcp-testing/connect/redact.js';
import type { CallAnswer } from '../mcp-testing/connect/tools.js';
import {
  assess,
  costFields,
  dryRunRow,
  estimateUsage,
  resolvePrompt,
  sumUsage,
  toRunError,
  type RowParams,
} from './run.js';
import { wireNames } from './tool-names.js';
import {
  frictionAdvice,
  redactAnswer,
  redactIds,
  redactReason,
  redactUuids,
  scanIds,
  type FrictionCall,
  type IdScan,
} from './friction.js';
import { sha256 } from '../util/hash.js';

/** The most of one result's or step's text kept in the transcript, in UTF-8 bytes. */
export const EXCERPT_BYTES = 4 * 1024;
/** The most of all excerpts of one row together; past it, excerpts are empty and marked cut. */
export const TRANSCRIPT_BYTES = 256 * 1024;

const DEFAULT_MAX_TOKENS = 1024;

/** One session with the server, for one row. */
export interface AgentServer {
  /** The masking of this server's values (headers, env): every text kept of the loop goes through it. */
  readonly redact: Redactor;
  /** `tools/list` to its last page, as the server sent it. */
  listTools(timeoutMs: number): Promise<unknown[]>;
  callTool(name: string, args: Record<string, unknown>, timeoutMs: number): Promise<CallAnswer>;
  close(): Promise<void>;
}

/** Opens a session with the server named in `mcp.servers`; a failure rejects with a message already masked. */
export type AgentConnect = (server: string, timeoutMs: number) => Promise<AgentServer>;

export interface AgentRowParams extends RowParams {
  server: string;
  allowedTools?: string[];
  limits: Required<McpLimits>;
  connect: AgentConnect;
  /**
   * `--tool-description`: tool name to the text the model is shown in its place. Only the request to the model
   * changes; the server is asked nothing different and its own list is what the transcript keeps.
   */
  toolDescriptions?: Record<string, string>;
}

type Limit = NonNullable<AgentTranscript['stop']['limit']>;

class LimitStop extends Error {
  constructor(readonly limit: Limit) {
    super(`stopped by ${limit}`);
  }
}

/** The row ends errored with this code; the transcript so far is kept. */
class AgentError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** A tool's answer as the model reads it: the text blocks, any other block as JSON. */
export function resultText(result: unknown): string {
  if (!isRecord(result)) return JSON.stringify(result) ?? '';
  const content = Array.isArray(result.content) ? (result.content as unknown[]) : [];
  if (content.length === 0 && result.structuredContent !== undefined)
    return JSON.stringify(result.structuredContent);
  return content
    .map((b) =>
      isRecord(b) && b.type === 'text' && typeof b.text === 'string' ? b.text : JSON.stringify(b),
    )
    .join('\n');
}

/** The first `keep` bytes of a text in UTF-8. A cut inside a character leaves a replacement mark at the end; it is not part of the text. */
const firstBytes = (whole: Buffer, keep: number): string =>
  whole.subarray(0, keep).toString('utf8').replace(/�$/, '');

/** Cuts texts to their excerpts: `bytes` is measured on the whole text, before any cut. */
function excerpts(): {
  cut(text: string): { text: string; bytes: number; truncated: boolean };
  any: boolean;
} {
  let left = TRANSCRIPT_BYTES;
  const state = {
    any: false,
    cut(text: string) {
      const whole = Buffer.from(text, 'utf8');
      const keep = Math.max(0, Math.min(EXCERPT_BYTES, left, whole.length));
      left -= keep;
      const truncated = keep < whole.length;
      if (truncated) state.any = true;
      const kept = truncated ? firstBytes(whole, keep) : text;
      return { text: kept, bytes: whole.length, truncated };
    },
  };
  return state;
}

/** The tools of a `tools/list`, one entry per name (the first one), in list order. */
function listedTools(items: unknown[]): Record<string, unknown>[] {
  const seen = new Set<string>();
  return items.filter((t): t is Record<string, unknown> => {
    if (!isRecord(t) || typeof t.name !== 'string' || t.name === '' || seen.has(t.name))
      return false;
    seen.add(t.name);
    return true;
  });
}

export async function runAgentRow(p: AgentRowParams): Promise<RowResult> {
  const t0 = p.now();
  const prompt = resolvePrompt(p.template, p.row.vars);
  const temperature = p.providerConfig.temperature;
  const maxTokens = p.providerConfig.max_tokens ?? DEFAULT_MAX_TOKENS;
  const { limits } = p;

  // --dry-run: no server, no model. The bound is max_steps calls at the prompt's size; tool schemas and results
  // would add to every step and are not counted.
  if (p.dryRun) {
    const one = estimateUsage(prompt, maxTokens);
    const est = {
      input_tokens: one.input_tokens * limits.max_steps,
      output_tokens: one.output_tokens * limits.max_steps,
    };
    return dryRunRow(p.row.vars, { ...est, ...costFields(p.provider.estimateCost(est)) });
  }

  const respond = p.provider.respond!.bind(p.provider);
  const deadline = t0 + limits.timeout_ms;
  /** `work`, or a stop by `timeout_ms` once the row's time is up. */
  const bounded = <T>(work: Promise<T>): Promise<T> => {
    const ms = deadline - p.now();
    let timer: NodeJS.Timeout | undefined;
    return Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new LimitStop('timeout_ms')), Math.max(0, ms));
      }),
    ]).finally(() => clearTimeout(timer));
  };

  const transcript: AgentTranscript = {
    server: p.server,
    tools: [],
    steps: [],
    stop: { reason: 'complete' },
    collection: 'complete',
  };
  const kept = excerpts();
  const usages: Usage[] = [];
  let output = '';
  let error: RunError | undefined;
  let session: AgentServer | undefined;
  /** What each executed call's answer held in identifiers, read while the whole answer is at hand. */
  const scanned = new Map<AgentCall, IdScan>();
  /**
   * Each answered call's whole answer with its identifiers replaced, for the stored transcript. The checks and the
   * friction signals read the transcript before it is swapped in, so they see the values.
   */
  const cleaned = new Map<AgentCall, { text: string; unread?: string }>();
  const overrides = p.toolDescriptions ?? {};
  /** The tools whose description the model was shown in place of the server's. */
  const replaced = new Set<string>();

  try {
    // Starting a server is not a tool call: it has the row's time, not tool_timeout_ms.
    const opening = p.connect(p.server, limits.timeout_ms);
    try {
      session = await bounded(opening);
    } catch (err) {
      // A session that opens after the row gave up on it is closed, not left running.
      void opening.then(
        (s) => s.close(),
        () => {},
      );
      if (err instanceof LimitStop) throw err;
      throw new AgentError('MCP_CONNECT', (err as Error).message);
    }

    const open = session;
    let names = wireNames([]);
    let tools: ToolSpec[] = [];
    let offeredNames: string[] = [];
    /**
     * Reads `tools/list` and offers what it holds, within `allowed_tools`. `transcript.tools` keeps every tool listed
     * at any point of the row, offered if it ever was, so a check may name a tool the list held only for a while.
     * Returns what was added and removed, or undefined when the offered set did not change.
     */
    const list = async (): Promise<AgentStep['offered_changed']> => {
      let listed: Record<string, unknown>[];
      try {
        listed = listedTools(await bounded(open.listTools(limits.tool_timeout_ms)));
      } catch (err) {
        if (err instanceof LimitStop) throw err;
        throw new AgentError('MCP_LIST_TOOLS', `tools/list failed: ${(err as Error).message}`);
      }
      const offered = listed.filter(
        (t) => p.allowedTools === undefined || p.allowedTools.includes(t.name as string),
      );
      for (const t of listed) {
        const isOffered = offered.includes(t);
        const known = transcript.tools.find((k) => k.name === t.name);
        if (known !== undefined) known.offered ||= isOffered;
        else
          transcript.tools.push({
            name: t.name as string,
            offered: isOffered,
            ...(isRecord(t.annotations) ? { annotations: t.annotations } : {}),
          });
      }
      const now = offered.map((t) => t.name as string);
      const added = now.filter((n) => !offeredNames.includes(n));
      const removed = offeredNames.filter((n) => !now.includes(n));
      offeredNames = now;
      names = wireNames(now);
      tools = offered.map((t) => {
        const swap = overrides[t.name as string];
        if (swap !== undefined) replaced.add(t.name as string);
        const description = swap ?? (typeof t.description === 'string' ? t.description : undefined);
        return {
          name: names.toWire.get(t.name as string)!,
          ...(description !== undefined ? { description } : {}),
          input_schema: isRecord(t.inputSchema) ? t.inputSchema : { type: 'object' },
        };
      });
      return added.length + removed.length > 0 ? { added, removed } : undefined;
    };
    await list();

    const messages: AgentMessage[] = [{ role: 'user', content: prompt }];
    let calls = 0;
    let tokens = 0;
    // The change a re-read list made, recorded on the step whose request first carried it.
    let changed: AgentStep['offered_changed'];
    for (let index = 1; ; index++) {
      const res = await bounded(
        respond({
          provider: p.providerConfig.type,
          model: p.providerConfig.model,
          ...(temperature !== undefined ? { temperature } : {}),
          max_tokens: maxTokens,
          messages,
          tools,
        }),
      );
      const usage: Usage = {
        ...res.usage,
        ...costFields(p.provider.estimateCost(res.usage, res.cost_usd)),
      };
      usages.push(usage);
      tokens += res.usage.input_tokens + res.usage.output_tokens;
      output = res.text;
      const records: AgentCall[] = res.tool_calls.map((c) => ({
        id: c.id,
        name: names.toServer.get(c.name) ?? c.name,
        args: c.args,
        executed: false,
        is_error: false,
      }));
      const step: AgentStep = {
        index,
        text: kept.cut(res.text).text,
        ...(res.finish_reason !== undefined ? { finish_reason: res.finish_reason } : {}),
        usage,
        calls: records,
        ...(changed !== undefined ? { offered_changed: changed } : {}),
      };
      changed = undefined;
      transcript.steps.push(step);

      if (res.finish_reason === 'error')
        throw new AgentError(
          'PROVIDER_ERROR',
          'The provider answered with an error instead of a turn.',
        );
      if (res.tool_calls.length === 0) break;
      // Cut off by max_tokens in the middle of a call: the call may be incomplete, and "no more calls" would be a lie.
      if (res.finish_reason === 'length')
        throw new AgentError(
          'AGENT_CUT_OFF',
          `Step ${index} hit max_tokens in the middle of a tool call.`,
        );
      // Results of these calls would reach the model only in a step it may not take.
      if (index >= limits.max_steps) throw new LimitStop('max_steps');
      // Checked after the step, so the limit can be passed by at most one step.
      if (tokens > limits.max_total_tokens) throw new LimitStop('max_total_tokens');

      const results: { id: string; content: string; is_error: boolean }[] = [];
      const answer = (rec: AgentCall, c: ToolCall, content: string) =>
        results.push({ id: c.id, content, is_error: rec.is_error });
      let succeeded = false;
      for (const [i, c] of res.tool_calls.entries()) {
        const rec = records[i]!;
        if (calls >= limits.max_tool_calls) throw new LimitStop('max_tool_calls');
        calls++;
        const server = names.toServer.get(c.name);
        if (server === undefined) {
          Object.assign(rec, { is_error: true, error_kind: 'not-offered' });
          answer(rec, c, `Tool "${c.name}" is not available.`);
          continue;
        }
        if (c.args_invalid === true || !isRecord(c.args)) {
          Object.assign(rec, { is_error: true, error_kind: 'bad-arguments' });
          answer(rec, c, 'The arguments are not a JSON object.');
          continue;
        }
        const started = p.now();
        rec.executed = true;
        const got = await bounded(session.callTool(server, c.args, limits.tool_timeout_ms));
        rec.duration_ms = p.now() - started;
        if (got.kind === 'timeout') {
          Object.assign(rec, { is_error: true, error_kind: 'timeout' });
          throw new LimitStop('tool_timeout_ms');
        }
        if (got.kind === 'lost') throw new AgentError('MCP_SERVER_LOST', got.message);
        const text = got.kind === 'error' ? got.message : resultText(got.result);
        if (got.kind === 'error') Object.assign(rec, { is_error: true, error_kind: 'protocol' });
        else if (isRecord(got.result) && got.result.isError === true)
          Object.assign(rec, { is_error: true, error_kind: 'content' });
        succeeded ||= !rec.is_error;
        if (got.kind === 'result' && !rec.is_error) scanned.set(rec, scanIds(got.result));
        rec.result = kept.cut(text);
        if (got.kind === 'result') {
          const r = redactAnswer(got.result);
          cleaned.set(rec, {
            text: resultText(r.result),
            ...(r.unread !== undefined ? { unread: r.unread } : {}),
          });
        } else
          cleaned.set(rec, {
            text: redactUuids(text),
            unread: 'the answer is an error message, not JSON',
          });
        // The model gets the whole answer; only the transcript keeps an excerpt.
        answer(rec, c, text);
      }
      messages.push(
        { role: 'assistant', text: res.text, tool_calls: res.tool_calls },
        { role: 'tool', results },
      );
      // A server may change its list as a side effect of a call (MCP 2025: discovery switches tools on, and it says
      // so with notifications/tools/list_changed). The list is read again after a step with a call that succeeded,
      // rather than on that notification: over HTTP it may come on another stream, after the call's answer, and a
      // re-read cannot miss it. A fixed list (2026-07-28) reads the same, so nothing changes there.
      if (succeeded) changed = await list();
    }
  } catch (err) {
    if (err instanceof LimitStop) transcript.stop = { reason: 'limit', limit: err.limit };
    else {
      transcript.stop = { reason: 'error' };
      error =
        err instanceof AgentError ? { code: err.code, message: err.message } : toRunError(err);
    }
  } finally {
    await session?.close().catch(() => {});
  }

  if (transcript.stop.reason !== 'complete' || kept.any) transcript.collection = 'partial';
  // Read before the transcript is masked and cut: only names, steps, counts and key paths come out of it.
  const friction =
    error === undefined
      ? frictionAdvice(
          transcript.steps.flatMap((s) =>
            s.calls.map(
              (c): FrictionCall => ({
                step: s.index,
                name: c.name,
                args: c.args,
                executed: c.executed,
                is_error: c.is_error,
                ...(scanned.has(c) ? { ids: scanned.get(c)! } : {}),
              }),
            ),
          ),
        )
      : [];
  const mask = session?.redact;
  const agent = (mask?.value(transcript) ?? transcript) as AgentTranscript;
  if (replaced.size > 0)
    (agent as AgentRecord).description_overrides = [...replaced].sort().map((tool) => ({
      tool,
      sha256: sha256(overrides[tool]!),
    }));
  /**
   * Swaps the identifier values out of the stored transcript: in `args`, and in `result.text`, which, if the first excerpt
   * was cut, is cut again from the cleaned whole answer to the bytes that excerpt kept (`bytes` stays the size of the
   * real answer, `truncated` what the first excerpt said).
   * Run once every check has read the transcript. The reasons of the checks (`said`) quote arguments, so they go by
   * the same rule; the checks themselves compared the real values. Returns where an answer could not be fully cleaned.
   */
  const storeWithoutIds = (
    said: { reason?: string }[] = [],
    err?: { message: string },
  ): AgentAdvice[] => {
    for (const r of said) if (r.reason !== undefined) r.reason = redactReason(r.reason);
    if (err !== undefined) err.message = redactReason(err.message);
    const unread = new Map<string, { steps: Set<number>; count: number; why: string }>();
    transcript.steps.forEach((s, si) =>
      s.calls.forEach((c, ci) => {
        const out = agent.steps[si]!.calls[ci]!;
        out.args = redactIds(out.args).value;
        const clean = cleaned.get(c);
        if (out.result === undefined || clean === undefined) return;
        const whole = Buffer.from(mask?.text(clean.text) ?? clean.text, 'utf8');
        // ponytail: `truncated` (and `collection`) keep what the first excerpt said about the real answer. An answer
        // stored whole stays whole even when a mark is longer than its value (`1` → `"<id>"`): it can exceed the
        // excerpt budget by a few bytes per identifier. Only an answer that was already cut is cut again.
        const keep = Buffer.byteLength(out.result.text, 'utf8');
        out.result = {
          ...out.result,
          text:
            out.result.truncated && keep < whole.length
              ? firstBytes(whole, keep)
              : whole.toString('utf8'),
        };
        if (clean.unread === undefined) return;
        const u = unread.get(c.name) ?? { steps: new Set(), count: 0, why: clean.unread };
        u.steps.add(s.index);
        u.count++;
        unread.set(c.name, u);
      }),
    );
    return [...unread].map(([tool, u]) => {
      const steps = [...u.steps].sort((x, y) => x - y);
      return {
        type: 'ids-not-redacted',
        tool,
        steps,
        count: u.count,
        reason: `${tool}: ${u.why}, so only UUID-shaped values were replaced in its stored answer; other identifiers may remain (steps ${steps.join(', ')})`,
      };
    });
  };
  const spent = usages.length > 0 ? { usage: sumUsage(usages) } : {};
  if (error !== undefined) {
    const notes = storeWithoutIds();
    if (notes.length > 0) (agent as AgentRecord).advice = notes;
    return {
      vars: p.row.vars,
      output: null,
      cached: false,
      ...spent,
      latency_ms: p.now() - t0,
      error: { code: error.code, message: mask?.text(error.message) ?? error.message },
      assertions: [],
      agent,
    };
  }

  // The tool-call assertions read the masked transcript, so their reasons carry no server value either.
  const { records, assertionError, judgeCost, judgeUnpriced, advice } = await assess(
    p,
    output,
    agent,
  );
  // `no-repeated-call` already tells a repeat of the tools it covers: one advice for one finding.
  const covered = p.assertions.filter((x) => x.type === 'no-repeated-call') as { tool?: string }[];
  const signals = ((mask?.value(friction) ?? friction) as AgentAdvice[]).filter(
    (f) =>
      !(
        f.type === 'identical-retry' &&
        covered.some((c) => c.tool === undefined || c.tool === f.tool)
      ),
  );
  const findings = [
    ...advice,
    ...signals,
    ...storeWithoutIds([...records, ...advice], assertionError),
  ];
  if (findings.length > 0) (agent as AgentRecord).advice = findings;
  const usage = sumUsage(usages);
  return {
    vars: p.row.vars,
    output: mask?.text(output) ?? output,
    cached: false,
    usage: {
      ...usage,
      cost_usd: usage.cost_usd + judgeCost,
      ...(judgeUnpriced ? { priced: false } : {}),
    },
    latency_ms: p.now() - t0,
    ...(assertionError !== undefined ? { error: assertionError } : {}),
    assertions: records,
    agent,
  };
}
