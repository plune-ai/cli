// Build a Judge (ADR-SR01/OR02) from a provider: ask() runs a completion at temperature 0 and
// reports its token usage to a sink so judge-call cost is accounted to the row that triggered it.

import type { Provider, CompletionResponse } from '../types/provider.js';
import type { ProviderConfig } from '../types/config.js';
import type { Judge } from '../types/judge.js';

const DEFAULT_MAX_TOKENS = 1024;

export function buildJudge(
  provider: Provider,
  cfg: ProviderConfig,
  onUsage: (usage: CompletionResponse['usage']) => void,
): Judge {
  return {
    async ask(prompt: string): Promise<string> {
      const res = await provider.complete({
        provider: cfg.type,
        model: cfg.model,
        temperature: 0,
        max_tokens: cfg.max_tokens ?? DEFAULT_MAX_TOKENS,
        prompt_resolved: prompt,
      });
      onUsage(res.usage);
      return res.output;
    },
  };
}
