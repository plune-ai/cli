import { describe, expect, it, vi } from 'vitest';
import { runOrchestration, type RunDeps } from '../run.js';
import { loadDataset } from '../dataset.js';
import type { Provider } from '../../types/provider.js';
import type { Cache } from '../../cache/cache.js';
import type { Config, EvalConfig, ProviderConfig } from '../../types/config.js';

function fakeCache(): Cache {
  const m = new Map<string, { output: string; usage: { input_tokens: number; output_tokens: number } }>();
  return { get: (k) => m.get(k), set: (k, v) => void m.set(k, v), clear: () => m.clear(), close: () => {} };
}

const PRICE: Record<string, number> = { 'm-a': 0.001, 'm-b': 0.01 };
// Each model answers with its own name, so a cell tells which model it ran on.
function providerFor(cfg: ProviderConfig): Provider {
  return {
    complete: vi.fn(async () => ({ output: cfg.model, usage: { input_tokens: 10, output_tokens: 10 } })),
    estimateCost: (u) => ({ cost_usd: (u.input_tokens + u.output_tokens) * (PRICE[cfg.model] ?? 0) }),
  };
}

function deps(): RunDeps {
  return {
    resolveProvider: providerFor,
    embedder: { embed: async (t) => t.map(() => Float32Array.from([1, 0, 0])) },
    cache: fakeCache(),
    now: () => 1000,
    loadDataset,
    baseDir: '/x',
  };
}

const A: ProviderConfig = { type: 'anthropic', model: 'm-a' };
const B: ProviderConfig = { type: 'openai', model: 'm-b' };

const ev = (id: string, expected: string, tags: string[] = []): EvalConfig => ({
  id,
  tags,
  prompt: 'Q: {{q}}',
  dataset: { examples: [{ vars: { q: 'hi' } }, { vars: { q: 'yo' } }] },
  assertions: [{ type: 'exact-match', value: expected }],
});

const multi = (evals: EvalConfig[]): Config => ({ version: 1, provider: A, providers: [A, B], evals });
const single = (evals: EvalConfig[]): Config => ({ version: 1, provider: A, evals });

describe('CLI · run · model matrix · cells', () => {
  it('runs every eval on every model: one EvalResult per cell, id <eval>@<model>, in config order', async () => {
    const r = await runOrchestration(multi([ev('x', 'm-a'), ev('y', 'm-b')]), {}, deps());
    expect(r.evals.map((e) => e.id)).toEqual(['x@m-a', 'x@m-b', 'y@m-a', 'y@m-b']);
    expect(r.evals.map((e) => e.passed)).toEqual([true, false, false, true]);
    expect(r.evals[1]!.provider).toEqual({ type: 'openai', model: 'm-b' });
    expect(r.evals[1]!.measured!.model).toBe('openai/m-b');
    expect(r.summary).toMatchObject({ total: 8, passed: 4, failed: 4 });
  });

  it('one model keeps the plain eval id and gains no provider field', async () => {
    const r = await runOrchestration(single([ev('x', 'm-a')]), {}, deps());
    expect(r.evals.map((e) => e.id)).toEqual(['x']);
    expect(r.evals[0]).not.toHaveProperty('provider');
  });

  it('a one-element list gives the same result as the object form', async () => {
    const { pluneConfigSchema } = await import('../../config/schema.js');
    const raw = (provider: unknown) => ({
      version: 1,
      provider,
      evals: [{ id: 'x', prompt: 'Q: {{q}}', dataset: { examples: [{ vars: { q: 'hi' } }] }, assertions: [{ type: 'exact-match', value: 'm-a' }] }],
    });
    const run = async (provider: unknown) => {
      const parsed = pluneConfigSchema.parse(raw(provider));
      return runOrchestration(parsed as unknown as Config, {}, deps());
    };
    expect(await run([A])).toEqual(await run(A));
  });

  it('--only <eval id> selects every cell of that eval; --only tag:<tag> works as before', async () => {
    const cfg = multi([ev('x', 'm-a', ['t1']), ev('y', 'm-b', ['t2'])]);
    expect((await runOrchestration(cfg, { only: ['y'] }, deps())).evals.map((e) => e.id)).toEqual(['y@m-a', 'y@m-b']);
    expect((await runOrchestration(cfg, { only: ['tag:t1'] }, deps())).evals.map((e) => e.id)).toEqual(['x@m-a', 'x@m-b']);
  });

  it('--bail stops at the first failing cell', async () => {
    const r = await runOrchestration(multi([ev('x', 'm-a'), ev('y', 'm-b')]), { bail: true }, deps());
    expect(r.evals.map((e) => e.id)).toEqual(['x@m-a', 'x@m-b']);
  });

  it('--dry-run prices each cell at its own model price', async () => {
    const r = await runOrchestration(multi([ev('x', 'm-a')]), { dryRun: true }, deps());
    const [a, b] = r.evals;
    const costOf = (e: typeof a) => e!.rows[0]!.usage.cost_usd!;
    expect(costOf(b)).toBeGreaterThan(0);
    expect(costOf(b) / costOf(a)).toBeCloseTo(10, 5);
    expect(r.summary.cost_usd).toBeCloseTo(r.evals.reduce((n, e) => n + e.rows.reduce((m, row) => m + row.usage.cost_usd!, 0), 0), 9);
  });
});
