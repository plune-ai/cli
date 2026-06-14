import { describe, expect, it } from 'vitest';
import { applyEnvOverrides } from '../env-overrides.js';
import type { Config } from '../../types/config.js';

const baseConfig: Config = {
  version: 1,
  provider: {
    type: 'anthropic',
    model: 'claude-3-opus',
  },
  evals: [],
};

describe('applyEnvOverrides', () => {
  it('overrides provider.type via PLUNE_PROVIDER', () => {
    const result = applyEnvOverrides(baseConfig, { PLUNE_PROVIDER: 'openai' });
    expect(result.provider.type).toBe('openai');
  });

  it('overrides provider.model via PLUNE_MODEL', () => {
    const result = applyEnvOverrides(baseConfig, { PLUNE_MODEL: 'gpt-4o' });
    expect(result.provider.model).toBe('gpt-4o');
  });

  it('overrides provider.timeout via PLUNE_TIMEOUT', () => {
    const result = applyEnvOverrides(baseConfig, { PLUNE_TIMEOUT: '5000' });
    expect(result.provider.timeout).toBe(5000);
  });

  it('overrides provider.max_retries via PLUNE_MAX_RETRIES', () => {
    const result = applyEnvOverrides(baseConfig, { PLUNE_MAX_RETRIES: '3' });
    expect(result.provider.max_retries).toBe(3);
  });

  it('ignores PLUNE_TIMEOUT when value is NaN', () => {
    const result = applyEnvOverrides(baseConfig, { PLUNE_TIMEOUT: 'abc' });
    expect(result.provider.timeout).toBeUndefined();
  });

  it('ignores PLUNE_MAX_RETRIES when value is NaN', () => {
    const result = applyEnvOverrides(baseConfig, { PLUNE_MAX_RETRIES: 'not-a-number' });
    expect(result.provider.max_retries).toBeUndefined();
  });

  it('leaves config unchanged when no known env vars are set', () => {
    const result = applyEnvOverrides(baseConfig, { SOME_OTHER_VAR: 'value' });
    expect(result).toEqual(baseConfig);
  });

  it('does not mutate the original input config', () => {
    const original: Config = {
      version: 1,
      provider: { type: 'anthropic', model: 'claude-3-opus' },
      evals: [],
    };
    applyEnvOverrides(original, { PLUNE_MODEL: 'gpt-4o', PLUNE_TIMEOUT: '1000' });
    expect(original.provider.model).toBe('claude-3-opus');
    expect(original.provider.timeout).toBeUndefined();
  });
});
