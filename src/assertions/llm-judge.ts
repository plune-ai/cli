// llm-judge assertion (ADR-SR02). An LLM judge scores the output against a free-text criterion.

import type { Assertion, AssertionContext, AssertionResult } from '../types/assertion.js';
import type { LlmJudgeAssertion } from '../types/config.js';
import { interpolate } from './interpolate.js';
import { askJson, parseScored } from './judge-helpers.js';

const DEFAULT_PASS_THRESHOLD = 0.5;

function prompt(criteria: string, output: string): string {
  return (
    'You are a strict evaluator. Score from 0 to 1 how well the OUTPUT meets the CRITERIA. ' +
    'Respond ONLY with JSON: {"score": <0..1>, "reason": "<short explanation>"}.\n\n' +
    `CRITERIA: ${criteria}\n\nOUTPUT:\n${output}`
  );
}

export const llmJudge: Assertion<LlmJudgeAssertion> = {
  async run(ctx: AssertionContext<LlmJudgeAssertion>): Promise<AssertionResult> {
    if (ctx.judge === undefined) {
      throw new Error('llm-judge requires a judge in the AssertionContext');
    }
    const criteria = interpolate(ctx.params.criteria, ctx);
    const threshold = ctx.params.pass_threshold ?? DEFAULT_PASS_THRESHOLD;

    const { score, reason } = parseScored(await askJson(ctx.judge, prompt(criteria, ctx.output)));
    const passed = score >= threshold;
    return {
      passed,
      score,
      reason: reason ?? `score ${score.toFixed(3)} vs threshold ${threshold}`,
    };
  },
};
