import { describe, expect, it } from 'vitest';
import { applyEnvOverrides } from '../env-overrides.js';
import type { Config } from '../../types/config.js';
import { configHash } from '../../util/hash.js';

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

  // A non-finite timeout is not a time the SDK can wait (its timer fires at once), and the config is
  // hashed for the run, and the hash takes no Infinity: the override is ignored, the config value stays.
  it.each(['Infinity', '-Infinity'])(
    'ignores PLUNE_TIMEOUT=%s and keeps the config timeout, which the config hash takes',
    (v) => {
      const config: Config = {
        ...baseConfig,
        providers: [
          { type: 'anthropic', model: 'a', timeout: 30000 },
          { type: 'openai', model: 'b' },
        ],
      };
      const result = applyEnvOverrides(config, { PLUNE_TIMEOUT: v });
      expect(result.providers?.map((p) => p.timeout)).toEqual([30000, undefined]);
      expect(configHash(result)).toBe(configHash(config));
    },
  );

  it('keeps PLUNE_TIMEOUT=0 and a negative one as written', () => {
    expect(applyEnvOverrides(baseConfig, { PLUNE_TIMEOUT: '0' }).provider.timeout).toBe(0);
    expect(applyEnvOverrides(baseConfig, { PLUNE_TIMEOUT: '-5' }).provider.timeout).toBe(-5);
  });

  it('ignores PLUNE_MAX_RETRIES when value is NaN', () => {
    const result = applyEnvOverrides(baseConfig, { PLUNE_MAX_RETRIES: 'not-a-number' });
    expect(result.provider.max_retries).toBeUndefined();
  });

  // A non-finite count means "no retry" (one attempt). It must reach the config as that finite 0:
  // the config is hashed for the run, and the hash rejects Infinity, so a raw Infinity crashed `plune run`.
  it.each(['Infinity', '-Infinity'])(
    'stores PLUNE_MAX_RETRIES=%s as 0, a finite "no retry" the config hash takes',
    (v) => {
      const config: Config = {
        ...baseConfig,
        providers: [
          { type: 'anthropic', model: 'a' },
          { type: 'openai', model: 'b' },
        ],
      };
      const result = applyEnvOverrides(config, { PLUNE_MAX_RETRIES: v });
      expect(result.providers?.map((p) => p.max_retries)).toEqual([0, 0]);
      expect(configHash(result)).toBe(
        configHash(applyEnvOverrides(config, { PLUNE_MAX_RETRIES: '0' })),
      );
    },
  );

  it('keeps a negative PLUNE_MAX_RETRIES as written: the retry loop reads it as no retry', () => {
    expect(applyEnvOverrides(baseConfig, { PLUNE_MAX_RETRIES: '-1' }).provider.max_retries).toBe(
      -1,
    );
  });

  it('ignores PLUNE_MAX_RETRIES=NaN like any other non-number', () => {
    expect(
      applyEnvOverrides(baseConfig, { PLUNE_MAX_RETRIES: 'NaN' }).provider.max_retries,
    ).toBeUndefined();
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
