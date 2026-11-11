import type { ProviderConfig } from './config.js';

export interface CompletionRequest {
  provider: string;
  model: string;
  /**
   * Only when the config asked for one. Models released after Claude Opus 4.6 do not take a
   * temperature at all — any value but 1.0 is a 400 — so a default here would be a default that
   * breaks every eval on a current model. Absent means "the model's own".
   */
  temperature?: number;
  max_tokens: number;
  prompt_resolved: string;
}

export interface CompletionResponse {
  output: string;
  usage: { input_tokens: number; output_tokens: number };
  /**
   * Actual USD cost the provider reported for this call, if it reports one (e.g. OpenRouter via
   * `usage.include`). Absent for providers that only return token counts — the cost is then
   * estimated downstream (ADR-PRC02). Additive + optional: existing providers omit it.
   */
  cost_usd?: number;
  /**
   * Why the model stopped, normalised: `length` (hit the token limit), `error` or `content_filter`
   * mark an answer the cache must not keep. Absent when the provider does not say. Optional and additive.
   */
  finish_reason?: string;
}

export interface CostEstimate {
  cost_usd: number;
  /** Whether `cost_usd` is a known price (zero included) rather than the 0 of an unpriced model. Optional and additive. */
  priced?: boolean;
}

/** A tool as the model is offered it: a name the provider accepts, and the JSON Schema of its arguments. */
export interface ToolSpec {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

/** A call the model asked for. `args` is what it sent; `args_invalid` when that was not a JSON object. */
export interface ToolCall {
  id: string;
  name: string;
  args: unknown;
  args_invalid?: boolean;
}

/** One turn of a conversation with tools, in a form every provider maps to its own wire. */
export type AgentMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; text: string; tool_calls: ToolCall[] }
  /** The answers to the calls of the turn before, in the order they were asked for. */
  | { role: 'tool'; results: { id: string; content: string; is_error: boolean }[] };

export interface StepRequest {
  provider: string;
  model: string;
  temperature?: number;
  max_tokens: number;
  messages: AgentMessage[];
  tools: ToolSpec[];
}

export interface StepResponse {
  text: string;
  tool_calls: ToolCall[];
  usage: { input_tokens: number; output_tokens: number };
  /** As on `CompletionResponse`. */
  cost_usd?: number;
  /** Normalised: `tool_calls`, `stop`, `length`, `error`, or what the provider said. */
  finish_reason?: string;
}

export interface Provider<_TConfig extends ProviderConfig = ProviderConfig> {
  complete(req: CompletionRequest): Promise<CompletionResponse>;
  /**
   * One step of a conversation with tools: the history and the tools in, the model's text and the calls it asks for
   * out. Optional: a provider without it cannot run an eval with an `mcp` server.
   */
  respond?(req: StepRequest): Promise<StepResponse>;
  /**
   * Resolve the USD cost for a call's usage. `reportedCostUsd` (optional) is the provider's actual
   * reported cost from `complete()` — when passed it is preferred over the table estimate, unless a
   * config `pricing` override exists (precedence in `resolveCost`, ADR-PRC01). Omitting it (dry-run,
   * judge calls) yields a pure token-based estimate, as before — additive + backward-compatible.
   */
  estimateCost(
    usage: { input_tokens: number; output_tokens: number },
    reportedCostUsd?: number,
  ): CostEstimate;
}
