import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock @huggingface/transformers to the verified shape: pipeline() -> callable extractor ->
// returns a Tensor-like with .tolist() (number[][], one row per input text).
const { pipelineMock, extractorMock } = vi.hoisted(() => {
  const extractorMock = vi.fn();
  return { extractorMock, pipelineMock: vi.fn(async () => extractorMock) };
});

vi.mock('@huggingface/transformers', () => ({ pipeline: pipelineMock }));

import { getDefaultEmbedder, XenovaEmbedder } from '../embedder.js';

beforeEach(() => {
  pipelineMock.mockClear();
  extractorMock.mockReset();
  extractorMock.mockImplementation(async (texts: string[]) => ({
    tolist: () => texts.map((_, i) => [i + 1, 0, 0]),
    dims: [texts.length, 3],
  }));
});

describe('XenovaEmbedder (ADR-EMB02)', () => {
  it('embeds a batch into one Float32Array per input (AC-3)', async () => {
    const vecs = await new XenovaEmbedder().embed(['a', 'b']);
    expect(vecs).toHaveLength(2);
    expect(vecs[0]).toBeInstanceOf(Float32Array);
    expect(Array.from(vecs[0]!)).toEqual([1, 0, 0]);
    expect(Array.from(vecs[1]!)).toEqual([2, 0, 0]);
  });

  it('loads the pipeline only once across multiple embed calls', async () => {
    const emb = new XenovaEmbedder();
    await emb.embed(['x']);
    await emb.embed(['y']);
    expect(pipelineMock).toHaveBeenCalledTimes(1);
  });

  it('requests mean pooling + normalization', async () => {
    await new XenovaEmbedder().embed(['x']);
    expect(extractorMock).toHaveBeenCalledWith(['x'], { pooling: 'mean', normalize: true });
  });

  it('getDefaultEmbedder returns a usable embedder', async () => {
    const vecs = await getDefaultEmbedder().embed(['hello']);
    expect(vecs[0]).toBeInstanceOf(Float32Array);
  });
});
