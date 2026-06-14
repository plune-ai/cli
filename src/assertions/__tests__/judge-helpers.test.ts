import { describe, expect, it } from 'vitest';
import { askJson, parseScored, parseStatements, parseQuestions } from '../judge-helpers.js';
import type { Judge } from '../../types/judge.js';

const judgeReturning = (text: string): Judge => ({ ask: async () => text });

describe('askJson (ADR-SR02)', () => {
  it('parses a JSON response into an object', async () => {
    expect(await askJson(judgeReturning('{"score":0.8}'), 'p')).toEqual({ score: 0.8 });
  });

  it('extracts JSON from a markdown-fenced response', async () => {
    expect(await askJson(judgeReturning('Sure:\n```json\n{"a":1}\n```'), 'p')).toEqual({ a: 1 });
  });

  it('throws on an unparseable response (AC-10)', async () => {
    await expect(askJson(judgeReturning('not json at all'), 'p')).rejects.toThrow();
  });
});

describe('parseScored', () => {
  it('returns score and reason', () => {
    expect(parseScored({ score: 0.7, reason: 'r' })).toEqual({ score: 0.7, reason: 'r' });
  });
  it('omits a missing or non-string reason', () => {
    expect(parseScored({ score: 0.7 })).toEqual({ score: 0.7 });
    expect(parseScored({ score: 0.7, reason: 5 })).toEqual({ score: 0.7 });
  });
  it('throws when not a JSON object', () => {
    expect(() => parseScored('nope')).toThrow();
  });
  it('throws when score is not a number', () => {
    expect(() => parseScored({ score: 'high' })).toThrow();
  });
  it('clamps an out-of-range score to [0,1] (review fix)', () => {
    expect(parseScored({ score: 1.5 })).toEqual({ score: 1 });
    expect(parseScored({ score: -0.3 })).toEqual({ score: 0 });
  });
  it('throws on a non-finite score (review fix)', () => {
    expect(() => parseScored({ score: NaN })).toThrow();
  });
});

describe('parseStatements', () => {
  it('maps faithful flags (non-object / null elements → false)', () => {
    expect(
      parseStatements({ statements: [{ faithful: true }, { faithful: false }, 'bad', null] }),
    ).toEqual([true, false, false, false]);
  });
  it('throws when statements is not an array', () => {
    expect(() => parseStatements({ statements: 'x' })).toThrow();
  });
});

describe('parseQuestions', () => {
  it('keeps only string questions', () => {
    expect(parseQuestions({ questions: ['a', 1, 'b'] })).toEqual(['a', 'b']);
  });
  it('throws when questions is not an array', () => {
    expect(() => parseQuestions({ questions: {} })).toThrow();
  });
});
