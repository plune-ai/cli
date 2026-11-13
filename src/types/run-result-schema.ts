import { z } from 'zod';
import type { RunResult } from './results.js';
import { ROW_INCONCLUSIVE } from './results.js';

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
 *
 * Superset too: an agentic row's `agent` may carry `advice[]` `{ type, reason }`, the findings of the heuristic
 * assertions (`AgentRecord`), which never change the row's status.
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
  /** cli#151. Optional and additive — a RunResult written before it validates unchanged. */
  priced: z.boolean().optional(),
});

const runErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
});

const savedSchema = z.object({
  input_tokens: z.number(),
  output_tokens: z.number(),
  cost_usd: z.number(),
});

const rowResultSchema = z.object({
  vars: z.record(z.string(), z.unknown()),
  output: z.string().nullable(),
  cached: z.boolean(),
  usage: usageSchema.optional(),
  latency_ms: z.number().optional(),
  error: runErrorSchema.optional(),
  assertions: z.array(assertionResultRecordSchema),
  cache_saved: savedSchema.optional(),
  /** ADR 0045. Optional and additive — the same enum the platform validates on `POST /v1/runs`. */
  inconclusive: z.enum(ROW_INCONCLUSIVE).optional(),
  /** Repeats (`runs` above 1). Optional and additive — a RunResult without it validates unchanged. */
  attempts: z
    .object({
      runs: z.number(),
      pass_threshold: z.number(),
      passed: z.number(),
      failed: z.number(),
      errored: z.number(),
      results: z.array(
        z.object({
          output: z.string().nullable(),
          cached: z.boolean(),
          usage: usageSchema.optional(),
          latency_ms: z.number().optional(),
          error: runErrorSchema.optional(),
          assertions: z.array(assertionResultRecordSchema),
          cache_saved: savedSchema.optional(),
        }),
      ),
    })
    .optional(),
  /** The tool loop of an eval with an `mcp` server. Optional and additive — a RunResult without it validates unchanged. */
  agent: z
    .object({
      server: z.string(),
      tools: z.array(
        z.object({
          name: z.string(),
          offered: z.boolean(),
          annotations: z.record(z.string(), z.unknown()).optional(),
        }),
      ),
      steps: z.array(
        z.object({
          index: z.number(),
          text: z.string(),
          finish_reason: z.string().optional(),
          usage: usageSchema,
          calls: z.array(
            z.object({
              id: z.string(),
              name: z.string(),
              args: z.unknown(),
              executed: z.boolean(),
              is_error: z.boolean(),
              error_kind: z
                .enum(['content', 'protocol', 'timeout', 'not-offered', 'bad-arguments'])
                .optional(),
              duration_ms: z.number().optional(),
              result: z
                .object({ text: z.string(), bytes: z.number(), truncated: z.boolean() })
                .optional(),
            }),
          ),
          /** Optional and additive: the step whose request first offered a changed list. */
          offered_changed: z.object({ added: z.array(z.string()), removed: z.array(z.string()) }).optional(),
        }),
      ),
      stop: z.object({
        reason: z.enum(['complete', 'limit', 'error']),
        limit: z
          .enum(['max_steps', 'max_tool_calls', 'max_total_tokens', 'timeout_ms', 'tool_timeout_ms'])
          .optional(),
      }),
      collection: z.enum(['complete', 'partial']),
      /** Heuristic findings, never a verdict. Optional and additive. */
      advice: z.array(z.object({ type: z.string(), reason: z.string() })).optional(),
    })
    .optional(),
});

const summarySchema = z.object({
  total: z.number(),
  passed: z.number(),
  failed: z.number(),
  errored: z.number(),
  /** plune#1245. Optional and additive — a RunResult written before them validates unchanged. */
  blocked: z.number().optional(),
  skipped: z.number().optional(),
  cost_usd: z.number(),
  duration_ms: z.number(),
  cache: z
    .object({
      from_cache: z.number(),
      from_model: z.number(),
      missed: z.number(),
      errored: z.number(),
      saved: z.object({ input_tokens: z.number(), output_tokens: z.number(), cost_usd: z.number() }),
    })
    .optional(),
});

const evalResultSchema = z.object({
  id: z.string(),
  tags: z.array(z.string()),
  rows: z.array(rowResultSchema),
  passed: z.boolean(),
  /** What the eval measured, for the pass-rate gate of `plune diff`. Optional and additive. */
  measured: z
    .object({
      runs: z.number(),
      rows: z.number(),
      rows_hash: z.string(),
      assertions_hash: z.string(),
      model: z.string().optional(),
    })
    .optional(),
});

export const runResultSchema = z.object({
  schemaVersion: z.literal(RUN_RESULT_SCHEMA_VERSION),
  plune_version: z.string(),
  started_at: z.string(),
  finished_at: z.string(),
  config_hash: z.string(),
  /** cli#244. The result of `--dry-run`. Optional and additive — a RunResult without it validates unchanged. */
  dry_run: z.boolean().optional(),
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
