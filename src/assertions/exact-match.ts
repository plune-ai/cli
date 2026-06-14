// exact-match assertion (pure). Compares output to an (interpolated) expected value.

import type { Assertion, AssertionContext, AssertionResult } from '../types/assertion.js';
import type { ExactMatchAssertion } from '../types/config.js';
import { interpolate } from './interpolate.js';

export const exactMatch: Assertion<ExactMatchAssertion> = {
  run(ctx: AssertionContext<ExactMatchAssertion>): Promise<AssertionResult> {
    const expected = interpolate(ctx.params.value, ctx);
    let actual = ctx.output;
    let target = expected;

    if (ctx.params.trim) {
      actual = actual.trim();
      target = target.trim();
    }
    if (ctx.params.ignore_case) {
      actual = actual.toLowerCase();
      target = target.toLowerCase();
    }

    const result: AssertionResult =
      actual === target
        ? { passed: true }
        : { passed: false, reason: `expected exact match: "${expected}"` };
    return Promise.resolve(result);
  },
};
