import type { ProviderConfig } from './config.js';

export interface CompletionRequest {
  provider: string;
  model: string;
  temperature: number;
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
}

export interface CostEstimate {
  cost_usd: number;
}

export interface Provider<_TConfig extends ProviderConfig = ProviderConfig> {
  complete(req: CompletionRequest): Promise<CompletionResponse>;
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
