// llm-judge assertion (ADR-SR02). An LLM judge scores the output against a free-text criterion.

import type { Assertion, AssertionContext, AssertionResult } from '../types/assertion.js';
import type { LlmJudgeAssertion } from '../types/config.js';
import { interpolate } from './interpolate.js';
import { askJson, parseScored } from './judge-helpers.js';

const DEFAULT_PASS_THRESHOLD = 0.5;

// With the input (the text the model answered) the judge can tell whether the OUTPUT
// answers it (plune-ai/cli#374). Without one the prompt is as before.
function prompt(criteria: string, output: string, input: string | undefined): string {
  const given =
    input === undefined
      ? ''
      : 'The OUTPUT is the answer to the INPUT; the CRITERIA are about the OUTPUT given that INPUT. ';
  return (
    'You are a strict evaluator. Score from 0 to 1 how well the OUTPUT meets the CRITERIA. ' +
    given +
    'Respond ONLY with JSON: {"score": <0..1>, "reason": "<short explanation>"}.\n\n' +
    `CRITERIA: ${criteria}\n\n` +
    (input === undefined ? '' : `INPUT:\n${input}\n\n`) +
    `OUTPUT:\n${output}`
  );
}

export const llmJudge: Assertion<LlmJudgeAssertion> = {
  async run(ctx: AssertionContext<LlmJudgeAssertion>): Promise<AssertionResult> {
    if (ctx.judge === undefined) {
      throw new Error('llm-judge requires a judge in the AssertionContext');
    }
    const criteria = interpolate(ctx.params.criteria, ctx);
    const threshold = ctx.params.pass_threshold ?? DEFAULT_PASS_THRESHOLD;

    // A decision judge (the experimental `jev`) answers with a probability and nothing else: the score is that
    // probability, and the reason says so rather than invent one.
    if (ctx.judge.decide !== undefined) {
      const { probability: p } = await ctx.judge.decide({
        criteria,
        output: ctx.output,
        ...(ctx.input !== undefined ? { input: ctx.input } : {}),
      });
      return {
        passed: p >= threshold,
        score: p,
        reason: `probability ${p.toFixed(3)} that the answer meets the criteria vs threshold ${threshold}; this judge gives no reason`,
      };
    }

    const { score, reason } = parseScored(
      await askJson(ctx.judge, prompt(criteria, ctx.output, ctx.input)),
    );
    const passed = score >= threshold;
    return {
      passed,
      score,
      reason: reason ?? `score ${score.toFixed(3)} vs threshold ${threshold}`,
    };
  },
};
