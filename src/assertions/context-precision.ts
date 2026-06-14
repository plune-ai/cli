// context-precision assertion (RAGAS-style, ADR-SR02). The LLM judges how well the context
// supplies what is needed to answer the question.

import type { Assertion, AssertionContext, AssertionResult } from '../types/assertion.js';
import type { ContextPrecisionAssertion } from '../types/config.js';
import { interpolate } from './interpolate.js';
import { askJson, parseScored } from './judge-helpers.js';

const DEFAULT_THRESHOLD = 0.7;

function prompt(context: string, question: string): string {
  return (
    'Judge from 0 to 1 how well the CONTEXT provides the information needed to answer the QUESTION. ' +
    'Respond ONLY with JSON: {"score": <0..1>, "reason": "<short explanation>"}.\n\n' +
    `QUESTION: ${question}\n\nCONTEXT:\n${context}`
  );
}

export const contextPrecision: Assertion<ContextPrecisionAssertion> = {
  async run(ctx: AssertionContext<ContextPrecisionAssertion>): Promise<AssertionResult> {
    if (ctx.judge === undefined) {
      throw new Error('context-precision requires a judge in the AssertionContext');
    }
    const context = interpolate(ctx.params.context, ctx);
    const question = interpolate(ctx.params.question, ctx);
    const threshold = ctx.params.threshold ?? DEFAULT_THRESHOLD;

    const { score, reason } = parseScored(await askJson(ctx.judge, prompt(context, question)));
    const passed = score >= threshold;
    return {
      passed,
      score,
      reason: reason ?? `context-precision ${score.toFixed(3)} vs threshold ${threshold}`,
    };
  },
};
