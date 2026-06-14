// Embedder contract (ADR-EMB01). A pure type — the embeddings module implements it; assertions
// receive an implementation via AssertionContext.embedder (dependency injection, no direct import).

export interface Embedder {
  /** Embed a batch of texts into fixed-dimension vectors (one per input, in order). */
  embed(texts: string[]): Promise<Float32Array[]>;
}
