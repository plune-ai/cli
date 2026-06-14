// answer-relevance assertion (RAGAS-style, ADR-SR02). The LLM generates questions the output
// answers; we embed them and measure mean cosine similarity to the original question.

import type { Assertion, AssertionContext, AssertionResult } from '../types/assertion.js';
import type { AnswerRelevanceAssertion } from '../types/config.js';
import { interpolate } from './interpolate.js';
import { askJson, parseQuestions } from './judge-helpers.js';
import { cosine } from '../embeddings/cosine.js';

const DEFAULT_THRESHOLD = 0.7;

function prompt(output: string): string {
  return (
    'Generate the questions that the OUTPUT directly and fully answers. ' +
    'Respond ONLY with JSON: {"questions": ["<question>", ...]}.\n\n' +
    `OUTPUT:\n${output}`
  );
}

export const answerRelevance: Assertion<AnswerRelevanceAssertion> = {
  async run(ctx: AssertionContext<AnswerRelevanceAssertion>): Promise<AssertionResult> {
    if (ctx.judge === undefined) {
      throw new Error('answer-relevance requires a judge in the AssertionContext');
    }
    if (ctx.embedder === undefined) {
      throw new Error('answer-relevance requires an embedder in the AssertionContext');
    }
    const question = interpolate(ctx.params.question, ctx);
    const threshold = ctx.params.threshold ?? DEFAULT_THRESHOLD;

    const questions = parseQuestions(await askJson(ctx.judge, prompt(ctx.output)));
    if (questions.length === 0) {
      return { passed: false, score: 0, reason: 'judge generated no questions from the output' };
    }

    const vecs = await ctx.embedder.embed([question, ...questions]);
    if (vecs.length < questions.length + 1) {
      throw new Error(
        `answer-relevance: embedder returned ${vecs.length} vectors, expected ${questions.length + 1}`,
      );
    }
    let sum = 0;
    for (let i = 0; i < questions.length; i++) {
      sum += cosine(vecs[0]!, vecs[i + 1]!);
    }
    // cosine ∈ [-1, 1]; floor the mean at 0 so score stays in the documented 0..1 range (RAGAS convention).
    const score = Math.max(0, sum / questions.length);

    const passed = score >= threshold;
    return passed
      ? { passed: true, score }
      : { passed: false, score, reason: `answer-relevance ${score.toFixed(3)} < threshold ${threshold}` };
  },
};
