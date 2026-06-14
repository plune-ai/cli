import type { PricingMap } from '../types/config.js';

// Built-in, INDICATIVE USD-per-1K-token prices for common models (ADR-PRV04).
// These are defaults, not a source of truth — override per model via `pricing` in plune.yaml,
// and verify against each provider's official pricing page. Unknown models report cost_usd = 0.
export const PRICE_TABLE: PricingMap = {
  // Anthropic
  'claude-3-5-haiku-latest': { input_per_1k_usd: 0.0008, output_per_1k_usd: 0.004 },
  'claude-3-5-sonnet-latest': { input_per_1k_usd: 0.003, output_per_1k_usd: 0.015 },
  'claude-3-opus-latest': { input_per_1k_usd: 0.015, output_per_1k_usd: 0.075 },
  // OpenAI
  'gpt-4o': { input_per_1k_usd: 0.0025, output_per_1k_usd: 0.01 },
  'gpt-4o-mini': { input_per_1k_usd: 0.00015, output_per_1k_usd: 0.0006 },
  // OpenAI via OpenRouter (namespaced ids). OpenRouter passes OpenAI list price through for
  // openai/* routes, so these mirror the direct entries. Only a few common ids are listed —
  // OpenRouter has hundreds of models and dynamic routing, so most still need a `pricing` entry
  // in plune.yaml (or report cost_usd=0). Verify against OpenRouter's current rates.
  'openai/gpt-4o': { input_per_1k_usd: 0.0025, output_per_1k_usd: 0.01 },
  'openai/gpt-4o-mini': { input_per_1k_usd: 0.00015, output_per_1k_usd: 0.0006 },
};
