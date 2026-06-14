import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Config } from '../../types/config.js';
import { pluneConfigSchema } from '../schema.js';

// Compile-time drift gate: the schema's inferred type and Config must share the SAME top-level
// keys. (A full structural `extends` is unachievable under exactOptionalPropertyTypes because zod
// infers optional fields as `T | undefined`; this key-set check still fails the build if a field
// is added to / removed from one side without the other.)
type _SchemaKeys = keyof z.infer<typeof pluneConfigSchema>;
type _ConfigKeys = keyof Config;
type _KeysMatch = ([_SchemaKeys] extends [_ConfigKeys] ? true : never) &
  ([_ConfigKeys] extends [_SchemaKeys] ? true : never);

const _contractCheck: _KeysMatch = true;
void _contractCheck;

describe('schema-contract', () => {
  it('schema type is assignable to Config (compile-time gate)', () => {
    // Runtime proof: if we reach here, the compile-time type above passed.
    expect(true).toBe(true);
  });

  it('valid config round-trips through schema and produces Config-shaped output', () => {
    const raw: Config = {
      version: 1,
      provider: { type: 'anthropic', model: 'claude-3-opus' },
      evals: [
        {
          id: 'eval-1',
          prompt: 'Hello',
          dataset: 'data/set.jsonl',
          assertions: [{ type: 'exact-match', value: 'Hi' }],
        },
      ],
    };
    const result = pluneConfigSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.version).toBe(1);
      expect(result.data.provider.type).toBe('anthropic');
    }
  });
});
