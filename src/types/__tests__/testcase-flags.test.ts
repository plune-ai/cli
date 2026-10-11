import { describe, expect, it } from 'vitest';
import type { TestCase } from '../public.js';
import { parseTestCase, testCaseSchema } from '../test-case-schema.js';

/**
 * ADR 0045 / plune#1246 — `is_flaky` / `is_muted` on a TestCase.
 *
 * `is_flaky` — assertion about a case: "this test is unstable by nature" (diagnostics).
 * `is_muted` — human decision: "we execute and record it, but it does not count toward the run summary" (policy).
 *
 * Both are optional and purely additive: a producer that does not send them validates exactly as before,
 * so `schemaVersion` stays at 2. The platform already validates these fields on the wire.
 */

const baseExternalKeys = [
  { kind: 'playwright-id', value: 'tests/example.spec.ts::Example test' } as const,
];

function manualCase(is_flaky?: boolean, is_muted?: boolean): TestCase {
  const caseBase: TestCase = {
    schemaVersion: 2,
    id: 'case_123',
    type: 'manual',
    steps: [{ action: 'click', expected: 'works' }],
    externalKeys: baseExternalKeys,
  };
  if (is_flaky !== undefined) caseBase.is_flaky = is_flaky;
  if (is_muted !== undefined) caseBase.is_muted = is_muted;
  return caseBase;
}

describe('testCaseSchema — is_flaky / is_muted (ADR 0045, plune#1246)', () => {
  it('accepts a case with is_flaky = true', () => {
    const parsed = parseTestCase(manualCase(true));
    expect(parsed.is_flaky).toBe(true);
  });

  it('accepts a case with is_flaky = false', () => {
    const parsed = parseTestCase(manualCase(false));
    expect(parsed.is_flaky).toBe(false);
  });

  it('accepts a case with is_muted = true', () => {
    const parsed = parseTestCase(manualCase(undefined, true));
    expect(parsed.is_muted).toBe(true);
  });

  it('accepts a case with is_muted = false', () => {
    const parsed = parseTestCase(manualCase(undefined, false));
    expect(parsed.is_muted).toBe(false);
  });

  it('accepts both flags together', () => {
    const parsed = parseTestCase(manualCase(true, true));
    expect(parsed.is_flaky).toBe(true);
    expect(parsed.is_muted).toBe(true);
  });

  it('still accepts a case WITHOUT the flags (optional, additive — schemaVersion stays 2)', () => {
    const parsed = parseTestCase(manualCase());
    expect(parsed.is_flaky).toBeUndefined();
    expect(parsed.is_muted).toBeUndefined();
    expect(parsed.schemaVersion).toBe(2);
  });

  it('rejects non-boolean is_flaky', () => {
    expect(testCaseSchema.safeParse(manualCase('yes' as unknown as boolean)).success).toBe(false);
  });

  it('rejects non-boolean is_muted', () => {
    expect(testCaseSchema.safeParse(manualCase(undefined, 'yes' as unknown as boolean)).success).toBe(false);
  });
});