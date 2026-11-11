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

// --- AssertionConfig discriminated union (10 kinds on the output, AC-03; 14 on the tool calls below) ---

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
  /** The minimum judge score (0–1). Not the eval's `pass_threshold`, which is a share of runs. */
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

// --- Tool-call assertions: they read the transcript of an eval with `mcp` ---

export interface ToolCalledAssertion {
  type: 'tool-called';
  tool: string;
  /** Default 1. */
  min_count?: number;
}

export interface ToolNotCalledAssertion {
  type: 'tool-not-called';
  tool: string;
}

export interface ToolArgsAssertion {
  type: 'tool-args';
  tool: string;
  args: Record<string, unknown>;
  /** `partial` (default): every expected key, deeply; `exact`: the same arguments; `ignore`: any arguments. */
  match?: 'partial' | 'exact' | 'ignore';
  /** Default 1. */
  min_count?: number;
}

export interface ToolOrderAssertion {
  type: 'tool-order';
  tools: string[];
  /** Default false: other calls may come between. True: the calls are exactly `tools`. */
  strict?: boolean;
}

export interface OnlyToolsAssertion {
  type: 'only-tools';
  /** Empty: no call at all. */
  tools: string[];
}

export interface FirstToolAssertion {
  type: 'first-tool';
  tool: string;
}

export interface NoToolErrorsAssertion {
  type: 'no-tool-errors';
  tool?: string;
}

/** At least one of `min` and `max`; both inclusive. */
export interface ToolCallCountAssertion {
  type: 'tool-call-count';
  tool?: string;
  min?: number;
  max?: number;
}

export interface NoRepeatedCallAssertion {
  type: 'no-repeated-call';
  tool?: string;
}

export interface TokenBudgetAssertion {
  type: 'token-budget';
  max: number;
}

export interface ToolLatencyAssertion {
  type: 'tool-latency';
  max_ms: number;
  tool?: string;
}

export interface ToolResultSizeAssertion {
  type: 'tool-result-size';
  max_bytes: number;
  tool?: string;
}

export interface ToolResultSchemaAssertion {
  type: 'tool-result-schema';
  schema: object;
  tool?: string;
}

export interface NoDestructiveToolAssertion {
  type: 'no-destructive-tool';
}

export type ToolCallAssertion =
  | ToolCalledAssertion
  | ToolNotCalledAssertion
  | ToolArgsAssertion
  | ToolOrderAssertion
  | OnlyToolsAssertion
  | FirstToolAssertion
  | NoToolErrorsAssertion
  | ToolCallCountAssertion
  | NoRepeatedCallAssertion
  | TokenBudgetAssertion
  | ToolLatencyAssertion
  | ToolResultSizeAssertion
  | ToolResultSchemaAssertion
  | NoDestructiveToolAssertion;

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
  | ContextPrecisionAssertion
  | ToolCallAssertion;

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
  /** Times each row runs, one after another (1–100, default 1). Overrides the root `runs`. */
  runs?: number;
  /** Share of a row's runs that must pass, in (0, 1] (default 1). Overrides the root value. */
  pass_threshold?: number;
  /** The MCP server this eval's model may use, from the root `mcp.servers`. */
  mcp?: EvalMcpConfig;
}

// --- MCP (agentic evals) ---

/** Every limit is a whole number above 0; one left out takes its default (`MCP_LIMIT_DEFAULTS`). */
export interface McpLimits {
  max_steps?: number;
  max_tool_calls?: number;
  max_total_tokens?: number;
  /** For one dataset row. */
  timeout_ms?: number;
  /** For one tool call. */
  tool_timeout_ms?: number;
}

/** Exactly one of `command` (stdio, with `args`, `env`, `cwd`) or `url` (HTTP, with `headers`). Values may hold `${VAR}`. */
export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
}

export interface McpConfig {
  servers: Record<string, McpServerConfig>;
  /** Defaults for every eval's `mcp.limits`. */
  limits?: McpLimits;
}

export interface EvalMcpConfig {
  server: string;
  /** At least one name; left out, every tool the server lists. */
  allowed_tools?: string[];
  limits?: McpLimits;
}

// --- Config root ---

export interface Config {
  version: 1;
  provider: ProviderConfig;
  defaults?: { assertions?: AssertionConfig[] };
  pricing?: PricingMap;
  /** Default `runs` for every eval. */
  runs?: number;
  /** Default `pass_threshold` (share of runs) for every eval. */
  pass_threshold?: number;
  /** MCP servers for agentic evals, and their default limits. */
  mcp?: McpConfig;
  evals: EvalConfig[];
}
