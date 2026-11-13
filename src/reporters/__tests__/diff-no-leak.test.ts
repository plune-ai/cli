import { afterEach, describe, expect, it } from 'vitest';
import { renderDiff } from '../diff.js';
import { diffRuns } from '../../diff/diff.js';
import { evaluateGates } from '../../diff/gates.js';
import type { RunResult, EvalResult } from '../../types/results.js';

// NFR-2 / AC-5.3 guard: the diff reporter renders only eval ids + pass/fail transitions — never
// row content and never the environment. This test plants a secret in BOTH a row output and the
// env, then asserts no diff format echoes it. If the diff is ever extended to include row output,
// this fails — which is the point.

const SECRET = 'sk-or-v1-TOPSECRET-DO-NOT-LEAK';

function ev(id: string, passed: boolean, output: string): EvalResult {
  return {
    id,
    tags: [],
    passed,
    rows: [{ vars: {}, output, cached: false, assertions: [{ type: 'exact-match', passed }] }],
  };
}
function run(evals: EvalResult[]): RunResult {
  return {
    schemaVersion: 1,
    plune_version: '0',
    started_at: '',
    finished_at: '',
    config_hash: '',
    summary: { total: evals.length, passed: 0, failed: 0, errored: 0, cost_usd: 0, duration_ms: 0 },
    evals,
  };
}

describe('diff output never leaks secrets (NFR-2, AC-5.3)', () => {
  const prev = process.env['OPENROUTER_API_KEY'];
  afterEach(() => {
    if (prev === undefined) delete process.env['OPENROUTER_API_KEY'];
    else process.env['OPENROUTER_API_KEY'] = prev;
  });

  it('does not surface row outputs or env API keys in any format', () => {
    process.env['OPENROUTER_API_KEY'] = SECRET;
    const baseline = run([ev('a', true, 'fine')]);
    const current = run([ev('a', false, `leaked ${SECRET}`)]);
    const d = diffRuns(baseline, current);
    for (const fmt of ['console', 'json', 'markdown'] as const) {
      expect(renderDiff(d, fmt)).not.toContain(SECRET);
    }
  });

  it('CLI · diff · gates · the Gates section shows values and ids, never row content or the environment', () => {
    process.env['OPENROUTER_API_KEY'] = SECRET;
    const baseline = run([ev('a', true, 'fine')]);
    const current = run([ev('a', false, `leaked ${SECRET}`), ev('b', true, SECRET)]);
    const d = diffRuns(baseline, current);
    const gated = {
      ...d,
      gates: evaluateGates(
        baseline,
        current,
        d,
        { failOnRegression: true, maxPassRateDropPercent: 1, maxCostUsd: 1, maxCostIncreasePercent: 1, maxTokens: 1 },
        [],
        new Date('2026-11-13T00:00:00Z'),
      ),
    };
    for (const fmt of ['console', 'json', 'markdown'] as const) {
      expect(renderDiff(gated, fmt)).not.toContain(SECRET);
    }
  });
});

describe('CLI · diff · advice · the advice sections show names and numbers, never row content or the environment (AC-12)', () => {
  it('CLI · diff · advice · repeats, arguments, results and the environment are not echoed in any format', async () => {
    const { adviceFor } = await import('../../diff/advice.js');
    process.env['OPENROUTER_API_KEY'] = SECRET;
    const side = (passed: number, swap: boolean): RunResult => {
      const agent = {
        server: 'fx',
        tools: [],
        steps: [
          {
            index: 1,
            text: SECRET,
            usage: { input_tokens: 0, output_tokens: 0, cost_usd: 0 },
            calls: [
              {
                id: 'c',
                name: 'search',
                args: { token: SECRET },
                executed: true,
                is_error: false,
                result: { text: `{"id":"${SECRET}"}`, bytes: 10, truncated: false },
              },
            ],
          },
        ],
        stop: { reason: 'complete' as const },
        collection: 'complete' as const,
        advice: [{ type: 'search-after-id', reason: 'x', tool: 'search', paths: ['items[].id'] }],
        ...(swap ? { description_overrides: [{ tool: 'search', sha256: 'f'.repeat(64) }] } : {}),
      };
      const e: EvalResult = {
        id: 'a',
        tags: [],
        passed: true,
        measured: {
          runs: 10,
          rows: 1,
          rows_hash: 'r',
          assertions_hash: 'c',
        },
        rows: [
          {
            vars: { q: SECRET },
            output: SECRET,
            cached: false,
            assertions: [{ type: 'exact-match', passed: true }],
            agent,
            attempts: {
              runs: 10,
              pass_threshold: 0.1,
              passed,
              failed: 10 - passed,
              errored: 0,
              results: Array.from({ length: 10 }, (_, i) => ({
                output: SECRET,
                cached: false,
                assertions: [{ type: 'first-tool', passed: i < passed, reason: SECRET }],
              })),
            },
          },
        ],
      };
      return run([e]);
    };
    const baseline = side(9, false);
    const current = side(3, true);
    const advice = adviceFor(baseline, current)!;
    expect(advice.experiment!.evals).toHaveLength(1);
    expect(advice.evals[0]!.comparison!.word).toBe('worse');
    const d = { ...diffRuns(baseline, current), advice };
    for (const fmt of ['console', 'json', 'markdown'] as const) {
      const text = renderDiff(d, fmt);
      expect(text, fmt).toContain('worse');
      expect(text, fmt).not.toContain(SECRET);
    }
  });
});
