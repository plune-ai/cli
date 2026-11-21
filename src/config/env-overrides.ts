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
    // Infinity is no time the SDK timer can wait (it fires at once), and the hashed config takes no Infinity:
    // ignore it like a non-number, so the config's own timeout stays.
    if (Number.isFinite(n)) for (const p of all) p.timeout = n;
  }

  if (env['PLUNE_MAX_RETRIES'] !== undefined) {
    const n = Number(env['PLUNE_MAX_RETRIES']);
    // A non-finite count means no retry, as in withRetry. Store it as 0: the config is hashed, and the hash
    // takes no Infinity.
    if (!isNaN(n)) for (const p of all) p.max_retries = Number.isFinite(n) ? n : 0;
  }

  return result;
}
