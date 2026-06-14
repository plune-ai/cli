import { describe, it, expect } from 'vitest';
import type {
  Config,
  ProviderConfig,
  EvalConfig,
  AssertionConfig,
  DatasetRow,
} from '../config.js';

describe('Config shape (AC-03, AC-08)', () => {
  it('constructs a minimal valid Config', () => {
    const cfg: Config = {
      version: 1,
      provider: { type: 'anthropic', model: 'claude-3-5-sonnet-20241022' },
      evals: [
        {
          id: 'eval-1',
          dataset: 'data/test.jsonl',
          assertions: [{ type: 'exact-match', value: 'hello' }],
          prompt: 'Say hello',
        },
      ],
    };
    expect(cfg.version).toBe(1);
    expect(cfg.provider.type).toBe('anthropic');
    expect(cfg.evals).toHaveLength(1);
  });

  it('constructs a ProviderConfig with optional fields', () => {
    const p: ProviderConfig = {
      type: 'openai',
      model: 'gpt-4o',
      temperature: 0.5,
      max_tokens: 256,
      concurrency: 2,
    };
    expect(p.type).toBe('openai');
    expect(p.temperature).toBe(0.5);
  });

  it('constructs all 10 AssertionConfig kinds', () => {
    const kinds: AssertionConfig[] = [
      { type: 'exact-match', value: 'hello' },
      { type: 'contains', value: 'world' },
      { type: 'contains-any', values: ['a', 'b'] },
      { type: 'contains-all', values: ['x', 'y'] },
      { type: 'json-schema', schema: { type: 'object' } },
      { type: 'llm-judge', criteria: 'Is it helpful?' },
      { type: 'semantic-similarity', reference: 'baseline' },
      { type: 'faithfulness', context: 'some context' },
      { type: 'answer-relevance', question: 'What is it?' },
      { type: 'context-precision', context: 'ctx', question: 'q?' },
    ];
    expect(kinds).toHaveLength(10);
    const typeValues = kinds.map((k) => k.type);
    expect(new Set(typeValues).size).toBe(10);
  });

  it('constructs a DatasetRow with optional expected', () => {
    const row: DatasetRow = { vars: { prompt: 'hi' } };
    expect(row.vars['prompt']).toBe('hi');
    expect(row.expected).toBeUndefined();
  });

  it('EvalConfig with inline dataset', () => {
    const row: DatasetRow = { vars: { x: '1' }, expected: 'yes' };
    const cfg: EvalConfig = {
      id: 'e1',
      dataset: { examples: [row] },
      assertions: [{ type: 'contains', value: 'y' }],
      prompt: 'test',
    };
    expect(typeof cfg.dataset).toBe('object');
  });
});

// Type-level: unknown assertion kind MUST fail tsc (AC-03).
// Verified in tsconfig.check.json gate — the fixture below uses @ts-expect-error:
function _typeGate() {
  // @ts-expect-error — "unknown-kind" is not in AssertionConfig discriminated union
  const _bad: AssertionConfig = { type: 'unknown-kind' };
  void _bad;
}
