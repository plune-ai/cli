// Cost computation: built-in table + config override (ADR-PRV04). Pure module.

import { PRICE_TABLE } from './prices.js';
import type { PricingMap, ModelPrice } from '../types/config.js';

export interface Usage {
  input_tokens: number;
  output_tokens: number;
}

function priceFrom(price: ModelPrice, usage: Usage): number {
  return (
    (usage.input_tokens / 1000) * price.input_per_1k_usd +
    (usage.output_tokens / 1000) * price.output_per_1k_usd
  );
}

export interface ComputeCostDeps {
  /** Built-in price table; injectable for tests. */
  table?: PricingMap;
  /** Warning sink; defaults to stderr. */
  warn?: (message: string) => void;
}

const defaultWarn = (message: string): void => {
  process.stderr.write(message + '\n');
};

/**
 * Compute USD cost for a completion's usage.
 * Priority: config `overrides[model]` > built-in `table[model]` > unknown (0 + one warning).
 */
export function computeCost(
  usage: Usage,
  model: string,
  overrides?: PricingMap,
  deps: ComputeCostDeps = {},
): number {
  const table = deps.table ?? PRICE_TABLE;
  const warn = deps.warn ?? defaultWarn;

  const price = overrides?.[model] ?? table[model];
  if (price === undefined) {
    warn(
      `plune: no price for model "${model}" — reporting cost_usd=0. ` +
        `Set pricing["${model}"] in plune.yaml to track its cost.`,
    );
    return 0;
  }

  return priceFrom(price, usage);
}

export interface CostEntry {
  cost_usd: number;
  /** `true` when the price is known, a zero price included; `false` when nobody knows it (#151). */
  priced: boolean;
}

/**
 * Resolve a completion's USD cost, preferring the provider's reported actual cost (ADR-PRC01), and
 * say whether that cost is a known price or the `0` of a model nobody has a price for.
 * Priority:
 *   1. config `overrides[model]` (explicit user intent wins — even over a reported actual)
 *   2. `reportedCostUsd` from the provider response (the real charge, e.g. OpenRouter)
 *   3. built-in `table[model]` (token-based estimate)
 *   4. nothing → `0`, `priced: false` + one warning (preserves ADR-PRV04)
 * Cases 1–3 are `priced: true`, even when the cost is 0 (a `:free` model, `pricing: 0`).
 */
export function resolveCostEntry(
  usage: Usage,
  model: string,
  reportedCostUsd: number | undefined,
  overrides?: PricingMap,
  deps: ComputeCostDeps = {},
): CostEntry {
  const table = deps.table ?? PRICE_TABLE;
  const warn = deps.warn ?? defaultWarn;

  const override = overrides?.[model];
  if (override !== undefined) {
    return { cost_usd: priceFrom(override, usage), priced: true };
  }
  if (reportedCostUsd !== undefined) {
    return { cost_usd: reportedCostUsd, priced: true };
  }
  const tablePrice = table[model];
  if (tablePrice !== undefined) {
    return { cost_usd: priceFrom(tablePrice, usage), priced: true };
  }
  warn(
    `plune: no price for model "${model}" — reporting cost_usd=0. ` +
      `Set pricing["${model}"] in plune.yaml to track its cost.`,
  );
  return { cost_usd: 0, priced: false };
}

/** The cost alone; see {@link resolveCostEntry} for whether it is a known price. */
export function resolveCost(
  usage: Usage,
  model: string,
  reportedCostUsd: number | undefined,
  overrides?: PricingMap,
  deps: ComputeCostDeps = {},
): number {
  return resolveCostEntry(usage, model, reportedCostUsd, overrides, deps).cost_usd;
}
