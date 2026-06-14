// OpenRouter provider adapter (ADR-PRV01).
// OpenRouter speaks the OpenAI wire protocol, so it reuses the OpenAI-compatible factory
// with a different base URL and API key env var.

import type { Provider } from '../types/provider.js';
import type { ProviderConfig, PricingMap } from '../types/config.js';
import { makeOpenAiCompatibleProvider } from './openai.js';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

export function makeOpenRouterProvider(
  config: ProviderConfig,
  env: NodeJS.ProcessEnv,
  pricing?: PricingMap,
): Provider {
  return makeOpenAiCompatibleProvider({
    config,
    env,
    pricing,
    apiKeyEnv: 'OPENROUTER_API_KEY',
    baseURL: OPENROUTER_BASE_URL,
    reportsCost: true, // OpenRouter reports the call's actual cost via usage.cost (ADR-PRC02)
  });
}
