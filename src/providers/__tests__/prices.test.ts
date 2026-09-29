// The built-in table is what a run's cost line is made of when the config carries no `pricing:`.
// Until #48 it stopped at Claude 3.x and gpt-4o, so a project on any current model read
// `cost_usd = 0` and a warning per call — a cost that was missing rather than wrong, which is the
// kind nobody checks.

import { describe, expect, it } from 'vitest';
import { PRICE_TABLE } from '../prices.js';

describe('PRICE_TABLE — current models (#48)', () => {
  // [model id, USD per million input tokens, USD per million output tokens], as the providers'
  // own price pages state them; the table keeps them per thousand.
  it.each([
    // Anthropic — platform.claude.com/docs/en/about-claude/pricing
    ['claude-fable-5-1', 10, 50],
    ['claude-opus-5-5', 4, 20],
    ['claude-sonnet-5-5', 2, 10],
    ['claude-haiku-4-5', 1, 5],
    // Haiku 4.5 has a dated id too; a config may name either.
    ['claude-haiku-4-5-20251001', 1, 5],
    // OpenAI — developers.openai.com/api/docs/pricing, standard tier, short context
    ['gpt-6-astra', 10, 50],
    ['gpt-6.1-sol', 2, 10],
    ['gpt-6-luna', 0.1, 0.5],
  ])('prices %s at $%s in / $%s out per million tokens', (model, inPerMillion, outPerMillion) => {
    const price = PRICE_TABLE[model];

    expect(price).toBeDefined();
    expect(price!.input_per_1k_usd).toBeCloseTo(inPerMillion / 1000, 10);
    expect(price!.output_per_1k_usd).toBeCloseTo(outPerMillion / 1000, 10);
  });
});

describe('PRICE_TABLE — ids older configs already name', () => {
  // Nobody's plune.yaml is edited for them; a row that vanished would turn a project's cost to
  // zero the day it upgraded.
  it.each([
    'claude-3-5-haiku-latest',
    'claude-3-5-sonnet-latest',
    'claude-3-opus-latest',
    'gpt-4o',
    'gpt-4o-mini',
    'openai/gpt-4o',
    'openai/gpt-4o-mini',
  ])('still prices %s', (model) => {
    expect(PRICE_TABLE[model]).toBeDefined();
  });
});
