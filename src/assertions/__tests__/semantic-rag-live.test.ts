import { describe, it, expect } from 'vitest';
import type { Judge } from '../../types/judge.js';

// Opt-in live suite (AC-9): exercises llm-judge against a real provider. Default CI skips it
// (zero API calls). Dynamic imports keep providers/SDK out of the skipped run. Run with
// PLUNE_LIVE=1 and a provider API key in the environment. The orchestrator (S8) will build the
// Judge for real; here we construct an equivalent inline.
const LIVE = process.env.PLUNE_LIVE === '1';

describe.skipIf(!LIVE)('semantic-rag live (PLUNE_LIVE=1)', () => {
  it('llm-judge scores a real model output against a criterion', async () => {
    const { getProvider } = await import('../../providers/index.js');
    const { llmJudge } = await import('../llm-judge.js');

    const config = { type: 'anthropic' as const, model: 'claude-3-5-haiku-latest' };
    const provider = getProvider(config, process.env);
    const judge: Judge = {
      ask: async (prompt) =>
        (
          await provider.complete({
            provider: config.type,
            model: config.model,
            temperature: 0,
            max_tokens: 1024,
            prompt_resolved: prompt,
          })
        ).output,
    };

    const r = await llmJudge.run({
      output: 'Hello! How can I help you today?',
      vars: {},
      row: { vars: {} },
      params: { type: 'llm-judge', criteria: 'The response is a polite greeting.' },
      judge,
    });

    expect(r.score).toBeGreaterThan(0.5);
    expect(r.passed).toBe(true);
  });
});
