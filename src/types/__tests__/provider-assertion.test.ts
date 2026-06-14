import { describe, it, expect } from 'vitest';
import type {
  Provider,
  CompletionRequest,
  CompletionResponse,
  CostEstimate,
} from '../provider.js';
import type { Assertion, AssertionContext, AssertionResult } from '../assertion.js';
import type { ProviderConfig } from '../config.js';
import type { DatasetRow } from '../config.js';

describe('Provider interface (AC-01, AC-08)', () => {
  it('CompletionRequest carries the five cache-key fields', () => {
    const req: CompletionRequest = {
      provider: 'anthropic',
      model: 'claude-3-5-sonnet-20241022',
      temperature: 0,
      max_tokens: 1024,
      prompt_resolved: 'Hello {{name}}',
    };
    expect(req.provider).toBe('anthropic');
    expect(req.model).toBe('claude-3-5-sonnet-20241022');
    expect(req.temperature).toBe(0);
    expect(req.max_tokens).toBe(1024);
    expect(req.prompt_resolved).toBe('Hello {{name}}');
  });

  it('CompletionResponse carries output and usage', () => {
    const resp: CompletionResponse = {
      output: 'Hi there',
      usage: { input_tokens: 5, output_tokens: 10 },
    };
    expect(resp.output).toBe('Hi there');
    expect(resp.usage.input_tokens).toBe(5);
  });

  it('CostEstimate carries cost_usd', () => {
    const c: CostEstimate = { cost_usd: 0.002 };
    expect(c.cost_usd).toBe(0.002);
  });
});

describe('Assertion interface (AC-08)', () => {
  it('AssertionContext carries output, vars, row, params', () => {
    const row: DatasetRow = { vars: { x: 'hello' }, expected: 'world' };
    const ctx: AssertionContext<{ threshold: number }> = {
      output: 'world',
      vars: { x: 'hello' },
      row,
      params: { threshold: 0.8 },
    };
    expect(ctx.output).toBe('world');
    expect(ctx.params.threshold).toBe(0.8);
  });

  it('AssertionResult carries passed and optional score/reason', () => {
    const r: AssertionResult = { passed: true, score: 0.9, reason: 'close enough' };
    expect(r.passed).toBe(true);
    expect(r.score).toBe(0.9);
  });

  it('AssertionResult with only required field', () => {
    const r: AssertionResult = { passed: false };
    expect(r.passed).toBe(false);
    expect(r.score).toBeUndefined();
  });
});

// Type-level: Provider<ProviderConfig> structural compliance.
// A stub class implementing the interface must compile (AC-08).
// Verified in tsconfig.check.json gate via the inline type fixture below.
function _typeGate(_provider: Provider<ProviderConfig>, _assertion: Assertion<object>) {
  // If Provider / Assertion are not importable, tsc fails here.
  void _provider;
  void _assertion;
}
