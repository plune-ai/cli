import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assertionConfigSchema } from '../../config/schema.js';
import { getAssertion } from '../registry.js';

// The reference set of json-verify: pairs of an expected value and an answer as a model writes it, each with
// the verdict the assertions guide gives it. Every pair goes the way `plune run` takes: the config schema,
// then the assertion from the registry, so finding the JSON in the answer is part of what is checked.

interface Pair {
  name: string;
  /** `llm-variation`: the same expected value against answers that differ the way a model's answers do. */
  kind: 'llm-variation' | 'fixed';
  mode: 'exact' | 'unordered' | 'contains';
  extract?: 'auto' | 'strict';
  expected: unknown;
  actual: string;
  verdict: 'pass' | 'fail';
  /** A failed comparison: every difference in order, `kind` being the text after the path. */
  mismatches?: { path: string; kind: string }[];
  /** A failure that is not a comparison (no JSON in the answer): the whole reason. */
  reason?: string;
}

const pairs = JSON.parse(
  readFileSync(new URL('./fixtures/json-verify-pairs.json', import.meta.url), 'utf8'),
) as Pair[];

describe('CLI · run · json-verify · reference pairs', () => {
  it('there are at least 30, at least 10 of them answers that vary as a model does, both verdicts in each kind', () => {
    expect(pairs.length).toBeGreaterThanOrEqual(30);
    const varied = pairs.filter((p) => p.kind === 'llm-variation');
    expect(varied.length).toBeGreaterThanOrEqual(10);
    for (const list of [varied, pairs.filter((p) => p.kind === 'fixed')])
      expect(new Set(list.map((p) => p.verdict))).toEqual(new Set(['pass', 'fail']));
    expect(new Set(pairs.map((p) => p.name)).size).toBe(pairs.length);
    // A failed pair says what the failure is, in exactly one of the two ways.
    for (const p of pairs)
      expect([
        p.name,
        (p.mismatches !== undefined ? 1 : 0) + (p.reason !== undefined ? 1 : 0),
      ]).toEqual([p.name, p.verdict === 'fail' ? 1 : 0]);
  });

  it.each(pairs)('$name', async (pair) => {
    const params = assertionConfigSchema.parse({
      type: 'json-verify',
      expected: pair.expected,
      mode: pair.mode,
      ...(pair.extract === undefined ? {} : { extract: pair.extract }),
    });
    const result = await getAssertion('json-verify').run({
      output: pair.actual,
      vars: {},
      row: { vars: {} },
      params,
    });

    if (pair.verdict === 'pass') {
      expect(result).toEqual({ passed: true });
    } else if (pair.mismatches === undefined) {
      expect(result).toEqual({ passed: false, reason: pair.reason });
    } else {
      expect(result.passed).toBe(false);
      const lines = (result.reason ?? '').split('\n');
      // The first line is the count; a difference starts at four spaces, its fragments at six.
      expect(lines[0]).toBe(
        `${pair.mismatches.length} ${pair.mismatches.length === 1 ? 'mismatch' : 'mismatches'}`,
      );
      expect(lines.filter((line) => /^ {4}\S/.test(line)).map((line) => line.slice(4))).toEqual(
        pair.mismatches.map((m) => `${m.path}: ${m.kind}`),
      );
    }
  });
});
