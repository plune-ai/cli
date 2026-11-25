import { describe, expect, it } from 'vitest';
import { jevAddressCheck } from '../run.js';
import { RunConfigError } from '../../../orchestrator/run.js';
import type { AssertionConfig, Config } from '../../../types/config.js';

const config = (assertions: AssertionConfig[], defaults?: AssertionConfig[]): Config => ({
  version: 1,
  provider: { type: 'openai', model: 'm' },
  ...(defaults !== undefined ? { defaults: { assertions: defaults } } : {}),
  evals: [{ id: 'e', prompt: 'p', dataset: { examples: [{ vars: {} }] }, assertions }],
});
const JEV: AssertionConfig = { type: 'llm-judge', criteria: 'c', provider: { type: 'jev', model: 'jev-1.14.0' } };
const LOCAL = { TYPESAFE_BASE_URL: 'http://localhost:8080' };

describe('plune run · the address of a jev judge', () => {
  it('stops the run as a config error when the address is outside typesafe.ai', () => {
    expect(() => jevAddressCheck(config([JEV]), LOCAL)).toThrow(RunConfigError);
    expect(() => jevAddressCheck(config([JEV]), LOCAL)).toThrow('PLUNE_JEV_BASE_URL=https://api.typesafe.ai');
  });

  it('finds a jev judge among the default checks too', () => {
    expect(() => jevAddressCheck(config([{ type: 'contains', value: 'x' }], [JEV]), LOCAL)).toThrow(RunConfigError);
  });

  it('leaves a run with no jev judge alone, whatever TYPESAFE_BASE_URL says', () => {
    expect(() => jevAddressCheck(config([{ type: 'llm-judge', criteria: 'c' }]), LOCAL)).not.toThrow();
  });

  it('passes with nothing set, and with the address set for plune alone', () => {
    expect(() => jevAddressCheck(config([JEV]), {})).not.toThrow();
    expect(() => jevAddressCheck(config([JEV]), { ...LOCAL, PLUNE_JEV_BASE_URL: 'https://api.typesafe.ai' })).not.toThrow();
  });
});
