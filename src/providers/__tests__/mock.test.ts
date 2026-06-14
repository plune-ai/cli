import { describe, expect, it } from 'vitest';
import { makeMockProvider } from '../mock.js';
import type { CompletionRequest } from '../../types/provider.js';

const REQ: CompletionRequest = {
  provider: 'anthropic',
  model: 'm',
  temperature: 0,
  max_tokens: 16,
  prompt_resolved: 'anything',
};

describe('makeMockProvider', () => {
  it('complete() returns a deterministic response with no network (AC-T07.3)', async () => {
    const provider = makeMockProvider();
    const res = await provider.complete(REQ);
    expect(res.output).toBe('mock response');
    expect(res.usage).toEqual({ input_tokens: 10, output_tokens: 5 });
  });

  it('is deterministic across calls and prompts', async () => {
    const provider = makeMockProvider();
    const a = await provider.complete(REQ);
    const b = await provider.complete({ ...REQ, prompt_resolved: 'different' });
    expect(a).toEqual(b);
  });

  it('estimateCost() reports zero cost (no real spend)', () => {
    const provider = makeMockProvider();
    expect(provider.estimateCost({ input_tokens: 10, output_tokens: 5 })).toEqual({ cost_usd: 0 });
  });
});
