import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { assertionConfigSchema } from '../../config/schema.js';
import { jsonVerify } from '../json-verify.js';
import { getAssertion } from '../registry.js';
import type { JsonVerifyAssertion } from '../../types/config.js';
import type { AssertionContext } from '../../types/assertion.js';

function ctx(
  output: string,
  expected: unknown,
  rest: Omit<JsonVerifyAssertion, 'type' | 'expected'> = {},
): AssertionContext<JsonVerifyAssertion> {
  return { output, vars: {}, row: { vars: {} }, params: { type: 'json-verify', expected, ...rest } };
}

describe('CLI · run · json-verify', () => {
  it('passes when the answer is the expected JSON; the default mode is exact', async () => {
    expect(await jsonVerify.run(ctx('{"a":1,"b":[1,2]}', { b: [1, 2], a: 1 }))).toEqual({ passed: true });
    const extra = await jsonVerify.run(ctx('{"a":1,"b":2}', { a: 1 }));
    expect(extra).toEqual({ passed: false, reason: '1 mismatch\n    $.b: extra key\n      actual:   2' });
  });

  it('mode: contains accepts more keys and elements, and checks written in the expected JSON', async () => {
    const expected = { user: { email: '@matchesRegex("@plune\\.ai$")' }, items: [{ sku: 'A' }], total: '@isNumber() @gt(0)' };
    const good = '{"user":{"name":"John Doe","email":"user@plune.ai"},"items":[{"sku":"B"},{"sku":"A","qty":2}],"total":12.5}';
    expect(await jsonVerify.run(ctx(good, expected, { mode: 'contains' }))).toEqual({ passed: true });
    const bad = '{"user":{"email":"user@example.com"},"items":[{"sku":"B"}],"total":0}';
    expect(await jsonVerify.run(ctx(bad, expected, { mode: 'contains' }))).toEqual({
      passed: false,
      reason: [
        '3 mismatches',
        '    $.user.email: function not satisfied: @matchesRegex("@plune\\.ai$")',
        '      expected: "@matchesRegex(\\"@plune\\\\.ai$\\")"',
        '      actual:   "user@example.com"',
        '    $.items[0]: no match for an array element',
        '      expected: {"sku":"A"}',
        '    $.total: function not satisfied: @gt(0)',
        '      expected: "@isNumber() @gt(0)"',
        '      actual:   0',
      ].join('\n'),
    });
  });

  it('mode: unordered ignores the order of arrays only', async () => {
    expect((await jsonVerify.run(ctx('[2,1]', [1, 2], { mode: 'unordered' }))).passed).toBe(true);
    expect((await jsonVerify.run(ctx('[2,1]', [1, 2]))).passed).toBe(false);
    expect((await jsonVerify.run(ctx('[2,1,3]', [1, 2], { mode: 'unordered' }))).passed).toBe(false);
  });

  it('auto, the default, finds the JSON in a fenced block or in the text around it', async () => {
    expect((await jsonVerify.run(ctx('Sure:\n```json\n{"a":1}\n```', { a: 1 }))).passed).toBe(true);
    expect((await jsonVerify.run(ctx('The answer is {"a":1}.', { a: 1 }, { extract: 'auto' }))).passed).toBe(true);
  });

  it('strict takes the whole answer, so a bare number or string can be checked', async () => {
    expect((await jsonVerify.run(ctx(' 42 ', '@gt(40)', { extract: 'strict' }))).passed).toBe(true);
    expect(await jsonVerify.run(ctx('The answer is {"a":1}.', { a: 1 }, { extract: 'strict' }))).toEqual({
      passed: false,
      reason: 'output is not valid JSON (extract mode: strict)',
    });
  });

  it('an answer that is not JSON is a failed check with a reason, not an error', async () => {
    expect(await jsonVerify.run(ctx('I cannot help with that.', { a: 1 }))).toEqual({
      passed: false,
      reason: 'output is not valid JSON (extract mode: auto)',
    });
  });

  it('an answer of JSON null is compared, not taken for "no JSON"', async () => {
    expect((await jsonVerify.run(ctx('null', null, { extract: 'strict' }))).passed).toBe(true);
    expect((await jsonVerify.run(ctx('null', '@isNotNull()', { extract: 'strict' }))).passed).toBe(false);
  });

  it('is registered under its type', () => {
    expect(getAssertion('json-verify')).toBe(jsonVerify);
  });
});

describe('CLI · run · json-verify · the examples of the assertions guide', () => {
  const guide = readFileSync(fileURLToPath(new URL('../../../docs/guide/assertions.md', import.meta.url)), 'utf8');
  const examples = [...guide.matchAll(/```yaml\n(- type: json-verify\n[\s\S]*?)```/g)].map(
    (m) => (parseYaml(m[1]!) as unknown[])[0],
  );
  // One answer each example accepts and one it does not, in the order of the guide.
  const ANSWERS: [string, string][] = [
    [
      '{"id":7,"name":"John Doe","email":"user@plune.ai","roles":["editor","admin"]}',
      '{"name":"John Doe","email":"user at plune.ai","roles":["editor"]}',
    ],
    [
      '{"tags":["urgent","billing"],"confidence":0.9,"label":"bug"}',
      '{"tags":["urgent","billing"],"confidence":0.9,"label":"bug","note":"extra"}',
    ],
    [
      '{"items":[{"sku":"B-200","qty":1},{"sku":"C-300","qty":0},{"sku":"A-100","qty":3,"gift":true}],"total":4}',
      '{"items":[{"sku":"B-200","qty":1},{"sku":"A-100","qty":0}]}',
    ],
  ];

  it('there are three, and the config schema accepts each', () => {
    expect(examples).toHaveLength(3);
    for (const example of examples) expect(assertionConfigSchema.safeParse(example).error?.issues).toBeUndefined();
  });

  it.each([0, 1, 2])('example %i passes on an answer it describes and fails on one it does not', async (i) => {
    const params = assertionConfigSchema.parse(examples[i]) as JsonVerifyAssertion;
    const run = (output: string) => jsonVerify.run({ output, vars: {}, row: { vars: {} }, params });
    expect(await run(ANSWERS[i]![0])).toEqual({ passed: true });
    expect((await run(ANSWERS[i]![1])).passed).toBe(false);
  });

  it('the failure text shown in the guide is the text of the first example', async () => {
    const shown = /```text\n(2 mismatches\n[\s\S]*?)\n```/.exec(guide)![1];
    const params = assertionConfigSchema.parse(examples[0]) as JsonVerifyAssertion;
    const result = await jsonVerify.run({ output: ANSWERS[0]![1], vars: {}, row: { vars: {} }, params });
    expect(result.reason).toBe(shown);
  });

  it('the $literal example of the guide expects the object it says', async () => {
    expect((await jsonVerify.run(ctx('{"$mode":"dark"}', { $literal: { $mode: 'dark' } }))).passed).toBe(true);
  });
});
