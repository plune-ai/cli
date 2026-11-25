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

  it('sends the judge the input the answer was given for, before the output (plune-ai/cli#374)', async () => {
    const asked: string[] = [];
    const j: Judge = {
      ask: async (p) => {
        asked.push(p);
        return '{"score":1}';
      },
    };
    await llmJudge.run({
      ...ctx('the', { criteria: 'answers what was asked' }, j),
      input: 'What is the third word of this question?',
    });
    expect(asked[0]).toContain('INPUT:\nWhat is the third word of this question?\n\nOUTPUT:\nthe');
    expect(asked[0]).toMatch(/CRITERIA are about the OUTPUT given that INPUT/);
  });

  it('without an input, sends only the criteria and the output, as before', async () => {
    const asked: string[] = [];
    const j: Judge = {
      ask: async (p) => {
        asked.push(p);
        return '{"score":1}';
      },
    };
    await llmJudge.run(ctx('out', { criteria: 'x' }, j));
    expect(asked[0]).not.toContain('INPUT');
    expect(asked[0]).toContain('CRITERIA: x\n\nOUTPUT:\nout');
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

  describe('a decision judge (the experimental jev)', () => {
    const deciding = (p: number, seen: unknown[] = []): Judge => ({
      ask: async () => {
        throw new Error('ask must not be called');
      },
      decide: async (q) => {
        seen.push(q);
        return { probability: p, model: 'jev-1.14.0' };
      },
    });

    it('takes the probability as the score and passes at the threshold, 0.5 by default', async () => {
      expect(await llmJudge.run(ctx('out', { criteria: 'c' }, deciding(0.5)))).toMatchObject({ passed: true, score: 0.5 });
      expect(await llmJudge.run(ctx('out', { criteria: 'c' }, deciding(0.49)))).toMatchObject({ passed: false, score: 0.49 });
      expect(await llmJudge.run(ctx('out', { criteria: 'c', pass_threshold: 0.9 }, deciding(0.8)))).toMatchObject({ passed: false });
    });

    it('says that the judge gives no reason instead of inventing one', async () => {
      const r = await llmJudge.run(ctx('out', { criteria: 'c' }, deciding(0.731)));
      expect(r.reason).toBe('probability 0.731 that the answer meets the criteria vs threshold 0.5; this judge gives no reason');
    });

    it('is asked with the interpolated criteria, the output and the input', async () => {
      const seen: unknown[] = [];
      await llmJudge.run({ ...ctx('Paris', { criteria: 'means {{expected}}' }, deciding(1, seen)), row: { vars: {}, expected: 'Paris' }, input: 'Capital?' });
      expect(seen).toEqual([{ criteria: 'means Paris', output: 'Paris', input: 'Capital?' }]);
    });
  });
});
