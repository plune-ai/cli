// faithfulness assertion (RAGAS-style, ADR-SR02). Fraction of the output's claims supported by context.

import type { Assertion, AssertionContext, AssertionResult } from '../types/assertion.js';
import type { FaithfulnessAssertion } from '../types/config.js';
import { interpolate } from './interpolate.js';
import { askJson, parseStatements } from './judge-helpers.js';

const DEFAULT_THRESHOLD = 0.7;

function prompt(context: string, output: string): string {
  return (
    'Extract the atomic factual claims from the OUTPUT and judge whether each is supported by the ' +
    'CONTEXT. Respond ONLY with JSON: {"statements":[{"claim":"<text>","faithful":<true|false>}]}.\n\n' +
    `CONTEXT:\n${context}\n\nOUTPUT:\n${output}`
  );
}

export const faithfulness: Assertion<FaithfulnessAssertion> = {
  async run(ctx: AssertionContext<FaithfulnessAssertion>): Promise<AssertionResult> {
    if (ctx.judge === undefined) {
      throw new Error('faithfulness requires a judge in the AssertionContext');
    }
    const context = interpolate(ctx.params.context, ctx);
    const threshold = ctx.params.threshold ?? DEFAULT_THRESHOLD;

    const flags = parseStatements(await askJson(ctx.judge, prompt(context, ctx.output)));
    // No extractable claims → nothing can contradict the context → vacuously faithful.
    const score = flags.length === 0 ? 1 : flags.filter((f) => f).length / flags.length;
    const passed = score >= threshold;
    return passed
      ? { passed: true, score }
      : { passed: false, score, reason: `faithfulness ${score.toFixed(3)} < threshold ${threshold}` };
  },
};
