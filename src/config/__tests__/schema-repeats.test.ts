import { describe, expect, it } from 'vitest';
import { MAX_RUNS, pluneConfigSchema } from '../schema.js';

const ev = {
  id: 'eval-1',
  prompt: 'Hello',
  dataset: 'data/set.jsonl',
  assertions: [{ type: 'exact-match', value: 'Hi' }],
};
const base = { version: 1, provider: { type: 'anthropic', model: 'm' }, evals: [ev] };

const atRoot = (extra: object) => pluneConfigSchema.safeParse({ ...base, ...extra });
const onEval = (extra: object) =>
  pluneConfigSchema.safeParse({ ...base, evals: [{ ...ev, ...extra }] });
const messages = (r: ReturnType<typeof atRoot>) =>
  r.success ? [] : r.error.issues.map((i) => i.message);

describe('CLI · run · repeats · runs and pass_threshold in plune.yaml', () => {
  it('accepts both at the root and on an eval', () => {
    expect(atRoot({ runs: 5, pass_threshold: 0.8 }).success).toBe(true);
    expect(onEval({ runs: MAX_RUNS, pass_threshold: 1 }).success).toBe(true);
  });

  it.each([atRoot, onEval])(
    'rejects pass_threshold 0, runs 0, a fractional runs and runs above the cap',
    (parse) => {
      expect(parse({ pass_threshold: 0 }).success).toBe(false);
      expect(parse({ pass_threshold: 1.1 }).success).toBe(false);
      expect(parse({ runs: 0 }).success).toBe(false);
      expect(parse({ runs: 2.5 }).success).toBe(false);
      expect(parse({ runs: MAX_RUNS + 1 }).success).toBe(false);
    },
  );

  it('caps runs at 100', () => {
    expect(MAX_RUNS).toBe(100);
  });

  it('the error names which pass_threshold it is about', () => {
    expect(messages(onEval({ pass_threshold: 0 })).join(' ')).toMatch(/share of runs/);
    const judge = onEval({ assertions: [{ type: 'llm-judge', criteria: 'c', pass_threshold: 2 }] });
    expect(messages(judge).join(' ')).toMatch(/judge score/);
  });
});
