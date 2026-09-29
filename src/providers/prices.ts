import type { PricingMap } from '../types/config.js';

// Built-in, INDICATIVE USD-per-1K-token prices for common models (ADR-PRV04).
// These are defaults, not a source of truth — override per model via `pricing` in plune.yaml,
// and verify against each provider's official pricing page. Unknown models report cost_usd = 0.
export const PRICE_TABLE: PricingMap = {
  // Anthropic, current models. Source: platform.claude.com/docs/en/about-claude/pricing — base
  // input and output tokens per million, read on 2026-09-29, kept here per thousand.
  'claude-fable-5-1': { input_per_1k_usd: 0.01, output_per_1k_usd: 0.05 },
  'claude-opus-5-5': { input_per_1k_usd: 0.004, output_per_1k_usd: 0.02 },
  'claude-sonnet-5-5': { input_per_1k_usd: 0.002, output_per_1k_usd: 0.01 },
  'claude-haiku-4-5': { input_per_1k_usd: 0.001, output_per_1k_usd: 0.005 },
  // The dated id of the same model; a config may name either.
  'claude-haiku-4-5-20251001': { input_per_1k_usd: 0.001, output_per_1k_usd: 0.005 },
  // Anthropic, older ids: unchanged, so a config that still names one prices as it did. Anthropic has
  // retired these models — a new project should not start on them.
  'claude-3-5-haiku-latest': { input_per_1k_usd: 0.0008, output_per_1k_usd: 0.004 },
  'claude-3-5-sonnet-latest': { input_per_1k_usd: 0.003, output_per_1k_usd: 0.015 },
  'claude-3-opus-latest': { input_per_1k_usd: 0.015, output_per_1k_usd: 0.075 },
  // OpenAI, current models. Source: developers.openai.com/api/docs/pricing — standard tier, the
  // short-context rates (a long-context request costs more), read on 2026-09-29.
  'gpt-6-astra': { input_per_1k_usd: 0.01, output_per_1k_usd: 0.05 },
  'gpt-6.1-sol': { input_per_1k_usd: 0.002, output_per_1k_usd: 0.01 },
  'gpt-6-luna': { input_per_1k_usd: 0.0001, output_per_1k_usd: 0.0005 },
  // OpenAI, older ids: unchanged (the same rates the page above still lists for both).
  'gpt-4o': { input_per_1k_usd: 0.0025, output_per_1k_usd: 0.01 },
  'gpt-4o-mini': { input_per_1k_usd: 0.00015, output_per_1k_usd: 0.0006 },
  // OpenAI via OpenRouter (namespaced ids). OpenRouter passes OpenAI list price through for
  // openai/* routes, so these mirror the direct entries. Only a few common ids are listed —
  // OpenRouter has hundreds of models and dynamic routing, so most still need a `pricing` entry
  // in plune.yaml (or report cost_usd=0). Verify against OpenRouter's current rates.
  'openai/gpt-4o': { input_per_1k_usd: 0.0025, output_per_1k_usd: 0.01 },
  'openai/gpt-4o-mini': { input_per_1k_usd: 0.00015, output_per_1k_usd: 0.0006 },
};
