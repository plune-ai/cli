import { describe, expect, it } from 'vitest';
import { answerRelevance } from '../answer-relevance.js';
import type { Judge } from '../../types/judge.js';
import type { Embedder } from '../../types/embedder.js';
import type { AnswerRelevanceAssertion } from '../../types/config.js';
import type { AssertionContext } from '../../types/assertion.js';

const judgeReturning = (text: string): Judge => ({ ask: async () => text });
const embedderFrom = (map: Record<string, number[]>): Embedder => ({
  embed: async (texts) => texts.map((t) => Float32Array.from(map[t] ?? [0, 0, 0])),
});

function ctx(
  output: string,
  params: Omit<AnswerRelevanceAssertion, 'type'>,
  judge?: Judge,
  embedder?: Embedder,
): AssertionContext<AnswerRelevanceAssertion> {
  return {
    output,
    vars: {},
    row: { vars: {} },
    params: { type: 'answer-relevance', ...params },
    ...(judge !== undefined ? { judge } : {}),
    ...(embedder !== undefined ? { embedder } : {}),
  };
}

describe('answer-relevance (ADR-SR02)', () => {
  it('passes on high mean cosine to the question (AC-5)', async () => {
    const j = judgeReturning('{"questions":["q1","q2"]}');
    const emb = embedderFrom({ 'the question': [1, 0, 0], q1: [1, 0, 0], q2: [1, 0, 0] });
    const r = await answerRelevance.run(ctx('out', { question: 'the question' }, j, emb));
    expect(r.passed).toBe(true);
    expect(r.score).toBeCloseTo(1);
  });

  it('fails on low similarity, with reason', async () => {
    const j = judgeReturning('{"questions":["q1"]}');
    const emb = embedderFrom({ 'the question': [1, 0, 0], q1: [0, 1, 0] });
    const r = await answerRelevance.run(ctx('out', { question: 'the question' }, j, emb));
    expect(r.passed).toBe(false);
    expect(r.reason).toBeTruthy();
  });

  it('floors a negative mean cosine at 0 (review fix)', async () => {
    const j = judgeReturning('{"questions":["q1"]}');
    const emb = embedderFrom({ 'the question': [1, 0, 0], q1: [-1, 0, 0] });
    const r = await answerRelevance.run(ctx('out', { question: 'the question' }, j, emb));
    expect(r.score).toBe(0);
    expect(r.passed).toBe(false);
  });

  it('throws when the embedder is missing', async () => {
    await expect(
      answerRelevance.run(ctx('out', { question: 'q' }, judgeReturning('{"questions":["q1"]}'), undefined)),
    ).rejects.toThrow();
  });

  it('throws when the judge is missing', async () => {
    await expect(
      answerRelevance.run(ctx('out', { question: 'q' }, undefined, embedderFrom({}))),
    ).rejects.toThrow();
  });

  it('fails with score 0 when the judge generates no questions', async () => {
    const r = await answerRelevance.run(
      ctx('out', { question: 'q' }, judgeReturning('{"questions":[]}'), embedderFrom({})),
    );
    expect(r.passed).toBe(false);
    expect(r.score).toBe(0);
  });

  it('throws when the embedder returns fewer vectors than inputs', async () => {
    const j = judgeReturning('{"questions":["q1","q2"]}');
    const shortEmb: Embedder = { embed: async () => [Float32Array.from([1, 0, 0])] };
    await expect(
      answerRelevance.run(ctx('out', { question: 'q' }, j, shortEmb)),
    ).rejects.toThrow();
  });
});
