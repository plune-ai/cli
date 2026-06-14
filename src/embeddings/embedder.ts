// Local embeddings via transformers.js (ADR-EMB02). Dirty edge: loads + runs the ONNX model.
// No external API; weights are fetched once and cached. In CI, @xenova/transformers is mocked.

import { pipeline } from '@huggingface/transformers';
import type { Embedder } from '../types/embedder.js';

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';

// Minimal shape we use (verified against @huggingface/transformers 4.2.0 — the maintained
// transformers.js; @xenova v2 was dropped for security, see ADR-EMB02): the feature-extraction
// pipeline resolves to a callable extractor returning a Tensor with .tolist().
type FeatureExtractor = (
  texts: string[],
  options: { pooling: 'mean'; normalize: boolean },
) => Promise<{ tolist(): unknown }>;

export class XenovaEmbedder implements Embedder {
  private extractor?: Promise<FeatureExtractor>;

  async embed(texts: string[]): Promise<Float32Array[]> {
    const extract = await this.load();
    const output = await extract(texts, { pooling: 'mean', normalize: true });
    const rows = output.tolist() as number[][];
    return rows.map((row) => Float32Array.from(row));
  }

  private load(): Promise<FeatureExtractor> {
    // Lazy: build the pipeline once and reuse it. The cast bridges the SDK's class type to the
    // call signature we rely on (the pipeline instance is callable at runtime).
    this.extractor ??= pipeline('feature-extraction', MODEL_ID) as unknown as Promise<FeatureExtractor>;
    return this.extractor;
  }
}

let defaultEmbedder: Embedder | undefined;

/** The production embedder; the orchestrator injects it into AssertionContext for semantic kinds. */
export function getDefaultEmbedder(): Embedder {
  return (defaultEmbedder ??= new XenovaEmbedder());
}
