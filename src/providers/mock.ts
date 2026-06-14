// Test-only provider for end-to-end runs without spending money or hitting the network.
// Activated via PLUNE_MOCK_PROVIDER=1 in the CLI's dirty edge (buildRealDeps), never wired into
// the default registry — production code paths cannot reach it by config alone (ADR-S10-04).

import type { Provider } from '../types/provider.js';

/** A Provider whose `complete()` returns a fixed response with fixed token usage and zero cost. */
export function makeMockProvider(): Provider {
  return {
    complete: () =>
      Promise.resolve({
        output: 'mock response',
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    estimateCost: () => ({ cost_usd: 0 }),
  };
}
