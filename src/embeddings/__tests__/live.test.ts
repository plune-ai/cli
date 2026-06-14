import { describe, it, expect } from 'vitest';

// Opt-in live suite (AC-5/AC-10): runs the real local model. Default CI skips it entirely.
// IMPORTANT: the embedder (and @xenova/transformers, which pulls native `sharp`) is imported
// DYNAMICALLY inside each test, so a skipped run never loads it — keeping the default suite
// free of model downloads and native builds. Run with PLUNE_LIVE=1.
const LIVE = process.env.PLUNE_LIVE === '1';

describe.skipIf(!LIVE)('embeddings live (PLUNE_LIVE=1)', () => {
  it('embeds text into a fixed-dimension vector, deterministically', async () => {
    const { getDefaultEmbedder } = await import('../embedder.js');
    const emb = getDefaultEmbedder();
    const [v1] = await emb.embed(['hello world']);
    const [v2] = await emb.embed(['hello world']);
    expect(v1).toBeInstanceOf(Float32Array);
    expect(v1!.length).toBeGreaterThan(0);
    expect(Array.from(v1!)).toEqual(Array.from(v2!)); // same text → same vector
  });

  it('scores related text higher than unrelated text', async () => {
    const { getDefaultEmbedder } = await import('../embedder.js');
    const { cosine } = await import('../cosine.js');
    const emb = getDefaultEmbedder();
    const [a, b, c] = await emb.embed([
      'a cat sat on the mat',
      'a feline rested on the rug',
      'quarterly corporate tax filing deadline',
    ]);
    expect(cosine(a!, b!)).toBeGreaterThan(cosine(a!, c!));
  });
});
