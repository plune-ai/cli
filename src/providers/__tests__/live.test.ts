import { describe, it, expect } from 'vitest';
import { getProvider } from '../registry.js';
import type { CompletionRequest } from '../../types/provider.js';
import type { ProviderConfig } from '../../types/config.js';

// Opt-in live suite (FR-11, AC-12): real network calls, run ONLY with PLUNE_LIVE=1.
// The default CI suite skips this entirely — zero network calls.
const LIVE = process.env.PLUNE_LIVE === '1';

async function liveOneToken(config: ProviderConfig): Promise<void> {
  const provider = getProvider(config, process.env);
  const req: CompletionRequest = {
    provider: config.type,
    model: config.model,
    temperature: 0,
    max_tokens: 8,
    prompt_resolved: 'Reply with the single word: OK',
  };
  const res = await provider.complete(req);
  expect(typeof res.output).toBe('string');
  expect(res.usage.input_tokens).toBeGreaterThanOrEqual(0);
  expect(res.usage.output_tokens).toBeGreaterThanOrEqual(0);
}

describe.skipIf(!LIVE)('live provider calls (PLUNE_LIVE=1)', () => {
  it('anthropic completes a tiny request', async () => {
    await liveOneToken({
      type: 'anthropic',
      model: process.env['PLUNE_LIVE_ANTHROPIC_MODEL'] ?? 'claude-3-5-haiku-latest',
    });
  });

  it('openai completes a tiny request', async () => {
    await liveOneToken({
      type: 'openai',
      model: process.env['PLUNE_LIVE_OPENAI_MODEL'] ?? 'gpt-4o-mini',
    });
  });

  it('openrouter completes a tiny request', async () => {
    await liveOneToken({
      type: 'openrouter',
      model: process.env['PLUNE_LIVE_OPENROUTER_MODEL'] ?? 'openai/gpt-4o-mini',
    });
  });
});
