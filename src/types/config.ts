export interface ProviderConfig {
  type: 'anthropic' | 'openai' | 'openrouter';
  model: string;
  temperature?: number;
  max_tokens?: number;
  concurrency?: number;
  timeout?: number;
  max_retries?: number;
}

// Per-model price override (ADR-PRV04). Keyed by model id; values are USD per 1K tokens.
export interface ModelPrice {
  input_per_1k_usd: number;
  output_per_1k_usd: number;
}

export type PricingMap = Record<string, ModelPrice>;

export interface DatasetRow {
  vars: Record<string, string | number | boolean>;
  expected?: string;
}

export type DatasetRef = string | { examples: DatasetRow[] };

// --- AssertionConfig discriminated union (10 kinds, AC-03) ---

export interface ExactMatchAssertion {
  type: 'exact-match';
  value: string;
  trim?: boolean;
  ignore_case?: boolean;
}

export interface ContainsAssertion {
  type: 'contains';
  value: string;
  ignore_case?: boolean;
}

export interface ContainsAnyAssertion {
  type: 'contains-any';
  values: string[];
  ignore_case?: boolean;
}

export interface ContainsAllAssertion {
  type: 'contains-all';
  values: string[];
  ignore_case?: boolean;
}

export interface JsonSchemaAssertion {
  type: 'json-schema';
  schema: object;
  extract?: 'auto' | 'strict';
}

export interface LlmJudgeAssertion {
  type: 'llm-judge';
  criteria: string;
  provider?: Partial<ProviderConfig>;
  pass_threshold?: number;
}

export interface SemanticSimilarityAssertion {
  type: 'semantic-similarity';
  reference: string;
  threshold?: number;
}

export interface FaithfulnessAssertion {
  type: 'faithfulness';
  context: string;
  threshold?: number;
}

export interface AnswerRelevanceAssertion {
  type: 'answer-relevance';
  question: string;
  threshold?: number;
}

export interface ContextPrecisionAssertion {
  type: 'context-precision';
  context: string;
  question: string;
  threshold?: number;
}

export type AssertionConfig =
  | ExactMatchAssertion
  | ContainsAssertion
  | ContainsAnyAssertion
  | ContainsAllAssertion
  | JsonSchemaAssertion
  | LlmJudgeAssertion
  | SemanticSimilarityAssertion
  | FaithfulnessAssertion
  | AnswerRelevanceAssertion
  | ContextPrecisionAssertion;

export type AssertionKind = AssertionConfig['type'];

// --- EvalConfig ---

export interface EvalConfig {
  id: string;
  description?: string;
  tags?: string[];
  provider?: Partial<ProviderConfig>;
  prompt?: string;
  prompt_file?: string;
  dataset: DatasetRef;
  assertions: AssertionConfig[];
}

// --- Config root ---

export interface Config {
  version: 1;
  provider: ProviderConfig;
  defaults?: { assertions?: AssertionConfig[] };
  pricing?: PricingMap;
  evals: EvalConfig[];
}
