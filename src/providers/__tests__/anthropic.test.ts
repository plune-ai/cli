import { describe, expect, it, vi, beforeEach } from 'vitest';
import { AuthError } from '../errors.js';
import type { CompletionRequest } from '../../types/provider.js';
import type { ProviderConfig } from '../../types/config.js';

const { mockCreate, AnthropicMock } = vi.hoisted(() => {
  const mockCreate = vi.fn();
  return {
    mockCreate,
    AnthropicMock: vi.fn(() => ({ messages: { create: mockCreate } })),
  };
});

vi.mock('@anthropic-ai/sdk', () => ({ default: AnthropicMock }));

import { makeAnthropicProvider } from '../anthropic.js';

const config: ProviderConfig = { type: 'anthropic', model: 'claude-3-5-haiku-latest' };
const req: CompletionRequest = {
  provider: 'anthropic',
  model: 'claude-3-5-haiku-latest',
  temperature: 0,
  max_tokens: 100,
  prompt_resolved: 'Hi',
};

beforeEach(() => {
  mockCreate.mockReset();
  AnthropicMock.mockClear();
});

describe('AnthropicProvider (ADR-PRV01)', () => {
  it('completes and normalizes usage (AC-3, AC-11)', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'Hello there' }],
      usage: { input_tokens: 12, output_tokens: 5 },
    });
    const provider = makeAnthropicProvider(config, { ANTHROPIC_API_KEY: 'sk-test' });
    const res = await provider.complete(req);
    expect(res.output).toBe('Hello there');
    expect(res.usage).toEqual({ input_tokens: 12, output_tokens: 5 });
  });

  it('constructs the SDK client with maxRetries: 0 (own retry owns it)', () => {
    makeAnthropicProvider(config, { ANTHROPIC_API_KEY: 'sk-test' });
    expect(AnthropicMock).toHaveBeenCalledWith(expect.objectContaining({ maxRetries: 0 }));
  });

  it('throws AuthError naming the env var when the key is missing (AC-8)', () => {
    expect(() => makeAnthropicProvider(config, {})).toThrowError(AuthError);
    let caught: AuthError | undefined;
    try {
      makeAnthropicProvider(config, {});
    } catch (e) {
      caught = e as AuthError;
    }
    expect(caught?.envVar).toBe('ANTHROPIC_API_KEY');
  });

  it('never leaks the API key in a surfaced error (AC-7)', async () => {
    mockCreate.mockRejectedValue(
      Object.assign(new Error('boom for sk-secret-XYZ'), { status: 500 }),
    );
    const provider = makeAnthropicProvider(
      { ...config, max_retries: 0 },
      { ANTHROPIC_API_KEY: 'sk-secret-XYZ' },
    );
    let caught: Error | undefined;
    try {
      await provider.complete(req);
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeDefined();
    expect(caught?.message).not.toContain('sk-secret-XYZ');
  });

  it('estimates cost from usage via the price table', () => {
    const provider = makeAnthropicProvider(config, { ANTHROPIC_API_KEY: 'sk-test' });
    const est = provider.estimateCost({ input_tokens: 1000, output_tokens: 1000 });
    expect(est.cost_usd).toBeGreaterThan(0);
  });
});
