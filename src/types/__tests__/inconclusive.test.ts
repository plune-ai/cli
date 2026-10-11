import { describe, expect, it } from 'vitest';
import { parseRunResult, runResultSchema } from '../run-result-schema.js';

/**
 * ADR 0045 / plune#1244 — `inconclusive` on a result row.
 *
 * The runner must be able to say "the product was never judged" instead of letting `failed` stand for
 * both a broken environment and broken code. The Plune platform already accepts the field
 * (`Plune/src/contracts/run-result.ts`); this file pins the producer's half of the same contract —
 * the runner is the only place the field can be born, and a runner that cannot emit it leaves the
 * platform's acceptance unreachable.
 *
 * Additive and optional on purpose: output that does not send it validates exactly as before, so
 * `schemaVersion` stays 1 (ADR 0045 §2).
 */

const base = {
  schemaVersion: 1,
  plune_version: '0.17.0',
  started_at: '2026-10-11T00:00:00.000Z',
  finished_at: '2026-10-11T00:00:01.000Z',
  config_hash: 'abc',
  summary: { total: 1, passed: 1, failed: 0, errored: 0, cost_usd: 0, duration_ms: 1 },
  evals: [
    {
      id: 'e1',
      tags: [],
      rows: [
        {
          vars: {},
          output: null,
          cached: false,
          assertions: [{ type: 'exact-match', passed: true }],
        },
      ],
      passed: true,
    },
  ],
};

function withInconclusive(value: string): typeof base {
  const cloned = structuredClone(base);
  (cloned.evals[0]!.rows[0] as { inconclusive?: unknown }).inconclusive = value;
  return cloned;
}

describe('runResultSchema — inconclusive (ADR 0045, plune#1244)', () => {
  it('accepts a row saying the product was never judged (blocked)', () => {
    const parsed = parseRunResult(withInconclusive('blocked'));
    expect(parsed.evals[0]!.rows[0]!.inconclusive).toBe('blocked');
  });

  it('accepts `skipped` — the other half of the enum', () => {
    const parsed = parseRunResult(withInconclusive('skipped'));
    expect(parsed.evals[0]!.rows[0]!.inconclusive).toBe('skipped');
  });

  it('still accepts output WITHOUT the field (optional, additive — schemaVersion stays 1)', () => {
    const parsed = parseRunResult(base);
    expect(parsed.evals[0]!.rows[0]!.inconclusive).toBeUndefined();
    expect(parsed.schemaVersion).toBe(1);
  });

  it('rejects a value outside the enum — `invalid` is `broken` in Plune (ADR 0045 §1)', () => {
    // The trap this pins: Qase calls it `invalid`, Plune calls it `broken` and the field would then
    // be a second word for one idea. Accepting it would fork the contract at both ends.
    expect(runResultSchema.safeParse(withInconclusive('invalid')).success).toBe(false);
  });

  it('rejects `failed` in the field — the runner says inconclusive, not a verdict', () => {
    expect(runResultSchema.safeParse(withInconclusive('failed')).success).toBe(false);
  });

  it('a blocked row keeps its assertions — the field does not erase evidence', () => {
    const parsed = parseRunResult(withInconclusive('blocked'));
    expect(parsed.evals[0]!.rows[0]!.assertions).toHaveLength(1);
  });
});
