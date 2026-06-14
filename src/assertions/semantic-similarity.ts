// semantic-similarity assertion (ADR-EMB01). Compares output vs an (interpolated) reference by
// embedding cosine similarity. Gets the embedder via ctx (DI); never imports it directly.

import type { Assertion, AssertionContext, AssertionResult } from '../types/assertion.js';
import type { SemanticSimilarityAssertion } from '../types/config.js';
import { interpolate } from './interpolate.js';
import { cosine } from '../embeddings/cosine.js';

const DEFAULT_THRESHOLD = 0.8;

export const semanticSimilarity: Assertion<SemanticSimilarityAssertion> = {
  async run(ctx: AssertionContext<SemanticSimilarityAssertion>): Promise<AssertionResult> {
    if (ctx.embedder === undefined) {
      // Wiring error: the orchestrator must inject an embedder for semantic kinds (fail loud).
      throw new Error('semantic-similarity requires an embedder in the AssertionContext');
    }

    const reference = interpolate(ctx.params.reference, ctx);
    const threshold = ctx.params.threshold ?? DEFAULT_THRESHOLD;

    const vecs = await ctx.embedder.embed([ctx.output, reference]);
    const [outVec, refVec] = vecs;
    if (outVec === undefined || refVec === undefined) {
      // Embedder contract: one vector per input. Surface a clear error, not a cryptic crash.
      throw new Error(`semantic-similarity: embedder returned ${vecs.length} vector(s), expected 2`);
    }
    const score = cosine(outVec, refVec);

    return score >= threshold
      ? { passed: true, score }
      : {
          passed: false,
          score,
          reason: `similarity ${score.toFixed(3)} < threshold ${threshold}`,
        };
  },
};
