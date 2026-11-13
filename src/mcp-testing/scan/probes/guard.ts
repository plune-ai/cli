import { journalHeaders, type ProbeJournal } from './journal.js';
import { derivedTooLarge, malformedArguments, schemaTooLarge } from './leak.js';
import type { ProbeEntry } from './types.js';

/**
 * The one door every probe frame goes through. The raw transport is a private field of this class and the module that
 * builds it hands it over once, at construction: nothing else in the probes can send a request, so the rules below are
 * not a convention but the only path.
 *
 *  - a `tools/call` is sent only for a tool and arguments that are an entry of the probe file;
 *  - a tool the server marks `destructiveHint: true` is not called unless the entry says `allowDestructive: true`
 *    (`readOnlyHint` is never read: no hint of a server widens what may be sent);
 *  - both budgets are counted here, and a frame over a budget is refused before it is sent;
 *  - after two transport failures in a row nothing more is sent;
 *  - a probe entry with `malformed: true` allows one call only: the derived one (see `leak.ts`) for its tool, from the
 *    `inputSchema` the server listed, and never the arguments written in the file;
 *  - with a journal, a line is written before every frame is sent, and for every answer and every refusal; when a
 *    line cannot be written nothing more is sent.
 */

export type Credential = { kind: 'none' } | { kind: 'bearer'; token: string };

export type Frame =
  | {
      type: 'rpc';
      method: string;
      params?: Record<string, unknown>;
      notification?: boolean;
      /** The probe a `tools/call` is for: the guard checks that entry, not just any entry of the same tool. */
      probe?: string;
      credential: Credential;
      sessionId?: string;
    }
  /** The public metadata of the server's own origin. By construction it has no credential. */
  | { type: 'discovery' };

export type Reply =
  | { kind: 'failure'; why: 'timeout' | 'network' }
  | { kind: 'http'; status: number; message?: unknown; sessionId?: string; bytes?: number };

export type Refusal =
  | 'undeclared'
  | 'destructive'
  | 'budget'
  | 'transport-stopped'
  | 'tools-unknown'
  | 'journal-failed';
export type Sent = { sent: true; reply: Reply } | { sent: false; refusal: Refusal };

/** Transport failures in a row after which the remaining probes are not sent. */
export const TRANSPORT_FAILURES_IN_A_ROW = 2;
export const DEFAULT_MAX_CALLS = 8;
export const DEFAULT_MAX_REQUESTS = 40;

/** The methods a probe may use besides `tools/call`; any other method is refused. */
const METHODS = new Set(['initialize', 'notifications/initialized', 'tools/list']);

/** JSON with the keys in order, so two spellings of the same arguments are the same text. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null)
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

export class ProbeGuard {
  #calls = 0;
  #requests = 0;
  #failures = 0;
  #stopped = false;
  #destructive = new Set<string>();
  #listed = false;
  #seq = 0;
  #journalFailed = false;
  readonly #schemas = new Map<string, unknown>();
  readonly #journal: ProbeJournal | undefined;
  readonly #transport: (frame: Frame) => Promise<Reply>;
  readonly #declared: readonly ProbeEntry[];
  readonly #maxCalls: number;
  readonly #maxRequests: number;

  constructor(
    declared: readonly ProbeEntry[],
    limits: { maxCalls: number; maxRequests: number },
    transport: (frame: Frame) => Promise<Reply>,
    journal?: ProbeJournal,
  ) {
    for (const [name, value] of [
      ['maxCalls', limits.maxCalls],
      ['maxRequests', limits.maxRequests],
    ] as const)
      if (!Number.isInteger(value) || value < 1)
        throw new RangeError(`${name} must be a whole number of 1 or more.`);
    this.#declared = declared;
    this.#maxCalls = limits.maxCalls;
    this.#maxRequests = limits.maxRequests;
    this.#transport = transport;
    this.#journal = journal;
  }

  get calls(): number {
    return this.#calls;
  }
  get requests(): number {
    return this.#requests;
  }
  get stopped(): boolean {
    return this.#stopped;
  }

  /** The tools the server listed: the names whose `destructiveHint` is exactly `true`. */
  setListedTools(tools: readonly unknown[]): void {
    this.#listed = true;
    this.#schemas.clear();
    for (const t of tools) {
      const tool = t as { name?: unknown; inputSchema?: unknown } | null;
      if (typeof tool?.name === 'string') this.#schemas.set(tool.name, tool.inputSchema);
    }
    this.#destructive = new Set(
      tools.flatMap((t) => {
        const tool = t as { name?: unknown; annotations?: { destructiveHint?: unknown } } | null;
        // A malformed hint is not a permission: only a boolean false, null or no hint at all lets a tool through.
        const hint = tool?.annotations?.destructiveHint;
        return typeof tool?.name === 'string' &&
          (hint === true || (hint !== undefined && hint !== null && typeof hint !== 'boolean'))
          ? [tool.name]
          : [];
      }),
    );
  }

  /** The malformed arguments of a listed tool, derived from its `inputSchema`; undefined when it declares nothing to break. */
  malformedArgumentsFor(tool: string): Record<string, unknown> | undefined {
    const m = this.malformedFor(tool);
    return 'args' in m ? m.args : undefined;
  }

  /** The derived call of a listed tool, or why there is none. */
  malformedFor(
    tool: string,
  ): { args: Record<string, unknown> } | { reason: 'no-schema' | 'schema-too-large' } {
    const schema = this.#schemas.get(tool);
    if (schemaTooLarge(schema)) return { reason: 'schema-too-large' };
    const args = malformedArguments(schema);
    if (args === undefined) return { reason: 'no-schema' };
    return derivedTooLarge(args) ? { reason: 'schema-too-large' } : { args };
  }

  /** A line of the journal could not be written, on any kind of line: the journal is incomplete. */
  get journalFailed(): boolean {
    return this.#journalFailed;
  }

  /** Writes a line; a journal that cannot be written stops everything that follows. */
  #note(line: Record<string, unknown>): boolean {
    if (this.#journal === undefined) return true;
    try {
      this.#journal.record(line);
      return true;
    } catch {
      this.#stopped = true;
      this.#journalFailed = true;
      return false;
    }
  }

  #refuse(frame: Frame, refusal: Refusal): Sent {
    const params = frame.type === 'rpc' ? frame.params : undefined;
    this.#note({
      dir: 'refused',
      kind: frame.type,
      ...(frame.type === 'rpc' ? { method: frame.method } : {}),
      ...(typeof params?.['name'] === 'string' ? { tool: params['name'] } : {}),
      ...(frame.type === 'rpc' && frame.probe !== undefined ? { probe: frame.probe } : {}),
      reason: refusal,
    });
    return { sent: false, refusal };
  }

  async send(frame: Frame): Promise<Sent> {
    if (this.#stopped)
      return this.#journalFailed
        ? { sent: false, refusal: 'journal-failed' }
        : this.#refuse(frame, 'transport-stopped');
    let isCall = false;
    if (frame.type === 'rpc') {
      if (frame.method === 'tools/call') {
        isCall = true;
        const name = frame.params?.['name'];
        const args = canonical(frame.params?.['arguments'] ?? {});
        // A malformed entry allows the derived call and nothing else; any other entry, its declared arguments.
        const derived = typeof name === 'string' ? this.malformedArgumentsFor(name) : undefined;
        const entry = this.#declared.find(
          (e) =>
            e.id === frame.probe &&
            e.tool === name &&
            (e.malformed === true
              ? e.as === 'account-a' && derived !== undefined && canonical(derived) === args
              : canonical(e.arguments) === args),
        );
        if (entry === undefined) return this.#refuse(frame, 'undeclared');
        // Until the server's tool list is known, a destructive tool cannot be told from any other: nothing is called.
        if (!this.#listed) return this.#refuse(frame, 'tools-unknown');
        if (
          typeof name === 'string' &&
          this.#destructive.has(name) &&
          entry.allowDestructive !== true
        )
          return this.#refuse(frame, 'destructive');
      } else if (!METHODS.has(frame.method)) return this.#refuse(frame, 'undeclared');
    }
    if (this.#requests >= this.#maxRequests || (isCall && this.#calls >= this.#maxCalls))
      return this.#refuse(frame, 'budget');
    // The line comes first: a frame that was not recorded is not sent.
    const seq = ++this.#seq;
    if (!this.#note(outLine(seq, frame))) return { sent: false, refusal: 'journal-failed' };
    this.#requests++;
    if (isCall) this.#calls++;
    const reply = await this.#transport(frame);
    this.#note(inLine(seq, reply));
    const trouble = reply.kind === 'failure' || reply.status === 429 || reply.status >= 500;
    this.#failures = trouble ? this.#failures + 1 : 0;
    if (this.#failures >= TRANSPORT_FAILURES_IN_A_ROW) this.#stopped = true;
    return { sent: true, reply };
  }
}

/** What goes in the journal for a frame that is sent: fixed fields, the kind of credential, no value of it. */
function outLine(seq: number, frame: Frame): Record<string, unknown> {
  if (frame.type === 'discovery') return { dir: 'out', seq, kind: 'discovery' };
  const headers: [string, string][] = [];
  if (frame.credential.kind === 'bearer')
    headers.push(['Authorization', `Bearer ${frame.credential.token}`]);
  if (frame.sessionId !== undefined) headers.push(['Mcp-Session-Id', frame.sessionId]);
  const tool = frame.params?.['name'];
  return {
    dir: 'out',
    seq,
    kind: 'rpc',
    method: frame.method,
    ...(frame.notification === true ? { notification: true } : {}),
    ...(typeof tool === 'string' ? { tool } : {}),
    ...(frame.probe === undefined ? {} : { probe: frame.probe }),
    as: frame.credential.kind,
    ...(frame.params === undefined
      ? {}
      : { paramsBytes: Buffer.byteLength(JSON.stringify(frame.params), 'utf8') }),
    headers: journalHeaders(headers),
  };
}

/** What goes in the journal for an answer: the status, the id, which of result, error and isError it held, and a size. Never the body. */
function inLine(seq: number, reply: Reply): Record<string, unknown> {
  if (reply.kind === 'failure') return { dir: 'in', seq, failure: reply.why };
  const m = reply.message as { id?: unknown; result?: unknown; error?: unknown } | undefined;
  const isMessage = typeof m === 'object' && m !== null;
  return {
    dir: 'in',
    seq,
    status: reply.status,
    ...(isMessage && typeof m.id === 'number' ? { rpcId: m.id } : {}),
    ...(isMessage
      ? {
          result: m.result !== undefined,
          error: m.error !== undefined,
          isError: (m.result as { isError?: unknown } | undefined)?.isError === true,
        }
      : {}),
    ...(reply.bytes === undefined ? {} : { bytes: reply.bytes }),
  };
}
