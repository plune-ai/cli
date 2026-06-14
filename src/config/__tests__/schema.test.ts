import { describe, expect, it } from 'vitest';
import { pluneConfigSchema } from '../schema.js';

const validBase = {
  version: 1,
  provider: { type: 'anthropic', model: 'claude-3-opus' },
  evals: [
    {
      id: 'eval-1',
      prompt: 'Hello',
      dataset: 'data/set.jsonl',
      assertions: [{ type: 'exact-match', value: 'Hi' }],
    },
  ],
};

describe('pluneConfigSchema', () => {
  describe('version field', () => {
    it('accepts version: 1', () => {
      const result = pluneConfigSchema.safeParse(validBase);
      expect(result.success).toBe(true);
    });

    it('rejects version other than 1', () => {
      const result = pluneConfigSchema.safeParse({ ...validBase, version: 2 });
      expect(result.success).toBe(false);
    });
  });

  describe('provider field', () => {
    it('accepts provider.type: anthropic', () => {
      const result = pluneConfigSchema.safeParse(validBase);
      expect(result.success).toBe(true);
    });

    it('accepts provider.type: openai', () => {
      const result = pluneConfigSchema.safeParse({
        ...validBase,
        provider: { type: 'openai', model: 'gpt-4o' },
      });
      expect(result.success).toBe(true);
    });

    it('rejects unknown provider.type', () => {
      const result = pluneConfigSchema.safeParse({
        ...validBase,
        provider: { type: 'cohere', model: 'some-model' },
      });
      expect(result.success).toBe(false);
    });
  });

  describe('evals field', () => {
    it('rejects eval missing required id', () => {
      const result = pluneConfigSchema.safeParse({
        ...validBase,
        evals: [{ prompt: 'Hello', dataset: 'data.jsonl', assertions: [] }],
      });
      expect(result.success).toBe(false);
    });

    it('accepts eval with inline dataset (examples array)', () => {
      const result = pluneConfigSchema.safeParse({
        ...validBase,
        evals: [
          {
            id: 'inline-eval',
            prompt: 'Say hi',
            dataset: { examples: [{ vars: { name: 'Alice' } }] },
            assertions: [],
          },
        ],
      });
      expect(result.success).toBe(true);
    });
  });

  describe('strict mode — unknown fields rejected', () => {
    it('rejects unknown top-level field', () => {
      const result = pluneConfigSchema.safeParse({
        ...validBase,
        unknownField: 'oops',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('prompt / prompt_file mutual exclusion', () => {
    it('rejects eval with both prompt and prompt_file set', () => {
      const result = pluneConfigSchema.safeParse({
        ...validBase,
        evals: [
          {
            ...validBase.evals[0],
            prompt: 'Hello',
            prompt_file: './prompts/hello.txt',
          },
        ],
      });
      expect(result.success).toBe(false);
    });

    it('accepts eval with only prompt_file (no prompt)', () => {
      const result = pluneConfigSchema.safeParse({
        ...validBase,
        evals: [
          {
            id: 'eval-file',
            prompt_file: './prompts/hello.txt',
            dataset: 'data.jsonl',
            assertions: [],
          },
        ],
      });
      expect(result.success).toBe(true);
    });
  });

  describe('AssertionConfig — all 10 kinds', () => {
    const assertionFixtures = [
      { type: 'exact-match', value: 'hello', trim: true },
      { type: 'contains', value: 'hello' },
      { type: 'contains-any', values: ['a', 'b'] },
      { type: 'contains-all', values: ['a', 'b'] },
      { type: 'json-schema', schema: { type: 'object' } },
      { type: 'llm-judge', criteria: 'is helpful' },
      { type: 'semantic-similarity', reference: 'reference text' },
      { type: 'faithfulness', context: 'some context' },
      { type: 'answer-relevance', question: 'what is it?' },
      { type: 'context-precision', context: 'ctx', question: 'q?' },
    ] as const;

    for (const assertion of assertionFixtures) {
      it(`accepts assertion type: ${assertion.type}`, () => {
        const result = pluneConfigSchema.safeParse({
          ...validBase,
          evals: [{ ...validBase.evals[0], assertions: [assertion] }],
        });
        expect(result.success).toBe(true);
      });
    }

    it('rejects unknown assertion type', () => {
      const result = pluneConfigSchema.safeParse({
        ...validBase,
        evals: [
          {
            ...validBase.evals[0],
            assertions: [{ type: 'not-a-real-type', value: 'x' }],
          },
        ],
      });
      expect(result.success).toBe(false);
    });
  });

  describe('error collection — all errors reported together (AC-5)', () => {
    it('reports multiple validation errors in a single result', () => {
      const result = pluneConfigSchema.safeParse({
        version: 1,
        provider: { type: 'bad-provider', model: 'x' },
        evals: [{ prompt: 'p', dataset: 'd', assertions: [] }],
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        const flat = result.error.flatten();
        const allIssues = [
          ...flat.formErrors,
          ...Object.values(flat.fieldErrors).flat(),
        ];
        expect(allIssues.length).toBeGreaterThanOrEqual(2);
      }
    });
  });

  describe('providers feature — openrouter type + pricing override', () => {
    it('accepts provider.type: openrouter (OQ-2, ADR-PRV01)', () => {
      const result = pluneConfigSchema.safeParse({
        ...validBase,
        provider: { type: 'openrouter', model: 'anthropic/claude-3.5-sonnet' },
      });
      expect(result.success).toBe(true);
    });

    it('accepts a top-level pricing override map (ADR-PRV04)', () => {
      const result = pluneConfigSchema.safeParse({
        ...validBase,
        pricing: {
          'gpt-4o': { input_per_1k_usd: 0.005, output_per_1k_usd: 0.015 },
        },
      });
      expect(result.success).toBe(true);
    });

    it('rejects a pricing entry with a non-numeric price', () => {
      const result = pluneConfigSchema.safeParse({
        ...validBase,
        pricing: {
          'gpt-4o': { input_per_1k_usd: 'cheap', output_per_1k_usd: 0.015 },
        },
      });
      expect(result.success).toBe(false);
    });
  });
});
