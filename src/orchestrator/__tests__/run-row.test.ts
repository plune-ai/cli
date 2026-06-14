import { describe, expect, it, vi } from 'vitest';
import { runRow, type RowParams } from '../run.js';
import type { Provider } from '../../types/provider.js';
import type { Embedder } from '../../types/embedder.js';
import type { Cache } from '../../cache/cache.js';
import type { AssertionConfig } from '../../types/config.js';
import { ProviderError } from '../../providers/errors.js';

function fakeCache(): Cache {
  const m = new Map<
    string,
    { output: string; usage: { input_tokens: number; output_tokens: number } }
  >();
  return {
    get: (k) => m.get(k),
    set: (k, v) => {
      m.set(k, v);
    },
    clear: () => m.clear(),
    close: () => {},
  };
}

function fakeProvider(output = 'hi') {
  const complete = vi.fn(async () => ({ output, usage: { input_tokens: 10, output_tokens: 5 } }));
  const provider: Provider = {
    complete,
    estimateCost: (u) => ({ cost_usd: (u.input_tokens + u.output_tokens) * 0.001 }),
  };
  return { provider, complete };
}

const fakeEmbedder: Embedder = {
  embed: async (texts) => texts.map(() => Float32Array.from([1, 0, 0])),
};

function params(overrides: Partial<RowParams> = {}): RowParams {
  const fp = fakeProvider();
  return {
    template: 'Q: {{question}}',
    assertions: [{ type: 'exact-match', value: 'hi' }],
    row: { vars: { question: 'hi' }, expected: 'hi' },
    providerConfig: { type: 'anthropic', model: 'm', temperature: 0, max_tokens: 256 },
    provider: fp.provider,
    embedder: fakeEmbedder,
    cache: fakeCache(),
    now: () => 1000,
    dryRun: false,
    noCache: false,
    ...overrides,
  };
}

describe('runRow', () => {
  it('on a cache miss: calls the provider, caches, and runs assertions', async () => {
    const fp = fakeProvider('hi');
    const cache = fakeCache();
    const r = await runRow(params({ provider: fp.provider, cache }));
    expect(fp.complete).toHaveBeenCalledTimes(1);
    expect(r.output).toBe('hi');
    expect(r.cached).toBe(false);
    expect(r.assertions[0]).toMatchObject({ type: 'exact-match', passed: true });
    expect(r.usage!.cost_usd).toBeGreaterThan(0);
  });

  it('on a cache hit: cached:true, provider not called, zero new cost (AC-2)', async () => {
    const cache = fakeCache();
    const fp1 = fakeProvider('hi');
    await runRow(params({ provider: fp1.provider, cache })); // populate
    const fp2 = fakeProvider('hi');
    const r = await runRow(params({ provider: fp2.provider, cache }));
    expect(fp2.complete).not.toHaveBeenCalled();
    expect(r.cached).toBe(true);
    expect(r.usage!.cost_usd).toBe(0);
  });

  it('--no-cache bypasses the cache (AC-3)', async () => {
    const cache = fakeCache();
    const getSpy = vi.spyOn(cache, 'get');
    const fp = fakeProvider('hi');
    await runRow(params({ provider: fp.provider, cache, noCache: true }));
    expect(getSpy).not.toHaveBeenCalled();
    expect(fp.complete).toHaveBeenCalled();
  });

  it('injects the embedder for semantic-similarity (AC-4)', async () => {
    const assertions: AssertionConfig[] = [{ type: 'semantic-similarity', reference: 'hi' }];
    const r = await runRow(params({ assertions, provider: fakeProvider('hi').provider }));
    expect(r.assertions[0]).toMatchObject({ type: 'semantic-similarity', passed: true });
  });

  it('injects the judge for llm-judge (AC-4)', async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce({ output: 'hi', usage: { input_tokens: 1, output_tokens: 1 } })
      .mockResolvedValueOnce({
        output: '{"score":0.9}',
        usage: { input_tokens: 2, output_tokens: 2 },
      });
    const provider: Provider = { complete, estimateCost: () => ({ cost_usd: 0.001 }) };
    const assertions: AssertionConfig[] = [{ type: 'llm-judge', criteria: 'is a greeting' }];
    const r = await runRow(params({ assertions, provider }));
    expect(r.assertions[0]).toMatchObject({ type: 'llm-judge', passed: true });
    expect(complete).toHaveBeenCalledTimes(2); // output + judge
    expect(r.usage!.cost_usd).toBeCloseTo(0.002); // output cost (0.001) + judge-call cost (0.001) (AC-7)
  });

  it('passes the provider-reported cost into estimateCost for the row (provider-reported-cost)', async () => {
    // complete() reports cost_usd=0.5; estimateCost echoes the reported arg (else a sentinel).
    // If runRow forwards res.cost_usd, the row cost is 0.5, not the 999 fallback.
    const provider: Provider = {
      complete: async () => ({
        output: 'hi',
        usage: { input_tokens: 1, output_tokens: 1 },
        cost_usd: 0.5,
      }),
      estimateCost: (_u, reported) => ({ cost_usd: reported ?? 999 }),
    };
    const r = await runRow(params({ provider }));
    expect(r.usage!.cost_usd).toBeCloseTo(0.5);
  });

  it('on a ProviderError: row.error, output null, no assertions (AC-5)', async () => {
    const complete = vi.fn(async () => {
      throw new ProviderError('PROVIDER_TRANSIENT_EXHAUSTED', 'down');
    });
    const provider: Provider = { complete, estimateCost: () => ({ cost_usd: 0 }) };
    const r = await runRow(params({ provider }));
    expect(r.output).toBeNull();
    expect(r.error).toBeDefined();
    expect(r.assertions).toEqual([]);
  });

  it('--dry-run: no provider call, no cache touch, output null (AC-9)', async () => {
    const fp = fakeProvider('hi');
    const cache = fakeCache();
    const getSpy = vi.spyOn(cache, 'get');
    const r = await runRow(params({ provider: fp.provider, cache, dryRun: true }));
    expect(fp.complete).not.toHaveBeenCalled();
    expect(getSpy).not.toHaveBeenCalled();
    expect(r.output).toBeNull();
    expect(r.usage).toBeDefined(); // estimated cost present
  });
});
