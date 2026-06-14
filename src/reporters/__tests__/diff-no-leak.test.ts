import { afterEach, describe, expect, it } from 'vitest';
import { renderDiff } from '../diff.js';
import { diffRuns } from '../../diff/diff.js';
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
    schema: 1,
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
});
