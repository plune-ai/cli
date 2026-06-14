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

vi.mock('openai', () => ({ default: OpenAIMock }));

import { makeOpenAiProvider } from '../openai.js';

const config: ProviderConfig = { type: 'openai', model: 'gpt-4o-mini' };
const req: CompletionRequest = {
  provider: 'openai',
  model: 'gpt-4o-mini',
  temperature: 0,
  max_tokens: 100,
  prompt_resolved: 'Hi',
};

beforeEach(() => {
  mockCreate.mockReset();
  OpenAIMock.mockClear();
});

describe('OpenAIProvider (ADR-PRV01)', () => {
  it('completes and normalizes usage prompt/completion → input/output (AC-3, AC-11)', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'Hello there' } }],
      usage: { prompt_tokens: 9, completion_tokens: 4 },
    });
    const provider = makeOpenAiProvider(config, { OPENAI_API_KEY: 'sk-test' });
    const res = await provider.complete(req);
    expect(res.output).toBe('Hello there');
    expect(res.usage).toEqual({ input_tokens: 9, output_tokens: 4 });
  });

  it('does NOT request usage cost and leaves cost_usd undefined (direct OpenAI, ADR-PRC02)', async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: 'x' } }],
      usage: { prompt_tokens: 9, completion_tokens: 4 },
    });
    const provider = makeOpenAiProvider(config, { OPENAI_API_KEY: 'sk-test' });
    const res = await provider.complete(req);
    expect(res.cost_usd).toBeUndefined();
    expect(mockCreate).toHaveBeenCalledWith(
      expect.not.objectContaining({ usage: expect.anything() }),
    );
  });

  it('constructs the SDK client with maxRetries: 0', () => {
    makeOpenAiProvider(config, { OPENAI_API_KEY: 'sk-test' });
    expect(OpenAIMock).toHaveBeenCalledWith(expect.objectContaining({ maxRetries: 0 }));
  });

  it('throws AuthError naming OPENAI_API_KEY when missing (AC-8)', () => {
    let caught: AuthError | undefined;
    try {
      makeOpenAiProvider(config, {});
    } catch (e) {
      caught = e as AuthError;
    }
    expect(caught).toBeInstanceOf(AuthError);
    expect(caught?.envVar).toBe('OPENAI_API_KEY');
  });
});
