import { z } from 'zod';
import type { RunResult } from './results.js';

/**
 * Runtime validation for the RunResult contract — the JSON that `plune run --format json` emits.
 *
 * The canonical TypeScript shape is owned by `./results.ts` (golden-pinned, `schemaVersion: 1`,
 * snake_case). This module is its zod mirror: the validator for anything that has to *ingest* that
 * output rather than produce it. `plune sync` validates the local run file with it before uploading,
 * and the Plune platform validates the same body on `POST /v1/runs` — one schema, both ends, so a
 * divergent copy is impossible (the reason it lives here and not in the platform).
 *
 * Superset: an assertion record may carry an optional `binaryVerdicts[]` — the per-question breakdown
 * of an llm-judge verdict `{ question, passed }`. The runner does not emit the field; plain output
 * validates unchanged, and a consumer that enriches a result stays valid. Purely additive.
 */

/**
 * Version marker for the RunResult contract, type-pinned to the frozen `RunResult['schemaVersion']`
 * literal: if the public contract ever bumps its version, this line fails typecheck until it is
 * updated in lockstep with the golden test.
 */
export const RUN_RESULT_SCHEMA_VERSION: RunResult['schemaVersion'] = 1;

// Exported so a consumer building its own result entity reuses the EXACT assertion-result and
// BINEVAL shapes the runner emits, instead of restating them (same reuse principle as
// `assertionConfigSchema`).
export const binaryVerdictSchema = z.object({
  question: z.string().min(1),
  passed: z.boolean(),
});

export const assertionResultRecordSchema = z.object({
  type: z.string(),
  passed: z.boolean(),
  score: z.number().optional(),
  reason: z.string().optional(),
  binaryVerdicts: z.array(binaryVerdictSchema).optional(),
});

const usageSchema = z.object({
  input_tokens: z.number(),
  output_tokens: z.number(),
  cost_usd: z.number(),
});

const runErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
});

const rowResultSchema = z.object({
  vars: z.record(z.unknown()),
  output: z.string().nullable(),
  cached: z.boolean(),
  usage: usageSchema.optional(),
  latency_ms: z.number().optional(),
  error: runErrorSchema.optional(),
  assertions: z.array(assertionResultRecordSchema),
});

const summarySchema = z.object({
  total: z.number(),
  passed: z.number(),
  failed: z.number(),
  errored: z.number(),
  cost_usd: z.number(),
  duration_ms: z.number(),
});

const evalResultSchema = z.object({
  id: z.string(),
  tags: z.array(z.string()),
  rows: z.array(rowResultSchema),
  passed: z.boolean(),
});

export const runResultSchema = z.object({
  schemaVersion: z.literal(RUN_RESULT_SCHEMA_VERSION),
  plune_version: z.string(),
  started_at: z.string(),
  finished_at: z.string(),
  config_hash: z.string(),
  summary: summarySchema,
  evals: z.array(evalResultSchema),
});

/**
 * Type inferred from the zod mirror — structurally a superset of the frozen `RunResult`
 * (adds optional `binaryVerdicts`). The canonical `RunResult` remains the source of truth.
 */
export type ParsedRunResult = z.infer<typeof runResultSchema>;
export type BinaryVerdict = z.infer<typeof binaryVerdictSchema>;

/**
 * Compile-time guard: the canonical frozen `RunResult` must be assignable to the zod mirror's
 * inferred type. If `./results.ts` and this schema ever drift, this line fails typecheck.
 */
const _runResultCompatible: ParsedRunResult = undefined as unknown as RunResult;
void _runResultCompatible;

/** Parse + validate an unknown value as a RunResult. Throws ZodError on failure. */
export function parseRunResult(value: unknown): ParsedRunResult {
  return runResultSchema.parse(value);
}
