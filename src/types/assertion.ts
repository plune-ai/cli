import type { DatasetRow } from './config.js';
import type { Embedder } from './embedder.js';
import type { Judge } from './judge.js';
import type { AgentTranscript } from './results.js';

export interface AssertionResult {
  passed: boolean;
  score?: number;
  reason?: string;
}

export interface AssertionContext<TParams> {
  output: string;
  vars: Record<string, unknown>;
  row: DatasetRow;
  params: TParams;
  // Optional dependency injected by the orchestrator for embedding-based assertions
  // (e.g. semantic-similarity). Pure assertions ignore it — additive, backward-compatible (ADR-EMB01).
  embedder?: Embedder;
  // Optional LLM judge injected by the orchestrator for llm-judge / RAGAS assertions.
  // Additive, backward-compatible (ADR-SR01).
  judge?: Judge;
  // The row's tool loop, for the tool-call assertions of an eval with `mcp`. Additive, like the two above.
  transcript?: AgentTranscript;
}

export interface Assertion<TParams = unknown> {
  run(ctx: AssertionContext<TParams>): Promise<AssertionResult>;
}
