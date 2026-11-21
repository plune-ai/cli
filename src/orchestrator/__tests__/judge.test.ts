import { describe, expect, it, vi } from 'vitest';
import { buildJudge } from '../judge.js';
import type { Provider, CompletionResponse } from '../../types/provider.js';
import type { ProviderConfig } from '../../types/config.js';

describe('buildJudge (ADR-OR02)', () => {
  it('asks via the provider without a temperature and reports usage to the sink', async () => {
    // No temperature unless the config sets one: models released after Claude Opus 4.6 refuse the
    // parameter with a 400, and the judge used to hard-code 0 — every judged eval on a current
    // model failed before the verdict.
    const usages: { input_tokens: number; output_tokens: number }[] = [];
    const complete = vi.fn(
      async (): Promise<CompletionResponse> => ({
        output: 'verdict',
        usage: { input_tokens: 7, output_tokens: 3 },
      }),
    );
    const provider: Provider = { complete, estimateCost: () => ({ cost_usd: 0 }) };
    const cfg: ProviderConfig = { type: 'anthropic', model: 'm', max_tokens: 256 };

    const judge = buildJudge(provider, cfg, (u) => usages.push(u));
    const out = await judge.ask('the prompt');

    expect(out).toBe('verdict');
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'm', prompt_resolved: 'the prompt' }),
    );
    expect(complete.mock.calls[0]?.[0]).not.toHaveProperty('temperature');
    expect(usages).toEqual([{ input_tokens: 7, output_tokens: 3 }]);
  });

  it('passes the temperature the config asked for', async () => {
    const complete = vi.fn(async () => ({ output: 'x', usage: { input_tokens: 1, output_tokens: 1 } }));
    const provider: Provider = { complete, estimateCost: () => ({ cost_usd: 0 }) };
    const cfg: ProviderConfig = { type: 'anthropic', model: 'm', temperature: 0.2 };
    await buildJudge(provider, cfg, () => {}).ask('p');
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ temperature: 0.2 }));
  });

  it('falls back to a default max_tokens when the config omits it', async () => {
    const complete = vi.fn(async () => ({ output: 'x', usage: { input_tokens: 1, output_tokens: 1 } }));
    const provider: Provider = { complete, estimateCost: () => ({ cost_usd: 0 }) };
    const cfg: ProviderConfig = { type: 'anthropic', model: 'm' }; // no max_tokens
    await buildJudge(provider, cfg, () => {}).ask('p');
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ max_tokens: 1024 }));
  });

  // Thinking counts toward max_tokens, so a reasoning judge can spend the
  // whole budget before its answer. A cut-off reply must say so, not "no parseable JSON".
  it('fails loud, naming max_tokens, when the reply was cut off by the limit', async () => {
    const complete = vi.fn(async (): Promise<CompletionResponse> => ({
      output: '{"score": 0.9, "reason": "the answer',
      usage: { input_tokens: 5, output_tokens: 256 },
      finish_reason: 'length',
    }));
    const usages: unknown[] = [];
    const provider: Provider = { complete, estimateCost: () => ({ cost_usd: 0 }) };
    const cfg: ProviderConfig = { type: 'anthropic', model: 'm', max_tokens: 256 };
    await expect(buildJudge(provider, cfg, (u) => usages.push(u)).ask('p')).rejects.toThrow(
      /cut off at max_tokens \(256\)/,
    );
    // The tokens were spent: the cost still lands on the row.
    expect(usages).toHaveLength(1);
  });
});
