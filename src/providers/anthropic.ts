// Anthropic provider adapter (ADR-PRV01). I/O edge: the only network in this file is the SDK call.

import Anthropic from '@anthropic-ai/sdk';
import type {
  Provider,
  CompletionRequest,
  CompletionResponse,
  CostEstimate,
} from '../types/provider.js';
import type { ProviderConfig, PricingMap } from '../types/config.js';
import { withRetry } from './retry.js';
import { resolveCost, type Usage } from './cost.js';
import { AuthError, normalizeProviderError } from './errors.js';

const ENV_VAR = 'ANTHROPIC_API_KEY';
const DEFAULT_MAX_RETRIES = 2;

export function makeAnthropicProvider(
  config: ProviderConfig,
  env: NodeJS.ProcessEnv,
  pricing?: PricingMap,
): Provider {
  const apiKey = env[ENV_VAR];
  if (apiKey === undefined || apiKey.trim() === '') {
    throw new AuthError(
      `Missing ${ENV_VAR}. Set it in your environment to use the anthropic provider.`,
      ENV_VAR,
    );
  }

  // maxRetries: 0 — our own withRetry owns retry; never let the SDK double-retry (ADR-PRV03).
  const client = new Anthropic({
    apiKey,
    maxRetries: 0,
    ...(config.timeout !== undefined ? { timeout: config.timeout } : {}),
  });
  const maxRetries = config.max_retries ?? DEFAULT_MAX_RETRIES;

  return {
    async complete(req: CompletionRequest): Promise<CompletionResponse> {
      try {
        const res = await withRetry(
          () =>
            client.messages.create({
              model: req.model,
              max_tokens: req.max_tokens,
              temperature: req.temperature,
              messages: [{ role: 'user', content: req.prompt_resolved }],
            }),
          { max_retries: maxRetries },
        );

        const output = res.content
          .map((block) => (block.type === 'text' ? block.text : ''))
          .join('');
        return {
          output,
          usage: {
            input_tokens: res.usage.input_tokens,
            output_tokens: res.usage.output_tokens,
          },
        };
      } catch (err) {
        throw normalizeProviderError(err, apiKey, ENV_VAR);
      }
    },

    estimateCost(usage: Usage, reportedCostUsd?: number): CostEstimate {
      // Anthropic does not report cost → reportedCostUsd is undefined here; resolveCost estimates.
      return { cost_usd: resolveCost(usage, config.model, reportedCostUsd, pricing) };
    },
  };
}
