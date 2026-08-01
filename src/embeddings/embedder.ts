// Local embeddings via transformers.js (ADR-EMB02). Dirty edge: loads + runs the ONNX model.
// No external API; weights are fetched once and cached. transformers (and its onnxruntime native
// dependency) is imported lazily on first embed, so importing this module never loads the runtime.

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
    // Lazy: import transformers (and its onnxruntime native dep) only on first use, then build the
    // pipeline once and reuse it. Importing this module must NOT pull in the native runtime — that
    // keeps cold start fast and lets non-embedding code paths and tests run without onnxruntime.
    // Optional peer since 0.6: the local-embedding stack (transformers -> onnxruntime -> sharp,
    // adm-zip, protobufjs) is a large native tree that only the semantic assertions need, and it was
    // being installed into every consumer — including a server that imports this package purely for
    // its zod contracts, where it contributed four HIGH advisories and never ran a line.
    //
    // The import was already lazy, so nothing about the happy path changes. What changes is the
    // failure: a missing package now says which one and how to get it, instead of MODULE_NOT_FOUND.
    this.extractor ??= import('@huggingface/transformers')
      .catch(() => {
        throw new Error(
          'The `semantic-similarity` and RAG assertions need local embeddings, which ship separately: ' +
            'install @huggingface/transformers to enable them. Every other assertion works without it.',
        );
      })
      .then(({ pipeline }) => pipeline('feature-extraction', MODEL_ID)) as unknown as Promise<FeatureExtractor>;
    return this.extractor;
  }
}

let defaultEmbedder: Embedder | undefined;

/** The production embedder; the orchestrator injects it into AssertionContext for semantic kinds. */
export function getDefaultEmbedder(): Embedder {
  return (defaultEmbedder ??= new XenovaEmbedder());
}
