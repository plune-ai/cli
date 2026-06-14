// OpenAI provider adapter + OpenAI-compatible factory (ADR-PRV01).
// The factory is reused by the OpenRouter provider (same wire protocol, different base URL).

import OpenAI from 'openai';
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

const DEFAULT_MAX_RETRIES = 2;

export interface OpenAiCompatibleOptions {
  config: ProviderConfig;
  env: NodeJS.ProcessEnv;
  // `| undefined` is explicit so callers may forward an optional pricing arg under
  // exactOptionalPropertyTypes without conditional spreads.
  pricing?: PricingMap | undefined;
  /** Env var holding the API key (e.g. OPENAI_API_KEY, OPENROUTER_API_KEY). */
  apiKeyEnv: string;
  /** Override the API base URL for OpenAI-compatible providers (e.g. OpenRouter). */
  baseURL?: string;
  /**
   * Ask the endpoint to report the call's actual cost (OpenRouter `usage:{include:true}`), then
   * surface it as `CompletionResponse.cost_usd` (ADR-PRC02). Only OpenRouter supports this — the
   * direct OpenAI provider leaves it off so it never sends a non-standard `usage` body.
   */
  reportsCost?: boolean;
}

/** Build a Provider backed by the OpenAI SDK against any OpenAI-compatible endpoint. */
export function makeOpenAiCompatibleProvider(opts: OpenAiCompatibleOptions): Provider {
  const { config, env, pricing, apiKeyEnv, baseURL, reportsCost } = opts;

  const apiKey = env[apiKeyEnv];
  if (apiKey === undefined || apiKey.trim() === '') {
    throw new AuthError(
      `Missing ${apiKeyEnv}. Set it in your environment to use the ${config.type} provider.`,
      apiKeyEnv,
    );
  }

  const client = new OpenAI({
    apiKey,
    maxRetries: 0, // our own withRetry owns retry (ADR-PRV03)
    ...(baseURL !== undefined ? { baseURL } : {}),
    ...(config.timeout !== undefined ? { timeout: config.timeout } : {}),
  });
  const maxRetries = config.max_retries ?? DEFAULT_MAX_RETRIES;

  return {
    async complete(req: CompletionRequest): Promise<CompletionResponse> {
      try {
        const res = await withRetry(
          () =>
            client.chat.completions.create({
              model: req.model,
              temperature: req.temperature,
              max_tokens: req.max_tokens,
              messages: [{ role: 'user', content: req.prompt_resolved }],
              // OpenRouter extension: ask it to include the call's actual cost in `usage` (ADR-PRC02).
              ...(reportsCost ? { usage: { include: true } } : {}),
            }),
          { max_retries: maxRetries },
        );

        // OpenRouter returns `usage.cost` (USD) — not in the OpenAI SDK type, hence the narrow cast.
        const reportedCost = reportsCost
          ? (res.usage as { cost?: number } | undefined)?.cost
          : undefined;

        return {
          output: res.choices[0]?.message?.content ?? '',
          usage: {
            input_tokens: res.usage?.prompt_tokens ?? 0,
            output_tokens: res.usage?.completion_tokens ?? 0,
          },
          ...(typeof reportedCost === 'number' ? { cost_usd: reportedCost } : {}),
        };
      } catch (err) {
        throw normalizeProviderError(err, apiKey, apiKeyEnv);
      }
    },

    estimateCost(usage: Usage, reportedCostUsd?: number): CostEstimate {
      return { cost_usd: resolveCost(usage, config.model, reportedCostUsd, pricing) };
    },
  };
}

/** The first-party OpenAI provider. */
export function makeOpenAiProvider(
  config: ProviderConfig,
  env: NodeJS.ProcessEnv,
  pricing?: PricingMap,
): Provider {
  return makeOpenAiCompatibleProvider({ config, env, pricing, apiKeyEnv: 'OPENAI_API_KEY' });
}
