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

describe('PRICE_TABLE — OpenRouter ids the agent scenarios can run on', () => {
  // A dry run prices a model from this table only, so an unlisted id plans at $0.
  // openrouter.ai/api/v1/models, per million tokens, read on 2026-11-18.
  it.each([
    ['deepseek/deepseek-v4-flash', 0.09, 0.18],
    ['qwen/qwen3.7-flash', 0.03, 0.13],
    ['google/gemini-2.5-flash-lite', 0.1, 0.4],
    ['mistralai/mistral-small-3.2-24b-instruct', 0.075, 0.2],
    ['openai/gpt-oss-120b', 0.15, 0.6],
    ['anthropic/claude-haiku-5.5', 0.1, 0.5],
    ['z-ai/glm-5.3-flash', 0.0399, 0.0784],
    // The middle tier
    ['moonshotai/kimi-k2.6', 0.65, 3.41],
    ['minimax/minimax-m3', 0.3, 1.2],
    ['qwen/qwen3.7-plus', 0.32, 1.28],
    ['google/gemini-3.8-flash', 0.825, 4.125],
    ['deepseek/deepseek-v4-pro', 0.9, 1.5],
    ['openai/gpt-6.1-terra', 1, 5],
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
