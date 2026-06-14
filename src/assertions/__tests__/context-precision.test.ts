import { describe, expect, it } from 'vitest';
import { contextPrecision } from '../context-precision.js';
import type { Judge } from '../../types/judge.js';
import type { ContextPrecisionAssertion } from '../../types/config.js';
import type { AssertionContext } from '../../types/assertion.js';

const judgeReturning = (text: string): Judge => ({ ask: async () => text });

function ctx(
  output: string,
  params: Omit<ContextPrecisionAssertion, 'type'>,
  judge?: Judge,
): AssertionContext<ContextPrecisionAssertion> {
  return {
    output,
    vars: {},
    row: { vars: {} },
    params: { type: 'context-precision', ...params },
    ...(judge !== undefined ? { judge } : {}),
  };
}

describe('context-precision (ADR-SR02)', () => {
  it('passes on a relevant context (AC-6)', async () => {
    const r = await contextPrecision.run(
      ctx('out', { context: 'c', question: 'q' }, judgeReturning('{"score":0.9,"reason":"relevant"}')),
    );
    expect(r.passed).toBe(true);
    expect(r.score).toBeCloseTo(0.9);
  });

  it('fails on an irrelevant context, with reason', async () => {
    const r = await contextPrecision.run(
      ctx('out', { context: 'c', question: 'q' }, judgeReturning('{"score":0.3,"reason":"off-topic"}')),
    );
    expect(r.passed).toBe(false);
    expect(r.reason).toBeTruthy();
  });

  it('throws when no judge is present in the context', async () => {
    await expect(
      contextPrecision.run(ctx('out', { context: 'c', question: 'q' }, undefined)),
    ).rejects.toThrow();
  });

  it('falls back to a generated reason when the judge omits one', async () => {
    const r = await contextPrecision.run(
      ctx('out', { context: 'c', question: 'q' }, judgeReturning('{"score":0.9}')),
    );
    expect(r.passed).toBe(true);
    expect(r.reason).toContain('threshold');
  });
});
