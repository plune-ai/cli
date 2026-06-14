import { describe, expect, it, vi } from 'vitest';
import { runOrchestration, type RunDeps } from '../run.js';
import { loadDataset } from '../dataset.js';
import type { Provider } from '../../types/provider.js';
import type { Embedder } from '../../types/embedder.js';
import type { Cache } from '../../cache/cache.js';
import type { Config, EvalConfig } from '../../types/config.js';
import { ProviderError } from '../../providers/errors.js';

function fakeCache(): Cache {
  const m = new Map<string, { output: string; usage: { input_tokens: number; output_tokens: number } }>();
  return { get: (k) => m.get(k), set: (k, v) => void m.set(k, v), clear: () => m.clear(), close: () => {} };
}
const fakeEmbedder: Embedder = { embed: async (t) => t.map(() => Float32Array.from([1, 0, 0])) };

function fakeProvider(output = 'hi'): Provider {
  return {
    complete: vi.fn(async () => ({ output, usage: { input_tokens: 10, output_tokens: 5 } })),
    estimateCost: (u) => ({ cost_usd: (u.input_tokens + u.output_tokens) * 0.001 }),
  };
}

function deps(overrides: Partial<RunDeps> = {}): RunDeps {
  return {
    resolveProvider: () => fakeProvider('hi'),
    embedder: fakeEmbedder,
    cache: fakeCache(),
    now: () => 1000,
    loadDataset,
    baseDir: '/x',
    ...overrides,
  };
}

function config(evals: EvalConfig[]): Config {
  return { version: 1, provider: { type: 'anthropic', model: 'm', temperature: 0, max_tokens: 256, concurrency: 4 }, evals };
}

const evalPass: EvalConfig = {
  id: 'e1',
  tags: ['smoke'],
  prompt: 'Q: {{q}}',
  dataset: { examples: [{ vars: { q: 'hi' }, expected: 'hi' }] },
  assertions: [{ type: 'exact-match', value: 'hi' }],
};

describe('runOrchestration', () => {
  it('runs an eval end-to-end → RunResult passed (AC-1)', async () => {
    const r = await runOrchestration(config([evalPass]), {}, deps());
    expect(r.summary).toMatchObject({ total: 1, passed: 1, failed: 0, errored: 0 });
    expect(r.evals[0]!.passed).toBe(true);
    expect(r.config_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('--only filters by id and tag; empty selection → no evals (AC-8)', async () => {
    const cfg = config([evalPass, { ...evalPass, id: 'e2', tags: ['rag'] }]);
    expect((await runOrchestration(cfg, { only: ['e2'] }, deps())).evals.map((e) => e.id)).toEqual(['e2']);
    expect((await runOrchestration(cfg, { only: ['tag:rag'] }, deps())).evals.map((e) => e.id)).toEqual(['e2']);
    expect((await runOrchestration(cfg, { only: ['nope'] }, deps())).evals).toEqual([]);
  });

  it('--bail stops after the first failing eval (AC-6)', async () => {
    const failing: EvalConfig = { ...evalPass, id: 'bad', assertions: [{ type: 'exact-match', value: 'WRONG' }] };
    const r = await runOrchestration(config([failing, evalPass]), { bail: true }, deps());
    expect(r.evals.map((e) => e.id)).toEqual(['bad']); // second eval never ran
  });

  it('aggregates pass/fail/errored + sums cost incl. judge (AC-7)', async () => {
    const erroringProvider: Provider = {
      complete: vi.fn(async () => {
        throw new ProviderError('PROVIDER_TRANSIENT_EXHAUSTED', 'down');
      }),
      estimateCost: () => ({ cost_usd: 0 }),
    };
    // Distinct vars → distinct cache keys, so each eval actually hits its provider.
    const cfg = config([
      { ...evalPass, id: 'pass', dataset: { examples: [{ vars: { q: 'p' } }] } }, // passes
      { ...evalPass, id: 'fail', dataset: { examples: [{ vars: { q: 'f' } }] }, assertions: [{ type: 'exact-match', value: 'X' }] }, // fails
      { ...evalPass, id: 'err', dataset: { examples: [{ vars: { q: 'e' } }] } }, // errors (provider throws)
    ]);
    let call = 0;
    const r = await runOrchestration(cfg, {}, deps({
      resolveProvider: () => (++call === 3 ? erroringProvider : fakeProvider('hi')),
    }));
    expect(r.summary).toMatchObject({ total: 3, passed: 1, failed: 1, errored: 1 });
    expect(r.summary.cost_usd).toBeGreaterThan(0);
  });

  it('respects the concurrency limit (AC-11)', async () => {
    let active = 0;
    let maxActive = 0;
    const slowProvider: Provider = {
      complete: vi.fn(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((res) => setTimeout(res, 5));
        active -= 1;
        return { output: 'hi', usage: { input_tokens: 1, output_tokens: 1 } };
      }),
      estimateCost: () => ({ cost_usd: 0 }),
    };
    const rows = [{ vars: { q: 'a' } }, { vars: { q: 'b' } }, { vars: { q: 'c' } }, { vars: { q: 'd' } }];
    const cfg = config([{ ...evalPass, assertions: [], dataset: { examples: rows } }]);
    cfg.provider.concurrency = 2;
    await runOrchestration(cfg, {}, deps({ resolveProvider: () => slowProvider }));
    expect(maxActive).toBeLessThanOrEqual(2);
  });
});
