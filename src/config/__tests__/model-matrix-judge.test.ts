import { describe, expect, it } from 'vitest';
import { selfJudgeWarnings } from '../model-matrix.js';
import type { Config } from '../../types/config.js';

const A = { type: 'anthropic', model: 'm-a' } as const;
const B = { type: 'openai', model: 'm-b' } as const;
const judge = { type: 'llm-judge', criteria: 'polite' } as const;
const ev = (id: string, assertions: Config['evals'][number]['assertions']): Config['evals'][number] => ({
  id,
  prompt: 'p',
  dataset: { examples: [{ vars: {} }] },
  assertions,
});

describe('CLI · run · model matrix · judge warning', () => {
  it('warns once per eval whose llm-judge check names no provider while several models run', () => {
    const cfg: Config = { version: 1, provider: A, providers: [A, B], evals: [ev('x', [judge, judge]), ev('y', [{ type: 'contains', value: 'a' }])] };
    const w = selfJudgeWarnings(cfg);
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('"x"');
    expect(w[0]).toContain('judges its own answer');
  });

  it('a judge check from defaults.assertions counts for every eval', () => {
    const cfg: Config = { version: 1, provider: A, providers: [A, B], defaults: { assertions: [judge] }, evals: [ev('x', []), ev('y', [])] };
    expect(selfJudgeWarnings(cfg)).toHaveLength(2);
  });

  it('no warning when the check names its provider, with one model, or without a judge', () => {
    const named = { ...judge, provider: { type: 'anthropic', model: 'j' } } as const;
    expect(selfJudgeWarnings({ version: 1, provider: A, providers: [A, B], evals: [ev('x', [named])] })).toEqual([]);
    expect(selfJudgeWarnings({ version: 1, provider: A, evals: [ev('x', [judge])] })).toEqual([]);
  });
});
