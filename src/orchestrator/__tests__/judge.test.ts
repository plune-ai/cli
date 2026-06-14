import { describe, expect, it, vi } from 'vitest';
import { buildJudge } from '../judge.js';
import type { Provider, CompletionResponse } from '../../types/provider.js';
import type { ProviderConfig } from '../../types/config.js';

describe('buildJudge (ADR-OR02)', () => {
  it('asks via the provider at temperature 0 and reports usage to the sink', async () => {
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
      expect.objectContaining({ model: 'm', temperature: 0, prompt_resolved: 'the prompt' }),
    );
    expect(usages).toEqual([{ input_tokens: 7, output_tokens: 3 }]);
  });

  it('falls back to a default max_tokens when the config omits it', async () => {
    const complete = vi.fn(async () => ({ output: 'x', usage: { input_tokens: 1, output_tokens: 1 } }));
    const provider: Provider = { complete, estimateCost: () => ({ cost_usd: 0 }) };
    const cfg: ProviderConfig = { type: 'anthropic', model: 'm' }; // no max_tokens
    await buildJudge(provider, cfg, () => {}).ask('p');
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ max_tokens: 1024 }));
  });
});
