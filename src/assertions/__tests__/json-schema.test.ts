import { describe, expect, it } from 'vitest';
import { jsonSchema } from '../json-schema.js';
import type { JsonSchemaAssertion } from '../../types/config.js';
import type { AssertionContext } from '../../types/assertion.js';

function ctx(
  output: string,
  schema: object,
  extract?: 'auto' | 'strict',
): AssertionContext<JsonSchemaAssertion> {
  return {
    output,
    vars: {},
    row: { vars: {} },
    params: { type: 'json-schema', schema, ...(extract ? { extract } : {}) },
  };
}

const objSchema = { type: 'object', properties: { a: { type: 'number' } }, required: ['a'] };

describe('json-schema', () => {
  it('strict: passes when whole output is valid JSON per schema (AC-6)', async () => {
    expect((await jsonSchema.run(ctx('{"a":1}', objSchema, 'strict'))).passed).toBe(true);
  });

  it('strict: fails (no JSON) when text surrounds the JSON', async () => {
    const r = await jsonSchema.run(ctx('result: {"a":1}', objSchema, 'strict'));
    expect(r.passed).toBe(false);
    expect(r.reason).toBeTruthy();
  });

  it('auto: extracts JSON from a fenced block and validates (AC-7)', async () => {
    const out = 'Sure:\n```json\n{"a":5}\n```';
    expect((await jsonSchema.run(ctx(out, objSchema, 'auto'))).passed).toBe(true);
  });

  it('auto is the default extract mode', async () => {
    expect((await jsonSchema.run(ctx('text {"a":1} text', objSchema))).passed).toBe(true);
  });

  it('fails with a reason when the JSON does not conform to the schema', async () => {
    const r = await jsonSchema.run(ctx('{"a":"not-a-number"}', objSchema, 'strict'));
    expect(r.passed).toBe(false);
    expect(r.reason).toBeTruthy();
  });

  it('fails (not throws) on a non-JSON output (AC-10)', async () => {
    const r = await jsonSchema.run(ctx('totally not json', objSchema, 'auto'));
    expect(r.passed).toBe(false);
    expect(r.reason).toBeTruthy();
  });

  it('fails with a reason on an invalid schema (compile error)', async () => {
    const r = await jsonSchema.run(ctx('{"a":1}', { type: 'not-a-real-type' }, 'strict'));
    expect(r.passed).toBe(false);
    expect(r.reason).toContain('invalid json-schema');
  });
});
