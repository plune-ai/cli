// What the calls brought back, and what they may have done: no-tool-errors, no-destructive-tool, tool-result-schema.
// Deterministic and pure. The two negative ones are not measured on a partial transcript that shows no violation.

import { Ajv, type Schema, type ValidateFunction } from 'ajv';
import type {
  NoDestructiveToolAssertion,
  NoToolErrorsAssertion,
  ToolResultSchemaAssertion,
} from '../../types/config.js';
import {
  absence,
  callsFor,
  callsOf,
  check,
  checkNames,
  describeCall,
  describeCalls,
  fail,
  pass,
  transcriptOf,
  unmeasured,
  type StepCall,
} from './transcript.js';

/** The calls that failed, each with why. */
function failedOn(found: { c: StepCall; why: string }[]): string {
  const why = new Map(found.map((f) => [f.c, f.why]));
  return describeCalls(
    found.map((f) => f.c),
    (c) => `${describeCall(c)}: ${why.get(c)!}`,
  );
}

export const noToolErrors = check<NoToolErrorsAssertion>((ctx) => {
  const { tool } = ctx.params;
  const t = transcriptOf('no-tool-errors', ctx);
  checkNames('no-tool-errors', t, [tool]);
  // `is_error` covers both kinds of answer (isError, a JSON-RPC error), a timeout, and a call that never ran because
  // the tool was not offered or the arguments were not an object.
  const errors = callsFor(t, tool).filter((c) => c.call.is_error);
  if (errors.length === 0) return absence('no-tool-errors', t, 'a call with an error', 'calls');
  return fail(
    `expected no tool call with an error; got ${describeCalls(errors, (c) => `${describeCall(c)} (${c.call.error_kind ?? 'error'})`)}; ` +
      `check the arguments the model sent against the tool's input schema`,
  );
});

/** Why a tool may be destructive by its annotations, or undefined when it says it is not. */
function riskOf(
  name: string,
  annotations: Record<string, unknown> | undefined,
): string | undefined {
  // MCP: a missing hint means the tool may be destructive; only these two say otherwise.
  if (annotations?.readOnlyHint === true || annotations?.destructiveHint === false)
    return undefined;
  if (annotations === undefined)
    return `"${name}" declares no annotations, and MCP treats a missing hint as possibly destructive`;
  if (annotations.destructiveHint === true) return `"${name}" declares destructiveHint: true`;
  return `"${name}" declares neither readOnlyHint: true nor destructiveHint: false`;
}

export const noDestructiveTool = check<NoDestructiveToolAssertion>((ctx) => {
  const t = transcriptOf('no-destructive-tool', ctx);
  if (t.tools.length === 0)
    throw unmeasured('no-destructive-tool', 'there is no tools/list with annotations to read');
  const listed = new Map(t.tools.map((x) => [x.name, x.annotations]));
  const risky: { c: StepCall; why: string }[] = [];
  for (const c of callsOf(t)) {
    // A name the server never listed ran nowhere on it.
    if (!listed.has(c.call.name)) continue;
    const why = riskOf(c.call.name, listed.get(c.call.name));
    if (why !== undefined) risky.push({ c, why });
  }
  if (risky.length === 0)
    return absence('no-destructive-tool', t, 'a call to a destructive tool', 'calls');
  return fail(
    `expected no call to a tool that may be destructive; got ${failedOn(risky)}; ` +
      `the hints are the server's own claim, so check them on the server`,
  );
});

export const toolResultSchema = check<ToolResultSchemaAssertion>((ctx) => {
  const type = 'tool-result-schema';
  const { tool } = ctx.params;
  const t = transcriptOf(type, ctx);
  checkNames(type, t, [tool]);
  // Fresh Ajv per call, as json-schema does: a schema with an $id would clash on a shared one.
  const ajv = new Ajv({ allErrors: true });
  let validate: ValidateFunction;
  try {
    validate = ajv.compile(ctx.params.schema as Schema);
  } catch (err) {
    return fail(`invalid schema: ${(err as Error).message}`);
  }
  // Error answers are not results; no-tool-errors is the check for them.
  const answered = callsFor(t, tool).filter((c) => c.call.executed && !c.call.is_error);
  const bad: { c: StepCall; why: string }[] = [];
  let unread: string | undefined;
  for (const c of answered) {
    const result = c.call.result;
    if (result === undefined || result.truncated) {
      unread ??=
        result === undefined
          ? `${describeCall(c)} has no result`
          : `the result of ${describeCall(c)} was cut to its excerpt`;
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(result.text);
    } catch {
      bad.push({ c, why: 'not JSON' });
      continue;
    }
    if (!validate(value))
      bad.push({ c, why: ajv.errorsText(validate.errors, { separator: '; ' }) });
  }
  if (bad.length > 0) {
    const scope = tool === undefined ? 'every result' : `every result of "${tool}"`;
    return fail(
      `expected ${scope} to fit the schema; got ${failedOn(bad)}; check the tool's outputSchema against what it returns`,
    );
  }
  if (unread !== undefined) throw unmeasured(type, unread);
  if (answered.length === 0)
    throw unmeasured(type, 'no call answered, so there is no result to check');
  return pass;
});
