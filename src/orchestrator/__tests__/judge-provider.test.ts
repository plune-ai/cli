import { describe, expect, it, vi } from 'vitest';
import { assess, runOrchestration, type RunDeps } from '../run.js';
import { loadDataset } from '../dataset.js';
import { parseRunResult } from '../../types/run-result-schema.js';
import type { CompletionRequest, Provider } from '../../types/provider.js';
import type { Cache } from '../../cache/cache.js';
import type { AssertionConfig, Config, ProviderConfig } from '../../types/config.js';

const noCache: Cache = { get: () => undefined, set: () => {}, clear: () => {}, close: () => {} };
const PRICE: Record<string, number> = { 'model-a': 0.001, 'model-b': 0.01 };

// Every call answers with a verdict that both llm-judge and faithfulness read, so the same provider serves as the answering model and as a judge.
function setup() {
  const calls: CompletionRequest[] = [];
  const resolved: ProviderConfig[] = [];
  const resolveProvider = vi.fn((cfg: ProviderConfig): Provider => {
    resolved.push(cfg);
    return {
      complete: async (req) => {
        calls.push(req);
        return { output: '{"score": 0.9, "reason": "ok", "statements": [{"faithful": true}]}', usage: { input_tokens: 10, output_tokens: 10 } };
      },
      estimateCost: (u) => ({ cost_usd: (u.input_tokens + u.output_tokens) * (PRICE[cfg.model] ?? 0) }),
    };
  });
  const deps: RunDeps = {
    resolveProvider,
    embedder: { embed: async (t) => t.map(() => Float32Array.from([1, 0, 0])) },
    cache: noCache,
    now: () => 1000,
    loadDataset,
    baseDir: '/x',
  };
  return { calls, resolved, deps };
}

const A: ProviderConfig = { type: 'openai', model: 'model-a', temperature: 0.3 };
const config = (assertions: AssertionConfig[], rows = 1): Config => ({
  version: 1,
  provider: A,
  evals: [
    {
      id: 'faq',
      prompt: 'Q: {{q}}',
      dataset: { examples: Array.from({ length: rows }, (_, i) => ({ vars: { q: `q${i}` } })) },
      assertions,
    },
  ],
});

describe('CLI · run · llm-judge provider', () => {
  it('an llm-judge with a provider of its own is judged by that model and priced at it', async () => {
    const { calls, resolved, deps } = setup();
    const r = await runOrchestration(
      config([{ type: 'llm-judge', criteria: 'answers', provider: { model: 'model-b' } }]),
      {},
      deps,
    );
    expect(calls.map((c) => c.model)).toEqual(['model-a', 'model-b']);
    // Fields the check leaves out come from the eval's provider.
    expect(resolved).toContainEqual({ type: 'openai', model: 'model-b', temperature: 0.3 });
    expect(calls[1]!.temperature).toBe(0.3);
    const row = r.evals[0]!.rows[0]!;
    // 20 tokens answered at model-a, 20 judged at model-b.
    expect(row.usage!.cost_usd).toBeCloseTo(20 * 0.001 + 20 * 0.01, 10);
    expect(row.assertions[0]).toMatchObject({ type: 'llm-judge', judge_model: 'openai/model-b' });
  });

  it('a different type is a different provider, resolved once for every row', async () => {
    const { calls, resolved, deps } = setup();
    await runOrchestration(
      config([{ type: 'llm-judge', criteria: 'answers', provider: { type: 'anthropic', model: 'model-b' } }], 3),
      {},
      deps,
    );
    const judges = resolved.filter((c) => c.type === 'anthropic');
    expect(judges).toEqual([{ type: 'anthropic', model: 'model-b', temperature: 0.3 }]);
    expect(calls.filter((c) => c.provider === 'anthropic')).toHaveLength(3);
  });

  it('without a provider of its own the judge is the eval model, as before', async () => {
    const { calls, resolved, deps } = setup();
    const r = await runOrchestration(config([{ type: 'llm-judge', criteria: 'answers' }]), {}, deps);
    expect(calls.map((c) => c.model)).toEqual(['model-a', 'model-a']);
    expect(resolved).toEqual([A]);
    const row = r.evals[0]!.rows[0]!;
    expect(row.usage!.cost_usd).toBeCloseTo(40 * 0.001, 10);
    expect(row.assertions[0]).toMatchObject({ judge_model: 'openai/model-a' });
  });

  it('a caller that cannot resolve the named judge gets an errored row, not the eval model as judge', async () => {
    const { calls, deps } = setup();
    const r = await assess(
      {
        assertions: [{ type: 'llm-judge', criteria: 'answers', provider: { model: 'model-b' } }],
        row: { vars: {} },
        provider: deps.resolveProvider(A),
        providerConfig: A,
        embedder: deps.embedder,
      },
      'out',
      'in',
    );
    expect(r.assertionError?.message).toContain('cannot build the judge');
    expect(calls).toEqual([]);
  });

  it('a jev judge is built for the check alone: no provider is resolved for it, and its cost goes to the row', async () => {
    const { calls, resolved, deps } = setup();
    const asked: unknown[] = [];
    const r = await runOrchestration(
      config([{ type: 'llm-judge', criteria: 'answers', provider: { type: 'jev', model: 'jev-1.14.0' } }]),
      {},
      {
        ...deps,
        jevJudge: (cfg, onCost) => ({
          ask: async () => {
            throw new Error('ask must not be called');
          },
          decide: async (q) => {
            asked.push({ cfg, q });
            onCost(0.5);
            return 0.8;
          },
        }),
      },
    );
    // The eval's model answered; nothing else was resolved or called.
    expect(calls.map((c) => c.model)).toEqual(['model-a']);
    expect(resolved).toEqual([A]);
    expect(asked).toEqual([{ cfg: { type: 'jev', model: 'jev-1.14.0' }, q: { criteria: 'answers', output: expect.any(String), input: 'Q: q0' } }]);
    const row = r.evals[0]!.rows[0]!;
    expect(row.assertions[0]).toMatchObject({ type: 'llm-judge', passed: true, score: 0.8, judge_model: 'jev/jev-1.14.0' });
    expect(row.usage!.cost_usd).toBeCloseTo(20 * 0.001 + 0.5, 10);
    expect(parseRunResult(r).evals[0]!.rows[0]!.assertions[0]!.judge_model).toBe('jev/jev-1.14.0');
  });

  it('a run that cannot build the jev judge errors the row, and the eval model does not judge instead', async () => {
    const { calls, deps } = setup();
    const r = await runOrchestration(
      config([{ type: 'llm-judge', criteria: 'answers', provider: { type: 'jev', model: 'jev-1.14.0' } }]),
      {},
      deps,
    );
    expect(r.evals[0]!.rows[0]!.error?.message).toContain('cannot build the jev judge');
    expect(calls.map((c) => c.model)).toEqual(['model-a']);
  });

  it('only a check a model judged records the judge model; the run result keeps it, and parses without it', async () => {
    const { deps } = setup();
    const r = await runOrchestration(
      config([
        { type: 'contains', value: 'score' },
        { type: 'faithfulness', context: 'c' },
      ]),
      {},
      deps,
    );
    const [plain, rag] = r.evals[0]!.rows[0]!.assertions;
    expect(plain).not.toHaveProperty('judge_model');
    expect(rag!.judge_model).toBe('openai/model-a');
    expect(parseRunResult(r).evals[0]!.rows[0]!.assertions[1]!.judge_model).toBe('openai/model-a');
    // A run written before the field existed.
    const old = structuredClone(r);
    delete old.evals[0]!.rows[0]!.assertions[1]!.judge_model;
    expect(parseRunResult(old).evals[0]!.rows[0]!.assertions[1]).not.toHaveProperty('judge_model');
  });
});
