// In what order the model called its tools: tool-order and first-tool (deterministic), and no-repeated-call (a
// heuristic: the orchestrator files what it finds as advice, never as a verdict). Pure.

import type {
  FirstToolAssertion,
  NoRepeatedCallAssertion,
  ToolOrderAssertion,
} from '../../types/config.js';
import {
  callsOf,
  check,
  checkNames,
  describeCall,
  describeCalls,
  fail,
  pass,
  transcriptOf,
} from './transcript.js';
import { isIdenticalCall } from '../../util/tool-calls.js';

/** `tools` as a subsequence of `names`: each one found after the one before it. */
function inOrder(names: string[], tools: string[]): boolean {
  let next = 0;
  for (const n of names) if (n === tools[next]) next++;
  return next === tools.length;
}

export const toolOrder = check<ToolOrderAssertion>((ctx) => {
  const { tools, strict = false } = ctx.params;
  const t = transcriptOf('tool-order', ctx);
  checkNames('tool-order', t, tools);
  const calls = callsOf(t);
  const names = calls.map((c) => c.call.name);
  const ok = strict
    ? names.length === tools.length && names.every((n, i) => n === tools[i])
    : inOrder(names, tools);
  if (ok) return pass;
  const wanted = tools.join(' → ');
  return fail(
    `expected ${strict ? `exactly the calls ${wanted}` : `calls in the order ${wanted}`}; got ${describeCalls(calls)}; ` +
      `check whether the model had what it needed for each step before it`,
  );
});

export const firstTool = check<FirstToolAssertion>((ctx) => {
  const { tool } = ctx.params;
  const t = transcriptOf('first-tool', ctx);
  checkNames('first-tool', t, [tool]);
  const first = callsOf(t)[0];
  if (first?.call.name === tool) return pass;
  const got =
    first === undefined
      ? 'no tool call at all: the model answered without one'
      : describeCall(first);
  return fail(
    `expected the first call to be "${tool}"; got ${got}; check that the prompt and the tool's description point the model to it first`,
  );
});

export const noRepeatedCall = check<NoRepeatedCallAssertion>((ctx) => {
  const { tool } = ctx.params;
  const t = transcriptOf('no-repeated-call', ctx);
  checkNames('no-repeated-call', t, [tool]);
  const calls = callsOf(t);
  // The same name and the same arguments right after each other. Any changed argument, a cursor too, is not a repeat.
  for (let i = 1; i < calls.length; i++) {
    const [prev, cur] = [calls[i - 1]!, calls[i]!];
    if (tool !== undefined && cur.call.name !== tool) continue;
    if (isIdenticalCall(prev.call, cur.call))
      return fail(
        `expected no call repeated right after itself; got ${describeCall(prev)} then ${describeCall(cur)}; ` +
          `check whether the first answer told the model what it needed`,
      );
  }
  return pass;
});
