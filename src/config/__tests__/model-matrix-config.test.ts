import { describe, expect, it } from 'vitest';
import { pluneConfigSchema } from '../schema.js';
import { applyEnvOverrides } from '../env-overrides.js';
import { ConfigValidationError } from '../errors.js';
import { configHash } from '../../util/hash.js';
import type { Config } from '../../types/config.js';

const evals = [
  {
    id: 'greet',
    prompt: 'Hello',
    dataset: 'data/set.jsonl',
    assertions: [{ type: 'exact-match', value: 'Hi' }],
  },
];
const A = { type: 'anthropic', model: 'claude-a' };
const B = { type: 'openai', model: 'gpt-b' };

function parse(provider: unknown) {
  return pluneConfigSchema.safeParse({ version: 1, provider, evals });
}

describe('CLI · run · model matrix · provider list in the config', () => {
  it('a one-element list is the same config as the object (same hash)', () => {
    const obj = parse(A);
    const list = parse([A]);
    expect(obj.success && list.success).toBe(true);
    if (!obj.success || !list.success) return;
    expect(list.data).toEqual(obj.data);
    expect(configHash(list.data as unknown as Config)).toBe(configHash(obj.data as unknown as Config));
    expect(list.data).not.toHaveProperty('providers');
  });

  it('a list of several models keeps the first as provider and all of them in config order as providers', () => {
    const r = parse([A, B]);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.provider).toEqual(A);
    expect(r.data.providers).toEqual([A, B]);
  });

  it('rejects an empty list', () => {
    expect(parse([]).success).toBe(false);
  });

  it('rejects a duplicate type + model pair', () => {
    const r = parse([A, { ...B }, { ...A, temperature: 0 }]);
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error.issues.map((i) => i.message).join('\n')).toMatch(/anthropic\/claude-a.*twice|twice.*anthropic\/claude-a/);
  });

  it('rejects the same model name under two types (the cell id would clash)', () => {
    expect(parse([A, { type: 'openrouter', model: 'claude-a' }]).success).toBe(false);
  });

  it('rejects an eval that pins its own type or model while several models run', () => {
    const r = pluneConfigSchema.safeParse({
      version: 1,
      provider: [A, B],
      evals: [{ ...evals[0], provider: { model: 'other' } }],
    });
    expect(r.success).toBe(false);
  });

  it('lets an eval tune temperature while several models run', () => {
    const r = pluneConfigSchema.safeParse({
      version: 1,
      provider: [A, B],
      evals: [{ ...evals[0], provider: { temperature: 0 } }],
    });
    expect(r.success).toBe(true);
  });

  it('PLUNE_PROVIDER and PLUNE_MODEL are refused for a list of several models', () => {
    const r = parse([A, B]);
    if (!r.success) throw new Error('setup');
    const cfg = r.data as unknown as Config;
    expect(() => applyEnvOverrides(cfg, { PLUNE_MODEL: 'x' })).toThrow(ConfigValidationError);
    expect(() => applyEnvOverrides(cfg, { PLUNE_PROVIDER: 'openai' })).toThrow(ConfigValidationError);
  });

  it('PLUNE_TIMEOUT and PLUNE_MAX_RETRIES reach every model of the list', () => {
    const r = parse([A, B]);
    if (!r.success) throw new Error('setup');
    const out = applyEnvOverrides(r.data as unknown as Config, { PLUNE_TIMEOUT: '5', PLUNE_MAX_RETRIES: '2' });
    expect(out.providers?.map((p) => [p.timeout, p.max_retries])).toEqual([[5, 2], [5, 2]]);
    expect(out.provider.timeout).toBe(5);
  });
});
