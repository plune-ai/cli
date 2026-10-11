export interface Summary {
  total: number;
  passed: number;
  failed: number;
  errored: number;
  cost_usd: number;
  duration_ms: number;
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
  /**
   * ADR 0045. Say it when the test was never judged, rather than letting `failed` stand for both
   * "the environment broke" and "the code is wrong".
   *
   * Optional and purely additive: a producer that does not send it validates exactly as before,
   * which is why `schemaVersion` stays 1.
   */
  inconclusive?: RowInconclusive;
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
