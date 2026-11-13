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

  it('a scripted call that picks by words calls the one tool whose description holds them all, and none when that is not one', async () => {
    const step = (pick: string, tools: { name: string; description: string }[]) =>
      makeMockProvider([{ tool_calls: [{ pick, args: { a: 1 } }] }]).respond!({
        provider: 'mock',
        model: 'm',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'x' }],
        tools: tools.map((t) => ({ ...t, input_schema: {} })),
      });
    const search = { name: 'search', description: 'Find test cases by tag' };
    const queue = { name: 'queue', description: 'See what waits in the review queue' };
    expect((await step('find tag', [queue, search])).tool_calls).toEqual([{ id: 'call_0_0', name: 'search', args: { a: 1 } }]);
    expect((await step('find tag', [queue])).tool_calls).toEqual([]);
    expect((await step('find tag', [search, { name: 'twin', description: search.description }])).tool_calls).toEqual([]);
  });

  it('estimateCost() reports zero cost (no real spend)', () => {
    const provider = makeMockProvider();
    expect(provider.estimateCost({ input_tokens: 10, output_tokens: 5 })).toEqual({ cost_usd: 0 });
  });
});
