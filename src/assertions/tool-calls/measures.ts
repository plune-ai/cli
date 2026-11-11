// Numbers against a threshold the author sets: tool-call-count, token-budget, tool-latency, tool-result-size. Pure.
// A measure with nothing to measure is not measured, never passed; a value over the line fails even when other
// values could not be read.

import type { AssertionResult } from '../../types/assertion.js';
import type {
  TokenBudgetAssertion,
  ToolCallCountAssertion,
  ToolLatencyAssertion,
  ToolResultSizeAssertion,
} from '../../types/config.js';
import {
  callsFor,
  check,
  checkNames,
  describeCall,
  describeCalls,
  fail,
  pass,
  plural,
  transcriptOf,
  unmeasured,
  type StepCall,
} from './transcript.js';

export const toolCallCount = check<ToolCallCountAssertion>((ctx) => {
  const { tool, min, max } = ctx.params;
  const t = transcriptOf('tool-call-count', ctx);
  checkNames('tool-call-count', t, [tool]);
  const calls = callsFor(t, tool);
  const n = calls.length;
  if ((min === undefined || n >= min) && (max === undefined || n <= max)) return pass;
  // The schema asks for at least one of the two.
  const bound =
    min === undefined
      ? `at most ${plural(max!, 'call')}`
      : max === undefined
        ? `at least ${plural(min, 'call')}`
        : `${min} to ${max} calls`;
  const of = tool === undefined ? '' : ` to "${tool}"`;
  return fail(
    `expected ${bound}${of}; got ${n}: ${describeCalls(calls)}; check the limits and whether the model had what it needed`,
  );
});

export const tokenBudget = check<TokenBudgetAssertion>((ctx) => {
  const { max } = ctx.params;
  const t = transcriptOf('token-budget', ctx);
  if (t.steps.length === 0)
    throw unmeasured('token-budget', 'no model step was recorded, so there are no tokens to count');
  const per = t.steps.map((s) => ({
    step: s.index,
    tokens: s.usage.input_tokens + s.usage.output_tokens,
  }));
  const total = per.reduce((a, s) => a + s.tokens, 0);
  if (total <= max) return pass;
  const steps = per.map((s) => `step ${s.step}: ${s.tokens}`).join(', ');
  return fail(
    `expected at most ${max} tokens (input + output, every step); got ${total} (${steps}); ` +
      `check the size of the tool descriptions and results the model reads every step`,
  );
});

/**
 * A bound on every call that ran: one over it fails the check; else a call without the value, or no call that ran,
 * leaves it unmeasured.
 */
function eachCall(
  type: string,
  calls: StepCall[],
  value: (c: StepCall) => number | undefined,
  bound: { max: number; unit: string; expected: string; hint: string },
): AssertionResult {
  const ran = calls.filter((c) => c.call.executed);
  const over = ran.filter((c) => (value(c) ?? 0) > bound.max);
  if (over.length > 0)
    return fail(
      `expected ${bound.expected}; got ${describeCalls(over, (c) => `${describeCall(c)}: ${value(c)!} ${bound.unit}`)}; ${bound.hint}`,
    );
  const missing = ran.find((c) => value(c) === undefined);
  if (missing !== undefined)
    throw unmeasured(type, `${describeCall(missing)} ran and its ${bound.unit} were not recorded`);
  if (ran.length === 0) throw unmeasured(type, 'no call ran, so there is nothing to measure');
  return pass;
}

export const toolLatency = check<ToolLatencyAssertion>((ctx) => {
  const { tool, max_ms: max } = ctx.params;
  const t = transcriptOf('tool-latency', ctx);
  checkNames('tool-latency', t, [tool]);
  const scope = tool === undefined ? 'every call' : `every call to "${tool}"`;
  return eachCall('tool-latency', callsFor(t, tool), (c) => c.call.duration_ms, {
    max,
    unit: 'ms',
    expected: `${scope} within ${max} ms`,
    hint: 'check the server for what makes the call slow',
  });
});

export const toolResultSize = check<ToolResultSizeAssertion>((ctx) => {
  const { tool, max_bytes: max } = ctx.params;
  const t = transcriptOf('tool-result-size', ctx);
  checkNames('tool-result-size', t, [tool]);
  const scope = tool === undefined ? 'every result' : `every result of "${tool}"`;
  // `bytes` is the whole answer as the server sent it, measured before the transcript cut it to an excerpt.
  return eachCall('tool-result-size', callsFor(t, tool), (c) => c.call.result?.bytes, {
    max,
    unit: 'bytes',
    expected: `${scope} at most ${max} bytes`,
    hint: 'check whether the tool can page or filter what it returns',
  });
});
