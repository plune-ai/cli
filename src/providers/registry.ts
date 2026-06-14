// Provider registry (ADR-PRV02). Composition edge: wires the built-in providers.
// Function-based, no global state — a fresh registry per run keeps tests isolated.

import type { Provider } from '../types/provider.js';
import type { ProviderConfig, PricingMap } from '../types/config.js';
import { makeAnthropicProvider } from './anthropic.js';
import { makeOpenAiProvider } from './openai.js';
import { makeOpenRouterProvider } from './openrouter.js';

export type ProviderFactory = (
  config: ProviderConfig,
  env: NodeJS.ProcessEnv,
  pricing?: PricingMap,
) => Provider;

export interface ProviderRegistry {
  register(name: string, factory: ProviderFactory): void;
  resolve(name: string, config: ProviderConfig, env: NodeJS.ProcessEnv, pricing?: PricingMap): Provider;
  has(name: string): boolean;
}

export function createProviderRegistry(): ProviderRegistry {
  const factories = new Map<string, ProviderFactory>();

  return {
    register(name, factory) {
      if (factories.has(name)) {
        throw new Error(`Provider "${name}" is already registered — provider names must be unique.`);
      }
      factories.set(name, factory);
    },

    resolve(name, config, env, pricing) {
      const factory = factories.get(name);
      if (factory === undefined) {
        const known = [...factories.keys()].join(', ') || '(none)';
        throw new Error(`Unknown provider type "${name}". Registered providers: ${known}.`);
      }
      return factory(config, env, pricing);
    },

    has(name) {
      return factories.has(name);
    },
  };
}

/** A registry pre-populated with the v0.1 built-in providers. */
export function createDefaultRegistry(): ProviderRegistry {
  const registry = createProviderRegistry();
  registry.register('anthropic', makeAnthropicProvider);
  registry.register('openai', makeOpenAiProvider);
  registry.register('openrouter', makeOpenRouterProvider);
  return registry;
}

/**
 * Convenience facade for the orchestrator: resolve a built-in provider from an already-merged
 * (effective) provider config. The orchestrator owns the top-level/eval-level merge; this only
 * maps `provider.type` → a constructed Provider instance.
 */
export function getProvider(
  config: ProviderConfig,
  env: NodeJS.ProcessEnv,
  pricing?: PricingMap,
): Provider {
  return createDefaultRegistry().resolve(config.type, config, env, pricing);
}
