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

/**
 * Resolve a completion's USD cost, preferring the provider's reported actual cost (ADR-PRC01).
 * Priority:
 *   1. config `overrides[model]` (explicit user intent wins — even over a reported actual)
 *   2. `reportedCostUsd` from the provider response (the real charge, e.g. OpenRouter)
 *   3. built-in `table[model]` (token-based estimate)
 *   4. nothing → `0` + one warning (preserves ADR-PRV04)
 */
export function resolveCost(
  usage: Usage,
  model: string,
  reportedCostUsd: number | undefined,
  overrides?: PricingMap,
  deps: ComputeCostDeps = {},
): number {
  const table = deps.table ?? PRICE_TABLE;
  const warn = deps.warn ?? defaultWarn;

  const override = overrides?.[model];
  if (override !== undefined) {
    return priceFrom(override, usage);
  }
  if (reportedCostUsd !== undefined) {
    return reportedCostUsd;
  }
  const tablePrice = table[model];
  if (tablePrice !== undefined) {
    return priceFrom(tablePrice, usage);
  }
  warn(
    `plune: no price for model "${model}" — reporting cost_usd=0. ` +
      `Set pricing["${model}"] in plune.yaml to track its cost.`,
  );
  return 0;
}
