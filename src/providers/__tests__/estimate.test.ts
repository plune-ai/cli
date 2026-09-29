// `--dry-run` prices a call and never makes one, so the provider it runs on has one job: say what a
// call would cost. No key to read, no client to build — a dry run must work on a laptop that has
// never held a provider account (plune-ai/cli#49).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeEstimateProvider } from '../estimate.js';
import { PRICE_TABLE } from '../prices.js';

afterEach(() => {
  vi.restoreAllMocks();
});

const usage = { input_tokens: 1000, output_tokens: 2000 };

describe('makeEstimateProvider', () => {
  it('prices a call from the built-in table for the real model', () => {
    const price = PRICE_TABLE['gpt-4o-mini']!;
    const provider = makeEstimateProvider({ type: 'openai', model: 'gpt-4o-mini' });

    expect(provider.estimateCost(usage).cost_usd).toBeCloseTo(
      price.input_per_1k_usd + 2 * price.output_per_1k_usd,
    );
  });

  it('lets the config pricing win over the table, as it does on a real run', () => {
    const provider = makeEstimateProvider(
      { type: 'openai', model: 'gpt-4o-mini' },
      { 'gpt-4o-mini': { input_per_1k_usd: 1, output_per_1k_usd: 2 } },
    );

    expect(provider.estimateCost(usage).cost_usd).toBeCloseTo(1 + 2 * 2);
  });

  it('prices the model the config names, not one type of provider', () => {
    // The same usage costs what THAT model costs — one estimator for every provider type.
    const cheap = makeEstimateProvider({ type: 'anthropic', model: 'claude-3-5-haiku-latest' });
    const dear = makeEstimateProvider({ type: 'anthropic', model: 'claude-3-opus-latest' });

    expect(dear.estimateCost(usage).cost_usd).toBeGreaterThan(cheap.estimateCost(usage).cost_usd);
  });

  it('costs 0 and says so for a model it has no price for', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const provider = makeEstimateProvider({
      type: 'openrouter',
      model: 'nobody/never-heard-of-it',
    });

    expect(provider.estimateCost(usage).cost_usd).toBe(0);
    expect(String(stderr.mock.calls[0]![0])).toContain('nobody/never-heard-of-it');
  });

  it('never calls a model — a call here is a bug in the dry run, and says so', async () => {
    const provider = makeEstimateProvider({ type: 'anthropic', model: 'claude-3-5-haiku-latest' });

    await expect(
      provider.complete({
        provider: 'anthropic',
        model: 'claude-3-5-haiku-latest',
        max_tokens: 16,
        prompt_resolved: 'hi',
      }),
    ).rejects.toThrow(/dry-run/i);
  });
});
