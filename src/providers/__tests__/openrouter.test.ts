import { describe, expect, it, vi, beforeEach } from 'vitest';
import { AuthError } from '../errors.js';
import type { CompletionRequest } from '../../types/provider.js';
import type { ProviderConfig } from '../../types/config.js';

const { mockCreate, OpenAIMock } = vi.hoisted(() => {
  const mockCreate = vi.fn();
  return {
    mockCreate,
    OpenAIMock: vi.fn(() => ({ chat: { completions: { create: mockCreate } } })),
  };
});

// OpenRouter reuses the OpenAI SDK under the hood (OpenAI-compatible API).
vi.mock('openai', () => ({ default: OpenAIMock }));

import { makeOpenRouterProvider } from '../openrouter.js';

const config: ProviderConfig = { type: 'openrouter', model: 'anthropic/claude-3.5-sonnet' };
const req: CompletionRequest = {
  provider: 'openrouter',
  model: 'anthropic/claude-3.5-sonnet',
  temperature: 0,
  max_tokens: 100,
  prompt_resolved: 'Hi',
};

beforeEach(() => {
  mockCreate.mockReset();
  OpenAIMock.mockClear();
});

describe('OpenRouterProvider (ADR-PRV01)', () => {
  it('points the OpenAI client at the OpenRouter base URL', () => {
    makeOpenRouterProvider(config, { OPENROUTER_API_KEY: 'sk-or-test' });
    expect(OpenAIMock).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: expect.stringContaining('openrouter.ai') }),
    );
  });

  it('completes with a namespaced model id and normalizes usage (AC-3, AC-11)', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'Routed reply' } }],
      usage: { prompt_tokens: 7, completion_tokens: 2 },
    });
    const provider = makeOpenRouterProvider(config, { OPENROUTER_API_KEY: 'sk-or-test' });
    const res = await provider.complete(req);
    expect(res.output).toBe('Routed reply');
    expect(res.usage).toEqual({ input_tokens: 7, output_tokens: 2 });
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'anthropic/claude-3.5-sonnet' }),
    );
  });

  it('surfaces the provider-reported cost from usage.cost (ADR-PRC02)', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'x' } }],
      usage: { prompt_tokens: 7, completion_tokens: 2, cost: 0.0123 },
    });
    const provider = makeOpenRouterProvider(config, { OPENROUTER_API_KEY: 'sk-or-test' });
    const res = await provider.complete(req);
    expect(res.cost_usd).toBeCloseTo(0.0123);
  });

  it('requests the cost via usage:{include:true} (ADR-PRC02)', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'x' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    const provider = makeOpenRouterProvider(config, { OPENROUTER_API_KEY: 'sk-or-test' });
    await provider.complete(req);
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ usage: { include: true } }));
  });

  it('leaves cost_usd undefined when OpenRouter omits usage.cost', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'x' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    const provider = makeOpenRouterProvider(config, { OPENROUTER_API_KEY: 'sk-or-test' });
    const res = await provider.complete(req);
    expect(res.cost_usd).toBeUndefined();
  });

  it('throws AuthError naming OPENROUTER_API_KEY when missing (AC-8)', () => {
    let caught: AuthError | undefined;
    try {
      makeOpenRouterProvider(config, {});
    } catch (e) {
      caught = e as AuthError;
    }
    expect(caught).toBeInstanceOf(AuthError);
    expect(caught?.envVar).toBe('OPENROUTER_API_KEY');
  });
});
