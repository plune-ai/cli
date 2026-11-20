// Build a Judge (ADR-SR01/OR02) from a provider: ask() runs a completion at the config's temperature
// (none unless set — current models refuse the parameter) and reports its token usage to a sink so
// judge-call cost is accounted to the row that triggered it.

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
      const maxTokens = cfg.max_tokens ?? DEFAULT_MAX_TOKENS;
      const res = await provider.complete({
        provider: cfg.type,
        model: cfg.model,
        ...(cfg.temperature !== undefined ? { temperature: cfg.temperature } : {}),
        max_tokens: maxTokens,
        prompt_resolved: prompt,
      });
      onUsage(res.usage);
      // Thinking counts toward max_tokens, so a reasoning judge can spend it all before the verdict.
      // A cut-off reply is not a verdict, even when what is left happens to parse.
      if (res.finish_reason === 'length')
        throw new Error(`judge reply was cut off at max_tokens (${maxTokens}); raise max_tokens for the judge model`);
      return res.output;
    },
  };
}
