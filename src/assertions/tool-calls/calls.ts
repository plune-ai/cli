// Which tools the model called, and with what: tool-called, tool-not-called, tool-args, only-tools. Deterministic and
// pure. A call counts once the model asked for it, whether or not it ran.

import type { AssertionContext } from '../../types/assertion.js';
import type {
  OnlyToolsAssertion,
  ToolArgsAssertion,
  ToolCalledAssertion,
  ToolNotCalledAssertion,
} from '../../types/config.js';
import { interpolate } from '../interpolate.js';
import {
  absence,
  callsFor,
  callsOf,
  check,
  checkNames,
  describeArgs,
  describeCalls,
  fail,
  pass,
  plural,
  sameJson,
  transcriptOf,
} from './transcript.js';

export const toolCalled = check<ToolCalledAssertion>((ctx) => {
  const { tool, min_count: min = 1 } = ctx.params;
  const t = transcriptOf('tool-called', ctx);
  checkNames('tool-called', t, [tool]);
  const calls = callsFor(t, tool);
  if (calls.length >= min) return pass;
  return fail(
    `expected "${tool}" called at least ${plural(min, 'time')}; got ${calls.length} (${describeCalls(callsOf(t))}); ` +
      `check that the tool's description tells the model when to use it`,
  );
});

export const toolNotCalled = check<ToolNotCalledAssertion>((ctx) => {
  const { tool } = ctx.params;
  const t = transcriptOf('tool-not-called', ctx);
  checkNames('tool-not-called', t, [tool]);
  const calls = callsFor(t, tool);
  if (calls.length === 0) return absence('tool-not-called', t, `a call to "${tool}"`, 'calls');
  return fail(
    `expected "${tool}" never called; got ${plural(calls.length, 'call')}: ${describeCalls(calls)}; ` +
      `check what in the prompt or the tool list led the model to it`,
  );
});

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Every expected key is in `actual` with a matching value; objects inside match the same way, the rest whole. */
function partialMatch(expected: unknown, actual: unknown): boolean {
  if (!isRecord(expected)) return sameJson(expected, actual);
  return (
    isRecord(actual) &&
    Object.entries(expected).every(
      ([k, v]) => Object.hasOwn(actual, k) && partialMatch(v, actual[k]),
    )
  );
}

/** `{{vars.x}}` and `{{expected}}` in every string of the expected arguments, at any depth. */
function interpolateDeep(value: unknown, ctx: AssertionContext<unknown>): unknown {
  if (typeof value === 'string') return interpolate(value, ctx);
  if (Array.isArray(value)) return value.map((v) => interpolateDeep(v, ctx));
  if (isRecord(value))
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolateDeep(v, ctx)]));
  return value;
}

export const toolArgs = check<ToolArgsAssertion>((ctx) => {
  const { tool, match = 'partial', min_count: min = 1 } = ctx.params;
  const t = transcriptOf('tool-args', ctx);
  checkNames('tool-args', t, [tool]);
  // A list is alternatives: a call that fits any one of them matches.
  const sets = (Array.isArray(ctx.params.args) ? ctx.params.args : [ctx.params.args]).map((a) =>
    interpolateDeep(a, ctx),
  );
  const matches = (actual: unknown): boolean =>
    match === 'ignore' ||
    sets.some((args) => (match === 'exact' ? sameJson(args, actual) : partialMatch(args, actual)));
  const calls = callsFor(t, tool);
  const hits = calls.filter((c) => matches(c.call.args)).length;
  if (hits >= min) return pass;
  return fail(
    `expected a call to "${tool}" with arguments ${sets.map(describeArgs).join(' or ')} (${match}) at least ${plural(min, 'time')}; ` +
      `got ${hits} of ${plural(calls.length, 'call')}: ${describeCalls(calls)}; ` +
      `check the argument names and values against the tool's input schema`,
  );
});

export const onlyTools = check<OnlyToolsAssertion>((ctx) => {
  const { tools } = ctx.params;
  const t = transcriptOf('only-tools', ctx);
  checkNames('only-tools', t, tools);
  const off = callsOf(t).filter((c) => !tools.includes(c.call.name));
  if (off.length === 0) return absence('only-tools', t, 'a call to another tool', 'calls');
  const allowed = tools.length > 0 ? `only ${tools.join(', ')} called` : 'no tool call';
  return fail(
    `expected ${allowed}; got ${describeCalls(off)}; check whether allowed_tools should leave the others out`,
  );
});
