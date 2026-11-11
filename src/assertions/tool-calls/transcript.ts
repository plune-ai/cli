// What every tool-call assertion shares: the calls of a transcript in order, the tool names a check may use, the two
// ways a check ends the row errored (not measured, unknown tool), and the failure text. Pure: no I/O.

import { redactSecrets } from '../../providers/errors.js';
import { canonicalJson } from '../../util/canonical-json.js';
import type { Assertion, AssertionContext, AssertionResult } from '../../types/assertion.js';
import type { AgentCall, AgentTranscript } from '../../types/results.js';

/**
 * Thrown by an assertion that cannot give a verdict; the row ends errored with `code` (`toRunError`), and the
 * assertions after it in the row are not run. `ASSERTION_UNMEASURED`: nothing was measured that could pass it;
 * `ASSERTION_UNKNOWN_TOOL`: it names a tool the model was not offered.
 */
export class AssertionRunError extends Error {
  constructor(
    readonly code: 'ASSERTION_UNMEASURED' | 'ASSERTION_UNKNOWN_TOOL',
    message: string,
  ) {
    super(message);
    this.name = 'AssertionRunError';
  }
}

const AFTER = ' The assertions after it in this row were not run.';

/** A check written as a plain function: what it throws (not measured, unknown tool) becomes the rejection. */
export function check<P>(body: (ctx: AssertionContext<P>) => AssertionResult): Assertion<P> {
  return {
    run(ctx) {
      try {
        return Promise.resolve(body(ctx));
      } catch (err) {
        return Promise.reject(err as Error);
      }
    },
  };
}

export const pass: AssertionResult = { passed: true };
export const fail = (reason: string): AssertionResult => ({ passed: false, reason });

export function unmeasured(type: string, why: string): AssertionRunError {
  return new AssertionRunError(
    'ASSERTION_UNMEASURED',
    `${type}: not measured because ${why}.${AFTER}`,
  );
}

/** One call with the step it was asked for in. */
export interface StepCall {
  step: number;
  call: AgentCall;
}

/** The row's transcript; without one (an eval without `mcp`) the check has nothing to read. */
export function transcriptOf(type: string, ctx: AssertionContext<unknown>): AgentTranscript {
  if (ctx.transcript === undefined)
    throw unmeasured(type, 'there is no tool loop to read (the eval has no mcp block)');
  return ctx.transcript;
}

/** Every call the model asked for, in order, whether or not it ran. */
export function callsOf(t: AgentTranscript): StepCall[] {
  return t.steps.flatMap((s) => s.calls.map((call) => ({ step: s.index, call })));
}

/** The calls of `tool`, or all of them when it is left out. */
export function callsFor(t: AgentTranscript, tool: string | undefined): StepCall[] {
  const all = callsOf(t);
  return tool === undefined ? all : all.filter((c) => c.call.name === tool);
}

/**
 * Every name must be one the model was offered: a misspelt `tool-not-called` would otherwise pass forever. Throws
 * `ASSERTION_UNKNOWN_TOOL` with the names that were offered.
 */
export function checkNames(type: string, t: AgentTranscript, names: (string | undefined)[]): void {
  const offered = t.tools.filter((x) => x.offered).map((x) => x.name);
  const unknown = names.find((n) => n !== undefined && !offered.includes(n));
  if (unknown === undefined) return;
  const list = offered.length > 0 ? offered.join(', ') : '(none)';
  throw new AssertionRunError(
    'ASSERTION_UNKNOWN_TOOL',
    `${type}: no tool "${unknown}" was offered to the model; offered: ${list}.${AFTER}`,
  );
}

/**
 * A negative check that found nothing passes on a complete transcript. On a partial one, what was not seen may hold
 * the violation, so it is not measured. (A finding fails whatever the collection: it is there.)
 *
 * `reads` says what the check looks at. `calls`: the names, arguments and flags of the calls, and the tool list. A cut
 * excerpt shortens only texts and never drops a call (the loop records every call the model asked for), so on a loop
 * that ended on its own the calls are all there, and the check is measured. `text`: the texts of answers or steps,
 * which a cut excerpt hides, so it is not measured then. A loop stopped by a limit or an error is unmeasured for both.
 */
export function absence(
  type: string,
  t: AgentTranscript,
  what: string,
  reads: 'calls' | 'text',
): AssertionResult {
  if (t.collection === 'complete' || (reads === 'calls' && t.stop.reason === 'complete'))
    return pass;
  const why =
    t.stop.reason === 'limit'
      ? `the loop was stopped by ${t.stop.limit ?? 'a limit'}`
      : 'the transcript is partial (a stored excerpt was cut)';
  throw unmeasured(
    type,
    `${why}, so ${what} may be in what was not seen; nothing was found in what was`,
  );
}

const ARGS_CHARS = 80;
const LISTED = 5;

/** Arguments as JSON, masked and cut to a readable length. */
export function describeArgs(args: unknown): string {
  const text = redactSecrets(JSON.stringify(args) ?? 'undefined');
  return text.length > ARGS_CHARS ? `${text.slice(0, ARGS_CHARS)} (cut)` : text;
}

/** `step 2 search {"q":"x"}`: never the result. */
export function describeCall({ step, call }: StepCall): string {
  return `step ${step} ${call.name} ${describeArgs(call.args)}`;
}

/** Up to five calls, then how many more. */
export function describeCalls(
  calls: StepCall[],
  detail: (c: StepCall) => string = describeCall,
): string {
  if (calls.length === 0) return 'no tool call';
  const shown = calls.slice(0, LISTED).map(detail).join('; ');
  return calls.length > LISTED ? `${shown} (and ${calls.length - LISTED} more)` : shown;
}

export const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Both are JSON values; equal when they serialize alike, key order aside. A missing value equals nothing. */
export function sameJson(a: unknown, b: unknown): boolean {
  return a !== undefined && b !== undefined && canonicalJson(a) === canonicalJson(b);
}
