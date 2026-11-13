import { ConfigValidationError } from './errors.js';
import type { Config } from '../types/config.js';

export function applyEnvOverrides(config: Config, env: NodeJS.ProcessEnv): Config {
  const result = structuredClone(config);
  const all = result.providers ?? [result.provider];

  if (result.providers !== undefined)
    for (const name of ['PLUNE_PROVIDER', 'PLUNE_MODEL'])
      if (env[name] !== undefined)
        throw new ConfigValidationError('Config validation failed', [
          `${name} sets one model, but the config lists ${result.providers.length}: remove it or list a single model`,
        ]);

  if (env['PLUNE_PROVIDER'] !== undefined) {
    // Cast via the canonical union type so adding a provider (e.g. openrouter) never drifts here.
    result.provider.type = env['PLUNE_PROVIDER'] as Config['provider']['type'];
  }

  if (env['PLUNE_MODEL'] !== undefined) {
    result.provider.model = env['PLUNE_MODEL'];
  }

  if (env['PLUNE_TIMEOUT'] !== undefined) {
    const n = Number(env['PLUNE_TIMEOUT']);
    if (!isNaN(n)) for (const p of all) p.timeout = n;
  }

  if (env['PLUNE_MAX_RETRIES'] !== undefined) {
    const n = Number(env['PLUNE_MAX_RETRIES']);
    if (!isNaN(n)) for (const p of all) p.max_retries = n;
  }

  return result;
}
