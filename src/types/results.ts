export interface Summary {
  total: number;
  passed: number;
  failed: number;
  errored: number;
  /**
   * plune#1245. Rows the runner said were never judged (`RowResult.inconclusive`), counted apart from
   * `failed`. The runner always writes both; they are optional so a RunResult written before them is
   * still valid and `schemaVersion` stays 1. With them, `passed + failed + errored + blocked + skipped`
   * is `total`.
   */
  blocked?: number;
  skipped?: number;
  cost_usd: number;
  duration_ms: number;
  /** plune-ai/plune#1696. Where the answers came from. Optional and additive; absent in older runs. */
  cache?: CacheSummary;
}

/**
 * `from_cache` rows were answered by the store, `from_model` by a model call, `missed` had no entry
 * under `--cache-strict` and were not answered. The `saved` totals are the sum of the rows' `cache_saved`.
 */
export interface CacheSummary {
  from_cache: number;
  from_model: number;
  missed: number;
  saved: { input_tokens: number; output_tokens: number; cost_usd: number };
}

export interface AssertionResultRecord {
  type: string;
  passed: boolean;
  score?: number;
  reason?: string;
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

export interface RunError {
  code: string;
  message: string;
}

/**
 * TestCase contract — the authoring record for the Plune TMS core.
 *
 * Three type-tagged kinds, each with a type-dependent body:
 *   - `manual`    → human-run steps `{ action, expected }`
 *   - `automated` → a reference to an external automated spec (`specRef`)
 *   - `eval`      → an LLM eval: `prompt`, optional `goldenSetId`, and runnable `assertions[]`
 *
 * ADR 0045 / plune#1246: `is_flaky` and `is_muted` are optional, purely additive flags.
 *   - `is_flaky` — assertion about a case: "this test is unstable by nature" (diagnostics).
 *   - `is_muted` — human decision: "we execute and record it, but it does not count toward the run summary" (policy).
 * Both are optional and purely additive: a producer that does not send them validates exactly as before,
 * so `schemaVersion` stays at 2.
 */
export const TEST_CASE_SCHEMA_VERSION = 2 as const;

export interface ManualStep {
  action: string;
  expected?: string;
}

export interface ExternalKey {
  kind: 'playwright-id' | 'path-title' | 'allure-history' | 'cairn-stable' | 'eval-id' | 'qase' | 'testrail';
  value: string;
}

type ManualCase = {
  type: 'manual';
  steps: { action: string; expected?: string }[];
  expected?: string;
};

type AutomatedCase = {
  type: 'automated';
  specRef: string;
};

type EvalCase = {
  type: 'eval';
  prompt: string;
  goldenSetId?: string;
  assertions: AssertionResultRecord[];
};

export interface TestCaseBase {
  schemaVersion: 2;
  id: string;
  externalKeys?: ExternalKey[];
  is_flaky?: boolean;
  is_muted?: boolean;
}

export type TestCase = TestCaseBase & (ManualCase | AutomatedCase | EvalCase);

import { testCaseSchema } from './test-case-schema.js';

/**
 * Parse + validate an unknown value as a TestCase. Throws ZodError on failure.
 * Cast is needed because `exactOptionalPropertyTypes` makes the zod output stricter
 * than the interface with optional properties.
 */
export function parseTestCase(value: unknown): TestCase {
  return testCaseSchema.parse(value) as TestCase;
}

/**
 * The two words a row may use to say the product was never judged (ADR 0045).
 *
 * Both are already statuses this system has — they are `RESULT_STATUSES` entries — and neither was
 * reachable through this contract: a row could only report `passed`, `failed` or `broken`. So a
 * runner whose row was stopped by something outside the test had exactly one word left, `failed`,
 * and the word was wrong. A red build because a dependency fell over reads identically to a red
 * build because the code is broken, and those are two different pieces of work.
 *
 * `invalid` is deliberately absent: Qase's `invalid` is our `broken`, and a second word for one
 * idea would fork the contract at both ends.
 */
export const ROW_INCONCLUSIVE = ['blocked', 'skipped'] as const;
export type RowInconclusive = (typeof ROW_INCONCLUSIVE)[number];

export interface RowResult {
  vars: Record<string, unknown>;
  output: string | null;
  cached: boolean;
  usage?: Usage;
  latency_ms?: number;
  error?: RunError;
  assertions: AssertionResultRecord[];
  /** plune-ai/plune#1696. On a cache hit: what the call would have cost. Optional and additive. */
  cache_saved?: { input_tokens: number; output_tokens: number; cost_usd: number };
  /**
   * ADR 0045. Say it when the test was never judged, rather than letting `failed` stand for both
   * "the environment broke" and "the code is wrong".
   *
   * Optional and purely additive: a producer that does not send it validates exactly as before,
   * which is why `schemaVersion` stays 1.
   */
  inconclusive?: RowInconclusive;
}

export type RowStatus = 'passed' | 'failed' | 'errored' | RowInconclusive;

/**
 * What a row counts as — the one classifier the summary, the reporters and the diff share.
 *
 * The platform's order (`statusFromAssertions`, ADR 0045): the runner's `inconclusive` first, since
 * neither a passing assertion nor a harness error may turn "never judged" into a verdict; then an
 * error is `errored` (the platform's `broken`); then the assertions.
 */
export function rowStatus(row: RowResult): RowStatus {
  if (row.inconclusive !== undefined) return row.inconclusive;
  if (row.error !== undefined) return 'errored';
  return row.assertions.every((a) => a.passed) ? 'passed' : 'failed';
}

export interface EvalResult {
  id: string;
  tags: string[];
  rows: RowResult[];
  passed: boolean;
}

export interface RunResult {
  schemaVersion: 1;
  plune_version: string;
  started_at: string;
  finished_at: string;
  config_hash: string;
  summary: Summary;
  evals: EvalResult[];
}
