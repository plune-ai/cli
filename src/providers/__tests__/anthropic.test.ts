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

  it('maps stop_reason max_tokens to finish_reason length and passes others through', async () => {
    const provider = makeAnthropicProvider(config, { ANTHROPIC_API_KEY: 'sk-test' });
    for (const [stop, expected] of [['max_tokens', 'length'], ['end_turn', 'end_turn'], ['pause_turn', 'pause_turn']]) {
      mockCreate.mockResolvedValue({
        content: [{ type: 'text', text: 'x' }],
        usage: { input_tokens: 1, output_tokens: 1 },
        stop_reason: stop,
      });
      expect((await provider.complete(req)).finish_reason).toBe(expected);
    }
  });

  it('sends a temperature only when asked for one — current models refuse the parameter', async () => {
    mockCreate.mockResolvedValue({ content: [{ type: 'text', text: 'x' }], usage: { input_tokens: 1, output_tokens: 1 } });
    const provider = makeAnthropicProvider(config, { ANTHROPIC_API_KEY: 'sk-test' });

    const { temperature: _dropped, ...withoutTemperature } = req;
    await provider.complete(withoutTemperature);
    expect(mockCreate.mock.calls[0]?.[0]).not.toHaveProperty('temperature');

    await provider.complete(req);
    expect(mockCreate.mock.calls[1]?.[0]).toMatchObject({ temperature: 0 });
  });

  it('sends no temperature to a model that refuses sampling parameters, and says so once', async () => {
    mockCreate.mockResolvedValue({ content: [{ type: 'text', text: 'x' }], usage: { input_tokens: 1, output_tokens: 1 } });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const model = 'claude-sonnet-5-5';
      const provider = makeAnthropicProvider({ type: 'anthropic', model }, { ANTHROPIC_API_KEY: 'sk-test' });
      await provider.complete({ ...req, model });
      await provider.complete({ ...req, model });
      await provider.respond!({ provider: 'anthropic', model, temperature: 0, max_tokens: 100, messages: [], tools: [] });
      for (const call of mockCreate.mock.calls) expect(call[0]).not.toHaveProperty('temperature');
      expect(stderr).toHaveBeenCalledTimes(1);
      expect(stderr.mock.calls[0]?.[0]).toBe(
        'warning: claude-sonnet-5-5 does not take a temperature; the configured temperature 0 is not sent\n',
      );
    } finally {
      stderr.mockRestore();
    }
  });

  it('still sends the temperature to claude-haiku-4-5, in both request paths', async () => {
    mockCreate.mockResolvedValue({ content: [{ type: 'text', text: 'x' }], usage: { input_tokens: 1, output_tokens: 1 } });
    const model = 'claude-haiku-4-5';
    const provider = makeAnthropicProvider({ type: 'anthropic', model }, { ANTHROPIC_API_KEY: 'sk-test' });
    await provider.complete({ ...req, model, temperature: 0.3 });
    await provider.respond!({ provider: 'anthropic', model, temperature: 0.3, max_tokens: 100, messages: [], tools: [] });
    expect(mockCreate.mock.calls[0]?.[0]).toMatchObject({ temperature: 0.3 });
    expect(mockCreate.mock.calls[1]?.[0]).toMatchObject({ temperature: 0.3 });
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
