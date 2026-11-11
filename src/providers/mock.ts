// Test-only provider for end-to-end runs without spending money or hitting the network.
// Activated via PLUNE_MOCK_PROVIDER=1 in the CLI's dirty edge (buildRealDeps), never wired into
// the default registry — production code paths cannot reach it by config alone (ADR-S10-04).

import type { Provider } from '../types/provider.js';

/** One scripted model turn: the calls it asks for (by the names the model is offered), or its final text. */
export interface MockStep {
  text?: string;
  tool_calls?: { name: string; args?: unknown }[];
}

const USAGE = { input_tokens: 10, output_tokens: 5 };

/**
 * `PLUNE_MOCK_SCRIPT`: a JSON list of steps. Throws a sentence that says what is wrong; the caller makes it a config
 * error.
 */
export function parseMockScript(text: string): MockStep[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('is not JSON');
  }
  const isStep = (s: unknown): s is MockStep => {
    if (typeof s !== 'object' || s === null || Array.isArray(s)) return false;
    const { text: t, tool_calls: calls } = s as Record<string, unknown>;
    if (t !== undefined && typeof t !== 'string') return false;
    if (calls === undefined) return true;
    return (
      Array.isArray(calls) &&
      calls.every(
        (c) =>
          typeof c === 'object' && c !== null && typeof (c as { name?: unknown }).name === 'string',
      )
    );
  };
  if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every(isStep))
    throw new Error(
      'must be a non-empty list of steps, each { "text": "…" } or { "tool_calls": [{ "name": "…", "args": {} }] }',
    );
  return parsed;
}

/**
 * A Provider whose `complete()` returns a fixed response with fixed token usage and zero cost. With a `script`, it
 * also takes tools: step n of a row plays entry n, and the last entry repeats once the script runs out.
 */
export function makeMockProvider(script?: MockStep[]): Provider {
  return {
    complete: () =>
      Promise.resolve({
        output: 'mock response',
        usage: USAGE,
      }),
    ...(script !== undefined
      ? {
          respond: (req) => {
            const step = req.messages.filter((m) => m.role === 'assistant').length;
            const entry = script[Math.min(step, script.length - 1)]!;
            const calls = entry.tool_calls ?? [];
            return Promise.resolve({
              text: entry.text ?? '',
              tool_calls: calls.map((c, i) => ({
                id: `call_${step}_${i}`,
                name: c.name,
                args: c.args ?? {},
              })),
              usage: USAGE,
              finish_reason: calls.length > 0 ? 'tool_calls' : 'stop',
            });
          },
        }
      : {}),
    estimateCost: () => ({ cost_usd: 0 }),
  };
}
