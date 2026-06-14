import { describe, expect, it } from 'vitest';
import { exactMatch } from '../exact-match.js';
import type { ExactMatchAssertion } from '../../types/config.js';
import type { AssertionContext } from '../../types/assertion.js';

function ctx(
  output: string,
  params: Omit<ExactMatchAssertion, 'type'>,
  expected?: string,
): AssertionContext<ExactMatchAssertion> {
  return {
    output,
    vars: {},
    row: { vars: {}, ...(expected !== undefined ? { expected } : {}) },
    params: { type: 'exact-match', ...params },
  };
}

describe('exact-match', () => {
  it('passes on exact equality', async () => {
    expect((await exactMatch.run(ctx('hello', { value: 'hello' }))).passed).toBe(true);
  });

  it('fails with a reason on mismatch', async () => {
    const r = await exactMatch.run(ctx('hello', { value: 'world' }));
    expect(r.passed).toBe(false);
    expect(r.reason).toBeTruthy();
  });

  it('respects trim and ignore_case (AC-3)', async () => {
    expect(
      (await exactMatch.run(ctx(' Hello ', { value: 'hello', trim: true, ignore_case: true })))
        .passed,
    ).toBe(true);
    expect((await exactMatch.run(ctx(' Hello ', { value: 'hello' }))).passed).toBe(false);
  });

  it('interpolates {{expected}} from the row (AC-8)', async () => {
    expect((await exactMatch.run(ctx('42', { value: '{{expected}}' }, '42'))).passed).toBe(true);
  });

  it('omits score for a boolean assertion (AC-9)', async () => {
    expect((await exactMatch.run(ctx('a', { value: 'a' }))).score).toBeUndefined();
  });
});
