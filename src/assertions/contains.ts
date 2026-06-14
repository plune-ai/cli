// contains / contains-any / contains-all assertions (pure). Substring checks with optional
// case-insensitivity; string params are interpolated against the row before matching.

import type { Assertion, AssertionContext, AssertionResult } from '../types/assertion.js';
import type {
  ContainsAssertion,
  ContainsAnyAssertion,
  ContainsAllAssertion,
} from '../types/config.js';
import { interpolate } from './interpolate.js';

function norm(s: string, ignoreCase: boolean | undefined): string {
  return ignoreCase ? s.toLowerCase() : s;
}

export const contains: Assertion<ContainsAssertion> = {
  run(ctx: AssertionContext<ContainsAssertion>): Promise<AssertionResult> {
    const value = interpolate(ctx.params.value, ctx);
    const found = norm(ctx.output, ctx.params.ignore_case).includes(
      norm(value, ctx.params.ignore_case),
    );
    return Promise.resolve(
      found ? { passed: true } : { passed: false, reason: `expected output to contain: "${value}"` },
    );
  },
};

export const containsAny: Assertion<ContainsAnyAssertion> = {
  run(ctx: AssertionContext<ContainsAnyAssertion>): Promise<AssertionResult> {
    const hay = norm(ctx.output, ctx.params.ignore_case);
    const values = ctx.params.values.map((v) => interpolate(v, ctx));
    const found = values.some((v) => hay.includes(norm(v, ctx.params.ignore_case)));
    return Promise.resolve(
      found
        ? { passed: true }
        : { passed: false, reason: `expected output to contain any of: ${JSON.stringify(values)}` },
    );
  },
};

export const containsAll: Assertion<ContainsAllAssertion> = {
  run(ctx: AssertionContext<ContainsAllAssertion>): Promise<AssertionResult> {
    const hay = norm(ctx.output, ctx.params.ignore_case);
    const values = ctx.params.values.map((v) => interpolate(v, ctx));
    const missing = values.filter((v) => !hay.includes(norm(v, ctx.params.ignore_case)));
    return Promise.resolve(
      missing.length === 0
        ? { passed: true }
        : { passed: false, reason: `output is missing required substrings: ${JSON.stringify(missing)}` },
    );
  },
};
