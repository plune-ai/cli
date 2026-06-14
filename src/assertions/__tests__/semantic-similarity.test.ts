import { describe, expect, it } from 'vitest';
import { semanticSimilarity } from '../semantic-similarity.js';
import type { Embedder } from '../../types/embedder.js';
import type { SemanticSimilarityAssertion } from '../../types/config.js';
import type { AssertionContext } from '../../types/assertion.js';

// Mock embedder keyed by text → a fixed vector (deterministic; no model/network).
function mockEmbedder(map: Record<string, number[]>): Embedder {
  return {
    embed: async (texts) => texts.map((t) => Float32Array.from(map[t] ?? [0, 0, 0])),
  };
}

function ctx(
  output: string,
  reference: string,
  embedder: Embedder | undefined,
  opts: { threshold?: number; expected?: string } = {},
): AssertionContext<SemanticSimilarityAssertion> {
  return {
    output,
    vars: {},
    row: { vars: {}, ...(opts.expected !== undefined ? { expected: opts.expected } : {}) },
    params: {
      type: 'semantic-similarity',
      reference,
      ...(opts.threshold !== undefined ? { threshold: opts.threshold } : {}),
    },
    ...(embedder !== undefined ? { embedder } : {}),
  };
}

describe('semantic-similarity (ADR-EMB01)', () => {
  it('passes when cosine >= threshold and sets score (AC-6)', async () => {
    const emb = mockEmbedder({ out: [1, 0, 0], ref: [1, 0, 0] });
    const r = await semanticSimilarity.run(ctx('out', 'ref', emb));
    expect(r.passed).toBe(true);
    expect(r.score).toBeCloseTo(1);
  });

  it('fails when cosine < threshold, with reason + score (AC-7)', async () => {
    const emb = mockEmbedder({ out: [1, 0, 0], ref: [0, 1, 0] });
    const r = await semanticSimilarity.run(ctx('out', 'ref', emb, { threshold: 0.8 }));
    expect(r.passed).toBe(false);
    expect(r.score).toBeCloseTo(0);
    expect(r.reason).toBeTruthy();
  });

  it('uses the default threshold of 0.8', async () => {
    const emb = mockEmbedder({ out: [1, 0, 0], ref: [0.6, 0.8, 0] }); // cosine 0.6 < 0.8
    const r = await semanticSimilarity.run(ctx('out', 'ref', emb));
    expect(r.passed).toBe(false);
  });

  it('interpolates {{expected}} in reference before embedding (AC-8)', async () => {
    const emb = mockEmbedder({ out: [1, 0, 0], 'ref-text': [1, 0, 0] });
    const r = await semanticSimilarity.run(ctx('out', '{{expected}}', emb, { expected: 'ref-text' }));
    expect(r.passed).toBe(true);
  });

  it('throws when no embedder is present in the context', async () => {
    await expect(semanticSimilarity.run(ctx('out', 'ref', undefined))).rejects.toThrow();
  });

  it('throws a clear error if the embedder returns fewer vectors than inputs (review fix)', async () => {
    const shortEmbedder: Embedder = { embed: async () => [Float32Array.from([1, 0, 0])] };
    await expect(semanticSimilarity.run(ctx('out', 'ref', shortEmbedder))).rejects.toThrow(
      /expected 2/,
    );
  });

  it('handles a reference that interpolates to empty string', async () => {
    const emb = mockEmbedder({ out: [1, 0, 0], '': [1, 0, 0] });
    // {{expected}} with no row.expected -> '' (interpolate policy); must not crash.
    const r = await semanticSimilarity.run(ctx('out', '{{expected}}', emb));
    expect(typeof r.score).toBe('number');
  });
});
