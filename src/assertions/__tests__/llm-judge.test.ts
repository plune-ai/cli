import { describe, expect, it } from 'vitest';
import { llmJudge } from '../llm-judge.js';
import type { Judge } from '../../types/judge.js';
import type { LlmJudgeAssertion } from '../../types/config.js';
import type { AssertionContext } from '../../types/assertion.js';
import { ProviderError } from '../../providers/errors.js';

const judgeReturning = (text: string): Judge => ({ ask: async () => text });

function ctx(
  output: string,
  params: Omit<LlmJudgeAssertion, 'type'>,
  judge?: Judge,
): AssertionContext<LlmJudgeAssertion> {
  return {
    output,
    vars: {},
    row: { vars: {} },
    params: { type: 'llm-judge', ...params },
    ...(judge !== undefined ? { judge } : {}),
  };
}

describe('llm-judge (ADR-SR02)', () => {
  it('passes when score >= pass_threshold; sets score + reason (AC-1)', async () => {
    const r = await llmJudge.run(
      ctx('out', { criteria: 'be helpful' }, judgeReturning('{"score":0.9,"reason":"good"}')),
    );
    expect(r.passed).toBe(true);
    expect(r.score).toBeCloseTo(0.9);
    expect(r.reason).toBeTruthy();
  });

  it('fails below the default 0.5; pass_threshold changes the verdict (AC-2)', async () => {
    const j = judgeReturning('{"score":0.4,"reason":"meh"}');
    expect((await llmJudge.run(ctx('out', { criteria: 'x' }, j))).passed).toBe(false);
    expect((await llmJudge.run(ctx('out', { criteria: 'x', pass_threshold: 0.3 }, j))).passed).toBe(
      true,
    );
  });

  it('throws when no judge is present in the context (AC-3)', async () => {
    await expect(llmJudge.run(ctx('out', { criteria: 'x' }, undefined))).rejects.toThrow();
  });

  it('falls back to a generated reason when the judge omits one', async () => {
    const r = await llmJudge.run(ctx('out', { criteria: 'x' }, judgeReturning('{"score":0.9}')));
    expect(r.reason).toContain('threshold');
  });

  it('propagates a ProviderError from the judge (AC-10)', async () => {
    const j: Judge = {
      ask: async () => {
        throw new ProviderError('PROVIDER_TRANSIENT_EXHAUSTED', 'judge down');
      },
    };
    await expect(llmJudge.run(ctx('out', { criteria: 'x' }, j))).rejects.toBeInstanceOf(
      ProviderError,
    );
  });
});
