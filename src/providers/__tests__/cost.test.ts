import { describe, expect, it, vi } from 'vitest';
import { computeCost, resolveCost } from '../cost.js';
import { PRICE_TABLE } from '../prices.js';

const table = { 'model-x': { input_per_1k_usd: 1, output_per_1k_usd: 2 } };

describe('computeCost (ADR-PRV04)', () => {
  it('computes cost from the built-in table (AC-4)', () => {
    // 1000/1000 * 1 + 2000/1000 * 2 = 1 + 4 = 5
    const cost = computeCost({ input_tokens: 1000, output_tokens: 2000 }, 'model-x', undefined, {
      table,
    });
    expect(cost).toBeCloseTo(5);
  });

  it('prefers a config override over the table (AC-5)', () => {
    const overrides = { 'model-x': { input_per_1k_usd: 10, output_per_1k_usd: 20 } };
    // override: 1*10 + 1*20 = 30 ; table would be 1*1 + 1*2 = 3
    const cost = computeCost({ input_tokens: 1000, output_tokens: 1000 }, 'model-x', overrides, {
      table,
    });
    expect(cost).toBeCloseTo(30);
  });

  it('returns 0 and warns for an unknown model (AC-6)', () => {
    const warn = vi.fn();
    const cost = computeCost(
      { input_tokens: 1000, output_tokens: 1000 },
      'unknown-model',
      undefined,
      {
        table,
        warn,
      },
    );
    expect(cost).toBe(0);
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0][0])).toContain('unknown-model');
  });

  it('knows common OpenRouter-namespaced OpenAI models without per-config pricing', () => {
    const warn = vi.fn();
    // Uses the REAL built-in PRICE_TABLE (no `table` dep). `openai/gpt-4o-mini` is the id OpenRouter
    // uses (vs the bare `gpt-4o-mini` for the direct OpenAI provider).
    const cost = computeCost(
      { input_tokens: 1000, output_tokens: 1000 },
      'openai/gpt-4o-mini',
      undefined,
      { warn },
    );
    expect(cost).toBeGreaterThan(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it('ships a non-empty, non-negative built-in PRICE_TABLE', () => {
    expect(Object.keys(PRICE_TABLE).length).toBeGreaterThan(0);
    for (const p of Object.values(PRICE_TABLE)) {
      expect(p.input_per_1k_usd).toBeGreaterThanOrEqual(0);
      expect(p.output_per_1k_usd).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('resolveCost (provider-reported-cost, ADR-PRC01)', () => {
  const usage = { input_tokens: 1000, output_tokens: 1000 };

  it('config override wins even when the provider reports a cost (AC-2)', () => {
    const overrides = { 'model-x': { input_per_1k_usd: 10, output_per_1k_usd: 20 } };
    // override math = 10 + 20 = 30; provider-reported 0.5 must be ignored.
    expect(resolveCost(usage, 'model-x', 0.5, overrides, { table })).toBeCloseTo(30);
  });

  it('uses the provider-reported actual cost when present and no override (AC-1)', () => {
    expect(resolveCost(usage, 'model-x', 0.5, undefined, { table })).toBeCloseTo(0.5);
  });

  it('falls back to the table estimate when nothing is reported (AC-4)', () => {
    // table math = 1 + 2 = 3
    expect(resolveCost(usage, 'model-x', undefined, undefined, { table })).toBeCloseTo(3);
  });

  it('returns 0 + one warning when fully unknown (AC-3)', () => {
    const warn = vi.fn();
    expect(resolveCost(usage, 'no-such-model', undefined, undefined, { table, warn })).toBe(0);
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]![0])).toContain('no-such-model');
  });
});
