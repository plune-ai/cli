import { describe, expect, it } from 'vitest';
import { faithfulness } from '../faithfulness.js';
import type { Judge } from '../../types/judge.js';
import type { FaithfulnessAssertion } from '../../types/config.js';
import type { AssertionContext } from '../../types/assertion.js';

const judgeReturning = (text: string): Judge => ({ ask: async () => text });

function ctx(
  output: string,
  params: Omit<FaithfulnessAssertion, 'type'>,
  judge?: Judge,
): AssertionContext<FaithfulnessAssertion> {
  return {
    output,
    vars: {},
    row: { vars: {} },
    params: { type: 'faithfulness', ...params },
    ...(judge !== undefined ? { judge } : {}),
  };
}

describe('faithfulness (ADR-SR02)', () => {
  it('score = faithful / total claims (AC-4)', async () => {
    const j = judgeReturning(
      '{"statements":[{"claim":"a","faithful":true},{"claim":"b","faithful":true},{"claim":"c","faithful":false}]}',
    );
    const r = await faithfulness.run(ctx('out', { context: 'ctx' }, j));
    expect(r.score).toBeCloseTo(2 / 3);
  });

  it('all faithful -> 1.0 and passes', async () => {
    const j = judgeReturning('{"statements":[{"claim":"a","faithful":true}]}');
    const r = await faithfulness.run(ctx('out', { context: 'ctx' }, j));
    expect(r.score).toBeCloseTo(1);
    expect(r.passed).toBe(true);
  });

  it('no statements -> score 1.0 (nothing to contradict)', async () => {
    const r = await faithfulness.run(
      ctx('out', { context: 'ctx' }, judgeReturning('{"statements":[]}')),
    );
    expect(r.score).toBe(1);
  });

  it('throws when no judge is present in the context', async () => {
    await expect(faithfulness.run(ctx('out', { context: 'ctx' }, undefined))).rejects.toThrow();
  });

  it('below threshold -> fail + reason', async () => {
    const j = judgeReturning(
      '{"statements":[{"claim":"a","faithful":false},{"claim":"b","faithful":false}]}',
    );
    const r = await faithfulness.run(ctx('out', { context: 'ctx' }, j));
    expect(r.passed).toBe(false);
    expect(r.reason).toBeTruthy();
  });
});
