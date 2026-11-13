// Test-only provider for end-to-end runs without spending money or hitting the network.
// Activated via PLUNE_MOCK_PROVIDER=1 in the CLI's dirty edge (buildRealDeps), never wired into
// the default registry — production code paths cannot reach it by config alone (ADR-S10-04).

import type { Provider, ToolSpec } from '../types/provider.js';

/**
 * One scripted model turn: the calls it asks for, or its final text. A call names its tool, or `pick`s it by words of
 * the task: the one offered tool whose description holds every word. When none or several do, the call is dropped,
 * as a model that cannot tell the tools apart calls none of them; so a description reaches an offline play.
 */
export interface MockStep {
  text?: string;
  tool_calls?: ({ name: string; args?: unknown } | { pick: string; args?: unknown })[];
}

/** The offered tool whose description holds every word of `pick`, if exactly one does. */
function picked(pick: string, tools: readonly ToolSpec[]): string | undefined {
  const words = pick.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = tools.filter((t) =>
    words.every((w) => (t.description ?? '').toLowerCase().includes(w)),
  );
  return hits.length === 1 ? hits[0]!.name : undefined;
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
          typeof c === 'object' &&
          c !== null &&
          (typeof (c as { name?: unknown }).name === 'string' ||
            typeof (c as { pick?: unknown }).pick === 'string'),
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
            const calls = (entry.tool_calls ?? []).flatMap((c) => {
              const name = 'name' in c ? c.name : picked(c.pick, req.tools);
              return name === undefined ? [] : [{ name, args: c.args ?? {} }];
            });
            return Promise.resolve({
              text: entry.text ?? '',
              tool_calls: calls.map((c, i) => ({ id: `call_${step}_${i}`, ...c })),
              usage: USAGE,
              finish_reason: calls.length > 0 ? 'tool_calls' : 'stop',
            });
          },
        }
      : {}),
    estimateCost: () => ({ cost_usd: 0 }),
  };
}
