import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
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

    it('accepts every reasoning_effort the OpenAI SDK takes, and rejects a made-up one', () => {
      for (const reasoning_effort of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh']) {
        const result = pluneConfigSchema.safeParse({
          ...validBase,
          provider: { type: 'openai', model: 'gpt-6-luna', reasoning_effort },
        });
        expect(result.success, reasoning_effort).toBe(true);
      }
      const result = pluneConfigSchema.safeParse({
        ...validBase,
        provider: { type: 'openai', model: 'gpt-6-luna', reasoning_effort: 'extreme' },
      });
      expect(result.success).toBe(false);
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

  describe('AssertionConfig — all 11 kinds on the output', () => {
    const assertionFixtures = [
      { type: 'exact-match', value: 'hello', trim: true },
      { type: 'contains', value: 'hello' },
      { type: 'contains-any', values: ['a', 'b'] },
      { type: 'contains-all', values: ['a', 'b'] },
      { type: 'json-schema', schema: { type: 'object' } },
      { type: 'json-verify', expected: { a: '@isString()' }, mode: 'contains', extract: 'strict' },
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

  describe('json-verify: the expected value is checked with the config', () => {
    const issuesOf = (assertion: unknown): string[] => {
      const result = pluneConfigSchema.safeParse({
        ...validBase,
        evals: [{ ...validBase.evals[0], assertions: [assertion] }],
      });
      return result.success ? [] : result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    };

    it.each<[string, unknown]>([
      ['null', null],
      ['a number', 0],
      ['a string', 'text'],
      ['an array', [1, { a: null }]],
      ['a marker', { $mode: 'contains', $value: { a: '@isNumber() @gt(0)' } }],
      ['an escaped text', { a: '@@isString()', b: { $literal: '@nope()' } }],
    ])('accepts expected: %s', (_name, expected) => {
      expect(issuesOf({ type: 'json-verify', expected })).toEqual([]);
    });

    it('needs expected', () => {
      expect(issuesOf({ type: 'json-verify' })).toHaveLength(1);
      expect(issuesOf({ type: 'json-verify' })[0]).toMatch(/^evals\.0\.assertions\.0\.expected: /);
    });

    it('rejects a mode it does not have', () => {
      expect(issuesOf({ type: 'json-verify', expected: 1, mode: 'partial' })[0]).toMatch(
        /^evals\.0\.assertions\.0\.mode: /,
      );
    });

    it('names every broken check and marker by its JSON path', () => {
      const expected = { user: { id: '@gt()', tags: [{ $mode: 'loose', $value: [] }] }, name: '@isStrin()' };
      expect(issuesOf({ type: 'json-verify', expected })).toEqual([
        'evals.0.assertions.0.expected: $.user.id: @gt takes one number; got @gt()',
        'evals.0.assertions.0.expected: $.user.tags[0]: $mode must be one of exact, unordered, contains; got "loose"',
        expect.stringMatching(/^evals\.0\.assertions\.0\.expected: \$\.name: @isStrin is not a check function \(known: /),
      ]);
    });

    it('refuses the key __proto__ with its path, from YAML and from JSON, and does not drop it', () => {
      const fromYaml = parseYaml('user:\n  __proto__:\n    admin: true\n') as unknown;
      const fromJson = JSON.parse('{"user":{"__proto__":{"admin":true}}}') as unknown;
      for (const expected of [fromYaml, fromJson])
        expect(issuesOf({ type: 'json-verify', mode: 'contains', expected })).toEqual([
          'evals.0.assertions.0.expected: $.user.__proto__: the key __proto__ is not supported in expected',
        ]);
      expect(issuesOf({ type: 'json-verify', expected: { $literal: fromJson } })).toHaveLength(1);
    });

    it('refuses a value JSON does not have', () => {
      const fromYaml = parseYaml('limit: .inf\nratio: .nan\n') as unknown;
      expect(issuesOf({ type: 'json-verify', expected: fromYaml })).toEqual([
        'evals.0.assertions.0.expected: $.limit: Infinity is not a JSON value',
        'evals.0.assertions.0.expected: $.ratio: NaN is not a JSON value',
      ]);
      expect(issuesOf({ type: 'json-verify', expected: undefined })).toEqual([
        'evals.0.assertions.0.expected: expected is required (null is written as null)',
      ]);
    });

    it('is checked in defaults.assertions too', () => {
      const result = pluneConfigSchema.safeParse({
        ...validBase,
        defaults: { assertions: [{ type: 'json-verify', expected: '@nope()' }] },
      });
      expect(result.success).toBe(false);
    });
  });

  describe('llm-judge provider: the experimental jev judge', () => {
    const withJudge = (provider: unknown) =>
      pluneConfigSchema.safeParse({
        ...validBase,
        evals: [{ ...validBase.evals[0], assertions: [{ type: 'llm-judge', criteria: 'c', provider }] }],
      });
    const messages = (r: ReturnType<typeof withJudge>) => (r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));

    it('accepts jev with a named model, and a timeout', () => {
      expect(withJudge({ type: 'jev', model: 'jev-1.14.0' }).success).toBe(true);
      expect(withJudge({ type: 'jev', model: 'jev-1.14.0', timeout: 5000 }).success).toBe(true);
    });

    it('needs the model named: no version is picked silently', () => {
      expect(messages(withJudge({ type: 'jev' })).join('\n')).toContain('provider.model');
    });

    it('takes none of a text model\'s settings', () => {
      expect(withJudge({ type: 'jev', model: 'jev-1.14.0', temperature: 0 }).success).toBe(false);
      expect(withJudge({ type: 'jev', model: 'jev-1.14.0', max_tokens: 10 }).success).toBe(false);
    });

    it('still accepts a partial provider, and still reports its wrong field by name', () => {
      expect(withJudge({ model: 'claude-haiku-5-5' }).success).toBe(true);
      expect(messages(withJudge({ type: 'nope' })).join('\n')).toContain('provider.type');
    });

    it('is a judge only: jev cannot be the provider of a config or of an eval', () => {
      expect(pluneConfigSchema.safeParse({ ...validBase, provider: { type: 'jev', model: 'jev-1.14.0' } }).success).toBe(false);
      expect(
        pluneConfigSchema.safeParse({ ...validBase, evals: [{ ...validBase.evals[0], provider: { type: 'jev', model: 'jev-1.14.0' } }] }).success,
      ).toBe(false);
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
