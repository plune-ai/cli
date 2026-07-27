// PUBLIC PROGRAMMATIC API (`@plune-ai/cli`).
//
// This is the library entry point for consumers who want to run Plune from their own code
// (CI pipelines, test frameworks) instead of the `plune` binary — AC-T06.
//
// HARD RULE (ADR-S10-03 / NFR-3): nothing here may import `commander`, `dotenv`, or `./cli.ts`.
// The CLI parses argv and auto-loads `.env`; the library does neither. `run()` is the same
// orchestration composition root the CLI uses (`handleRun`), minus the argv/exit-code shell.
// The e2e bundle-analysis asserts `dist/index.js` contains no `commander`.

export { handleRun as run } from './cli/commands/run.js';
export type { RunOptions } from './cli/commands/run.js';

// Frozen public types (schemaVersion: 1) — re-exported from the pinned barrel (ADR-TC02).
export type {
  RunResult,
  EvalResult,
  RowResult,
  AssertionResultRecord,
  Summary,
  Usage,
  RunError,
} from './types/public.js';

// The config shape a caller would build a `plune.yaml` against.
export type { Config } from './types/config.js';

// The runtime validator for a single assertion. Unlike everything above it is a *value*, not a
// type: consumers that store assertions of their own (the Plune platform stores them on a
// TestCase) need to validate them with the same schema the runner uses, so the two can never
// drift apart. Frozen on the same terms as the rest of this barrel (ADR-TC01).
export { assertionConfigSchema } from './config/schema.js';

// The runtime validator for the RunResult contract, for consumers that INGEST a run rather than
// produce one. `plune sync` validates the local run file with it before uploading; the Plune platform
// validates the same body on `POST /v1/runs`. One schema on both ends is what makes the two unable to
// drift. The record schemas are exported too so a consumer's own result entity can reuse the exact
// assertion shapes the runner emits instead of restating them.
export {
  parseRunResult,
  runResultSchema,
  RUN_RESULT_SCHEMA_VERSION,
  assertionResultRecordSchema,
  binaryVerdictSchema,
} from './types/run-result-schema.js';
export type { ParsedRunResult, BinaryVerdict } from './types/run-result-schema.js';
