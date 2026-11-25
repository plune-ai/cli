import type { PricingMap } from '../types/config.js';

// Built-in, INDICATIVE USD-per-1K-token prices for common models (ADR-PRV04).
// These are defaults, not a source of truth — override per model via `pricing` in plune.yaml,
// and verify against each provider's official pricing page. Unknown models report cost_usd = 0.
export const PRICE_TABLE: PricingMap = {
  // TypeSafe Jev, the experimental judge of `llm-judge`: input tokens only, its output is not billed.
  // Source: docs.typesafe.ai, read on 2026-11-24 (USD 0.042 per million input tokens).
  'jev-1.14.0': { input_per_1k_usd: 0.000042, output_per_1k_usd: 0 },
  // Anthropic, current models. Source: platform.claude.com/docs/en/about-claude/pricing — base
  // input and output tokens per million, read on 2026-09-29, kept here per thousand.
  'claude-fable-5-1': { input_per_1k_usd: 0.01, output_per_1k_usd: 0.05 },
  'claude-opus-5-5': { input_per_1k_usd: 0.004, output_per_1k_usd: 0.02 },
  'claude-sonnet-5-5': { input_per_1k_usd: 0.002, output_per_1k_usd: 0.01 },
  // Read on 2026-11-24 from https://openrouter.ai/api/v1/models, which passes Anthropic's list price through.
  'claude-haiku-5-5': { input_per_1k_usd: 0.0001, output_per_1k_usd: 0.0005 },
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
  // Via OpenRouter, the models the agent scenarios workflow can be run on. Source:
  // https://openrouter.ai/api/v1/models (`pricing`, USD per token), read on 2026-11-18, kept here
  // per thousand. A real OpenRouter call reports its own cost, which wins over these; they price a
  // dry run and any call that reports none. Long prompts may cost more on some of them.
  // The cheap set:
  'deepseek/deepseek-v4-flash': { input_per_1k_usd: 0.00009, output_per_1k_usd: 0.00018 },
  'qwen/qwen3.7-flash': { input_per_1k_usd: 0.00003, output_per_1k_usd: 0.00013 },
  'google/gemini-2.5-flash-lite': { input_per_1k_usd: 0.0001, output_per_1k_usd: 0.0004 },
  'mistralai/mistral-small-3.2-24b-instruct': {
    input_per_1k_usd: 0.000075,
    output_per_1k_usd: 0.0002,
  },
  'openai/gpt-oss-120b': { input_per_1k_usd: 0.00015, output_per_1k_usd: 0.0006 },
  'anthropic/claude-haiku-5.5': { input_per_1k_usd: 0.0001, output_per_1k_usd: 0.0005 },
  'z-ai/glm-5.3-flash': { input_per_1k_usd: 0.0000399, output_per_1k_usd: 0.0000784 },
  // The middle set:
  'moonshotai/kimi-k2.6': { input_per_1k_usd: 0.00065, output_per_1k_usd: 0.00341 },
  'minimax/minimax-m3': { input_per_1k_usd: 0.0003, output_per_1k_usd: 0.0012 },
  'qwen/qwen3.7-plus': { input_per_1k_usd: 0.00032, output_per_1k_usd: 0.00128 },
  'google/gemini-3.8-flash': { input_per_1k_usd: 0.000825, output_per_1k_usd: 0.004125 },
  'deepseek/deepseek-v4-pro': { input_per_1k_usd: 0.0009, output_per_1k_usd: 0.0015 },
  'openai/gpt-6.1-terra': { input_per_1k_usd: 0.001, output_per_1k_usd: 0.005 },
};
