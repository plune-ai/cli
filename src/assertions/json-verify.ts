// json-verify assertion (pure). Extracts JSON from the output as json-schema does (auto|strict) and compares
// it with the expected JSON value of the check (src/json-verify). An output with no JSON, or one that differs,
// is passed:false with a reason; the reason of a difference is the mismatch text, path by path.

import type { Assertion, AssertionContext, AssertionResult } from '../types/assertion.js';
import type { JsonVerifyAssertion } from '../types/config.js';
import { compareJson } from '../json-verify/compare.js';
import { formatMismatches } from '../json-verify/format.js';
import { extractJson } from './json-extract.js';

export const jsonVerify: Assertion<JsonVerifyAssertion> = {
  run(ctx: AssertionContext<JsonVerifyAssertion>): Promise<AssertionResult> {
    const extract = ctx.params.extract ?? 'auto';
    const extracted = extractJson(ctx.output, extract);
    if (!extracted.ok) {
      return Promise.resolve({
        passed: false,
        reason: `output is not valid JSON (extract mode: ${extract})`,
      });
    }

    // The config schema has checked `expected`, so a broken marker or check cannot reach this call.
    const mismatches = compareJson(ctx.params.expected, extracted.value, { mode: ctx.params.mode ?? 'exact' });
    return Promise.resolve(
      mismatches.length === 0 ? { passed: true } : { passed: false, reason: formatMismatches(mismatches) },
    );
  },
};
