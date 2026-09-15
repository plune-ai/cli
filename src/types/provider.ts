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
