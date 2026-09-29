// The provider `--dry-run` runs on (FR-8): it can say what a call would cost, and nothing else.
//
// A dry run never touches the network, so there is nothing to authenticate — building the real
// provider anyway made `plune run --dry-run` fail with `Missing ANTHROPIC_API_KEY` on a machine that
// never held an account (plune-ai/cli#49). The price still comes from the same ladder a real run
// uses (config `pricing` > the built-in table), for the model the config names.

import type { Provider } from '../types/provider.js';
import type { ProviderConfig, PricingMap } from '../types/config.js';
import { resolveCost, type Usage } from './cost.js';

export function makeEstimateProvider(config: ProviderConfig, pricing?: PricingMap): Provider {
  return {
    complete: () =>
      Promise.reject(
        new Error('The --dry-run provider only estimates cost; it never calls a model.'),
      ),
    estimateCost: (usage: Usage, reportedCostUsd?: number) => ({
      cost_usd: resolveCost(usage, config.model, reportedCostUsd, pricing),
    }),
  };
}
