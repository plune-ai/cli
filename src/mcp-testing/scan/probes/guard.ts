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
 *  - after two transport failures in a row nothing more is sent.
 */

export type Credential = { kind: 'none' } | { kind: 'bearer'; token: string };

export type Frame =
  | {
      type: 'rpc';
      method: string;
      params?: Record<string, unknown>;
      notification?: boolean;
      credential: Credential;
      sessionId?: string;
    }
  /** The public metadata of the server's own origin. By construction it has no credential. */
  | { type: 'discovery' };

export type Reply =
  | { kind: 'failure'; why: 'timeout' | 'network' }
  | { kind: 'http'; status: number; message?: unknown; sessionId?: string };

export type Refusal = 'undeclared' | 'destructive' | 'budget' | 'transport-stopped';
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
  readonly #transport: (frame: Frame) => Promise<Reply>;
  readonly #declared: readonly ProbeEntry[];
  readonly #maxCalls: number;
  readonly #maxRequests: number;

  constructor(
    declared: readonly ProbeEntry[],
    limits: { maxCalls: number; maxRequests: number },
    transport: (frame: Frame) => Promise<Reply>,
  ) {
    this.#declared = declared;
    this.#maxCalls = limits.maxCalls;
    this.#maxRequests = limits.maxRequests;
    this.#transport = transport;
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
    this.#destructive = new Set(
      tools.flatMap((t) => {
        const tool = t as { name?: unknown; annotations?: { destructiveHint?: unknown } } | null;
        return typeof tool?.name === 'string' && tool.annotations?.destructiveHint === true
          ? [tool.name]
          : [];
      }),
    );
  }

  async send(frame: Frame): Promise<Sent> {
    if (this.#stopped) return { sent: false, refusal: 'transport-stopped' };
    let isCall = false;
    if (frame.type === 'rpc') {
      if (frame.method === 'tools/call') {
        isCall = true;
        const name = frame.params?.['name'];
        const args = canonical(frame.params?.['arguments'] ?? {});
        const matches = this.#declared.filter(
          (e) => e.tool === name && canonical(e.arguments) === args,
        );
        if (matches.length === 0) return { sent: false, refusal: 'undeclared' };
        if (
          typeof name === 'string' &&
          this.#destructive.has(name) &&
          !matches.some((e) => e.allowDestructive === true)
        )
          return { sent: false, refusal: 'destructive' };
      } else if (!METHODS.has(frame.method)) return { sent: false, refusal: 'undeclared' };
    }
    if (this.#requests >= this.#maxRequests || (isCall && this.#calls >= this.#maxCalls))
      return { sent: false, refusal: 'budget' };
    this.#requests++;
    if (isCall) this.#calls++;
    const reply = await this.#transport(frame);
    const trouble = reply.kind === 'failure' || reply.status === 429 || reply.status >= 500;
    this.#failures = trouble ? this.#failures + 1 : 0;
    if (this.#failures >= TRANSPORT_FAILURES_IN_A_ROW) this.#stopped = true;
    return { sent: true, reply };
  }
}
