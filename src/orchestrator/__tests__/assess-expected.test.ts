import { describe, expect, it } from 'vitest';
import { assess } from '../run.js';
import type { Provider } from '../../types/provider.js';
import type { Embedder } from '../../types/embedder.js';
import type { AssertionConfig, DatasetRow } from '../../types/config.js';

// A check whose value refers to {{expected}} cannot say anything about a row that has none:
// interpolate() renders the placeholder as '', and `contains` of '' passes on every answer (#246).

const provider: Provider = {
  complete: async () => ({ output: '', usage: { input_tokens: 0, output_tokens: 0 } }),
  estimateCost: () => ({ cost_usd: 0 }),
};
const embedder: Embedder = { embed: async (texts) => texts.map(() => Float32Array.from([1, 0])) };

function assessWith(assertions: AssertionConfig[], row: DatasetRow, output: string) {
  return assess(
    {
      assertions,
      row,
      provider,
      providerConfig: { type: 'anthropic', model: 'm', temperature: 0, max_tokens: 16 },
      embedder,
    },
    output,
  );
}

const refersToExpected: AssertionConfig[] = [
  { type: 'contains', value: '{{expected}}', ignore_case: true },
];

describe('assess · a check that uses {{expected}}', () => {
  it('fails, and says why, when the row has no expected value', async () => {
    const r = await assessWith(refersToExpected, { vars: { q: 'a' } }, 'any answer at all');
    expect(r.records).toHaveLength(1);
    expect(r.records[0]!.passed).toBe(false);
    expect(r.records[0]!.reason).toMatch(/the row has no expected value/);
  });

  it('fails when the expected value is the empty string', async () => {
    const r = await assessWith(refersToExpected, { vars: { q: 'a' }, expected: '' }, 'anything');
    expect(r.records[0]!.passed).toBe(false);
  });

  it('finds {{expected}} inside a list of values too', async () => {
    const r = await assessWith(
      [{ type: 'contains-any', values: ['x', '{{ expected }}'] }],
      { vars: {} },
      'x',
    );
    expect(r.records[0]!.passed).toBe(false);
  });

  it('behaves as before when the row has an expected value', async () => {
    const row = { vars: {}, expected: 'Paris' };
    expect((await assessWith(refersToExpected, row, 'It is paris.')).records[0]!.passed).toBe(true);
    expect((await assessWith(refersToExpected, row, 'Rome')).records[0]!.passed).toBe(false);
  });

  it('leaves a check that does not use {{expected}} alone, with or without an expected value', async () => {
    const plain: AssertionConfig[] = [{ type: 'contains', value: 'hi' }];
    expect((await assessWith(plain, { vars: {} }, 'hi there')).records[0]!.passed).toBe(true);
    expect(
      (await assessWith(plain, { vars: {}, expected: '' }, 'hi there')).records[0]!.passed,
    ).toBe(true);
  });

  it('leaves a literal empty value as it is today', async () => {
    const r = await assessWith([{ type: 'contains', value: '' }], { vars: {} }, 'x');
    expect(r.records[0]!.passed).toBe(true);
  });
});
