// json-schema assertion (pure). Extracts JSON from the output (auto|strict) and validates it
// against the user-provided JSON Schema via ajv (ADR-AP02). A non-JSON output, an invalid
// schema, or a non-conforming value all yield passed:false + reason — never a thrown error.

import { Ajv, type Schema, type ValidateFunction } from 'ajv';
import type { Assertion, AssertionContext, AssertionResult } from '../types/assertion.js';
import type { JsonSchemaAssertion } from '../types/config.js';
import { extractJson } from './json-extract.js';

export const jsonSchema: Assertion<JsonSchemaAssertion> = {
  run(ctx: AssertionContext<JsonSchemaAssertion>): Promise<AssertionResult> {
    const mode = ctx.params.extract ?? 'auto';

    const extracted = extractJson(ctx.output, mode);
    if (!extracted.ok) {
      return Promise.resolve({
        passed: false,
        reason: `output is not valid JSON (extract mode: ${mode})`,
      });
    }

    // Fresh Ajv per call: user schemas may carry a $id, and reusing one instance across rows
    // would throw "schema already exists". Memoization is a future perf optimization.
    const ajv = new Ajv({ allErrors: true });
    let validate: ValidateFunction;
    try {
      // ctx.params.schema is a user-supplied JSON Schema document (typed `object` in config).
      validate = ajv.compile(ctx.params.schema as Schema);
    } catch (err) {
      return Promise.resolve({
        passed: false,
        reason: `invalid json-schema: ${(err as Error).message}`,
      });
    }

    if (validate(extracted.value)) {
      return Promise.resolve({ passed: true });
    }
    return Promise.resolve({
      passed: false,
      reason: `json-schema validation failed: ${ajv.errorsText(validate.errors, { separator: '; ' })}`,
    });
  },
};
