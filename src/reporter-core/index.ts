/**
 * `@plune-ai/cli/reporter-core` — everything that knows how to talk to the Plune platform.
 *
 * This is a **separate entry point** from `@plune-ai/cli` on purpose (ADR 0001 of this feature):
 * an adapter bundles what it imports from here, and pulling in the package root would drag the
 * whole CLI — a native SQLite build, two provider SDKs, an argument parser — into the tree of
 * every project that only wanted to report test results.
 *
 * Nothing here imports a framework. An adapter maps its runner's output to `PendingResult` and
 * hands it over; deciding what a status means, which case a result belongs to, when to batch and
 * what to do when the platform is down all live on this side of the line (ADR 0023).
 */

export { startRun } from './session.js';
export type { RunSession } from './session.js';

export { resultKey, RESULT_KEY_MAX } from './result-key.js';

/** What a CI job may set without editing a committed config. */
export { readEnv, UNSUPPORTED_VARS } from './env.js';
export type { EnvSettings } from './env.js';

export { appendBatch, DEFAULT_FALLBACK_PATH } from './fallback.js';
export type { DeferredBatch, DeferredResult } from './fallback.js';

/** The client itself, for the CLI commands that drive a run without a runner (C5). */
export { createClient } from './client.js';
export type { PlatformClient, ClientOutcome, ClientFailureKind, ClientOptions } from './client.js';

export type {
  AssertionRecord,
  Attachment,
  Execution,
  ExpectedEntry,
  ExternalKeyKind,
  KeyRef,
  PendingResult,
  ReporterConfig,
  ResultStatus,
  ResultSubmission,
  RunKind,
  RunMeta,
  RunRecord,
  RunStats,
  SubmitCounts,
} from './types.js';
