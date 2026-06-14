import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Provider } from '../../types/provider.js';
import type { ProviderConfig } from '../../types/config.js';

const { AnthropicMock, OpenAIMock } = vi.hoisted(() => ({
  AnthropicMock: vi.fn(() => ({ messages: { create: vi.fn() } })),
  OpenAIMock: vi.fn(() => ({ chat: { completions: { create: vi.fn() } } })),
}));

vi.mock('@anthropic-ai/sdk', () => ({ default: AnthropicMock }));
vi.mock('openai', () => ({ default: OpenAIMock }));

import { createProviderRegistry, getProvider } from '../registry.js';

const fakeProvider: Provider = {
  complete: vi.fn(),
  estimateCost: vi.fn(() => ({ cost_usd: 0 })),
};

beforeEach(() => {
  AnthropicMock.mockClear();
  OpenAIMock.mockClear();
});

describe('provider registry (ADR-PRV02)', () => {
  it('getProvider resolves the correct built-in by type (AC-1)', () => {
    getProvider({ type: 'anthropic', model: 'claude-3-5-haiku-latest' }, { ANTHROPIC_API_KEY: 'k' });
    expect(AnthropicMock).toHaveBeenCalledTimes(1);
    expect(OpenAIMock).not.toHaveBeenCalled();
  });

  it('getProvider routes openrouter to the OpenAI-compatible client with the right base URL (AC-1)', () => {
    getProvider({ type: 'openrouter', model: 'anthropic/claude-3.5-sonnet' }, { OPENROUTER_API_KEY: 'k' });
    expect(OpenAIMock).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: expect.stringContaining('openrouter.ai') }),
    );
  });

  it('register + resolve adds a provider with no core change (AC-2, FR-2)', () => {
    const registry = createProviderRegistry();
    registry.register('fake', () => fakeProvider);
    const resolved = registry.resolve('fake', { type: 'anthropic', model: 'x' } as ProviderConfig, {});
    expect(resolved).toBe(fakeProvider);
  });

  it('throws on a duplicate registration (FR-1, collision policy)', () => {
    const registry = createProviderRegistry();
    registry.register('dup', () => fakeProvider);
    expect(() => registry.register('dup', () => fakeProvider)).toThrowError(/already registered/i);
  });

  it('throws on resolving an unknown provider type (FR-1)', () => {
    const registry = createProviderRegistry();
    expect(() =>
      registry.resolve('nope', { type: 'anthropic', model: 'x' } as ProviderConfig, {}),
    ).toThrowError(/unknown provider/i);
  });
});
