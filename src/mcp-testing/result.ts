/**
 * The result every `plune mcp` command that tests a server reports: the check states, and the report one run makes.
 * Renderers (src/mcp-testing/render.ts) turn a report into text; a new output format is a new renderer, never a new
 * shape. Field and state names are final; a later version may add fields but never change what these mean, and says
 * so by raising `schemaVersion`. Every document names itself by `kind` and `schemaVersion`: adding a field keeps the
 * version, renaming or removing one raises it.
 */

import type { CheckClass, CheckLevel, CheckState } from './lint/types.js';

// The states, classes and levels are defined beside the rules (the lint module imports nothing from outside it) and
// shared from here by every command.
export type { CheckClass, CheckLevel, CheckState };

/** The lowest level that fails a run, or `never`. */
export type FailOn = CheckLevel | 'never';

export interface ReportFinding {
  rule: string;
  class: CheckClass;
  level: CheckLevel;
  state: CheckState;
  target: { tool: string; param?: string };
  message: string;
  expected: string;
  actual: string;
  fix: string;
  /** Where the requirement is written; empty for advice that is not from the specification. */
  specRef: string;
}

/** A finding an exception set aside: still reported, never silently gone. */
export interface SuppressedFinding extends ReportFinding {
  reason: string;
  expires?: string;
}

/** An entry of the exceptions file, by the line it starts on. */
export interface ExceptionNote {
  rule: string;
  /** Absent: the entry covers the rule on every tool. */
  tool?: string;
  /** Absent: every parameter of the tool, and the tool itself. */
  param?: string;
  line: number;
  expires?: string;
}

export interface CallOutcome {
  tool: string;
  /** `failed`: the call answered and a call rule found something; `could-not-run`: no answer to judge. */
  state: Extract<CheckState, 'passed' | 'failed' | 'could-not-run'>;
  reason?: string;
}

export interface McpReport {
  /** What the document is; with `schemaVersion`, how to read it. */
  kind: 'mcp-lint-report';
  schemaVersion: 1;
  command: 'lint';
  /** `serverInfo` from the handshake; null when the server gave none. */
  server: { name: string; version: string } | null;
  transport: 'stdio' | 'http' | 'sse';
  toolCount: number;
  /** Reading `tools/list` to its last page; `could-not-run` when the pages did not end within the limit. */
  listing: { state: Extract<CheckState, 'passed' | 'could-not-run'>; pages: number };
  failOn: FailOn;
  /** Findings by level (shown or not), and how many exceptions set aside. */
  counts: { error: number; warn: number; info: number; suppressed: number };
  findings: ReportFinding[];
  suppressed: SuppressedFinding[];
  exceptions: { file: string | null; expired: ExceptionNote[]; stale: ExceptionNote[] };
  /** Null without `--call`. `skipped` says why a tool was not called (a `selectSafeTools` reason, or `call-limit`). */
  calls: {
    limit: number;
    called: CallOutcome[];
    skipped: { tool: string; reason: string }[];
  } | null;
  exitCode: 0 | 1 | 3;
}

// `plune mcp check`: whether a server is alive and answers the basic requests, check by check.

/** The checks, in the order they run. */
export type HealthCheckId =
  | 'start'
  | 'initialize'
  | 'protocol-version'
  | 'capabilities'
  | 'tools-list'
  | 'resources-list'
  | 'resource-templates-list'
  | 'prompts-list'
  | 'ping';

export interface HealthCheck {
  id: HealthCheckId;
  state: CheckState;
  /** One sentence: what was seen. */
  detail: string;
  /** Present when no answer came within --check-timeout (or --timeout, for initialize). */
  timedOut?: true;
  /** The entries a list check read to its last page. */
  count?: number;
}

/** One tool of `--smoke`: called (`passed`, `failed`, `could-not-run`) or not, and why (`not-applicable`). */
export interface SmokeCall {
  tool: string;
  state: Exclude<CheckState, 'pending'>;
  detail: string;
  timedOut?: true;
}

export interface McpCheckReport {
  kind: 'mcp-check-report';
  schemaVersion: 1;
  command: 'check';
  /** The version of `plune` that ran the checks. */
  plune: string;
  /** `serverInfo` from the handshake; null when there was none. */
  server: { name: string; version: string } | null;
  /** The transport only: never the URL, the command, its environment or the headers. */
  transport: 'stdio' | 'http' | 'sse';
  /** The protocol version the server answered with; null without a handshake. */
  protocolVersion: string | null;
  checkTimeout: string;
  checks: HealthCheck[];
  /** Null without `--smoke`. */
  smoke: { limit: number; timeout: string; budget: string; calls: SmokeCall[] } | null;
  writeCallsAllowed: boolean;
  /** The last lines the server process wrote to stderr, masked (stdio only). */
  stderrTail: string[];
  exitCode: 0 | 1 | 3;
  /** How long each part took, apart from the states: the one field two runs on the same server differ in. */
  timing: {
    totalMs: number;
    checks: { id: HealthCheckId; ms: number }[];
    calls: { tool: string; ms: number }[];
  };
}

/**
 * What `plune mcp diff` reports: every change between two contract snapshots, classified by the rules of
 * src/mcp-testing/snapshot/diff.ts, and the exit code it gave. No time, no file path and nothing that says where the
 * current snapshot came from: a live server and its snapshot file give the same bytes.
 */
export interface McpDiffReport {
  kind: 'mcp-diff-report';
  schemaVersion: 1;
  command: 'diff';
  failOn: 'breaking' | 'any' | 'none';
  summary: import('./snapshot/diff.js').ContractDiffSummary;
  changes: import('./snapshot/diff.js').ContractChange[];
  exitCode: 0 | 1 | 3;
}

// `plune mcp conformance`: the server against the text of the specification, check by check, with a score.

/** The level of a requirement of the specification; the `level` of a conformance check. */
export type RequirementLevel = 'MUST' | 'SHOULD' | 'MAY';

/** One check of a conformance run: the fields every check result has, and why it was not measured. */
export interface ConformanceResult {
  id: string;
  suite: import('./conformance/catalog.js').Suite;
  kind: import('./conformance/catalog.js').CheckKind;
  /** `deterministic` for a check or a control, `heuristic` for advice. */
  class: Extract<CheckClass, 'deterministic' | 'heuristic'>;
  /** Null for a control or advice. */
  level: RequirementLevel | null;
  /** The true verdict, also for a check outside the profile (it is `pending` for the score only). */
  state: CheckState;
  /** For `not-applicable` and `could-not-run`. */
  reason?: import('./conformance/outcome.js').NotApplicableReason | import('./conformance/outcome.js').CouldNotRunReason;
  /** Which bucket of the summary holds it. */
  bucket: keyof import('./conformance/score.js').Buckets;
  expected: string;
  actual: string;
  fix: string;
  /** The first reference of the catalog entry, as a link and its section. */
  specRef: string;
  /** The HTTP requests the check sent and what came back (Streamable HTTP checks), secrets masked. */
  details?: import('./conformance/raw-http.js').Exchange[];
}

export interface McpConformanceReport {
  kind: 'mcp-conformance-report';
  schemaVersion: 1;
  command: 'conformance';
  /** The version of `@plune-ai/cli` that ran the checks. */
  checkerVersion: string;
  profileId: string;
  profileVersion: string;
  /** SHA-256 of the sorted ids of the profile. */
  manifestDigest: string;
  /** The revision the checks ran for: `--protocol-version`, else the one the server answered with; null without either. */
  protocolVersion: string | null;
  /** `auto`, `both` or the revision `--protocol-version` named. */
  protocolVersionRequested: string;
  /** The era the checks ran for: `legacy` (the initialize handshake) or `modern` (2026-07-28, server/discover). */
  era?: import('./conformance/catalog.js').Era;
  /** How the era was chosen: by `--protocol-version`, or what the server/discover probe of `auto` got. */
  eraDetection?: string;
  server: { name: string; version: string } | null;
  transport: 'stdio' | 'http' | 'sse';
  suites: import('./conformance/catalog.js').Suite[];
  checks: ConformanceResult[];
  /** The checks that count for nothing yet: not in the profile, or no result. */
  pendingCheckIds: string[];
  /** One summary per selected suite, each from its own counts. */
  bySuite: Partial<Record<import('./conformance/catalog.js').Suite, import('./conformance/score.js').Summary>>;
  /** Every selected check: the counts of all suites added up, not an average of their scores. */
  summary: import('./conformance/score.js').Summary;
  /** The oauth suite: the revision and the registration method (null when `--config` names none) this run was for. */
  matrix?: { revision: string; registration: string | null };
  exitCode: 0 | 1 | 3;
}

/**
 * `--protocol-version both`: one full report per era, each with its own score, never mixed; the exit code is the worst
 * of the two (1 before 3 before 0).
 */
export interface McpConformanceReportSet {
  kind: 'mcp-conformance-report-set';
  schemaVersion: 1;
  command: 'conformance';
  reports: McpConformanceReport[];
  /**
   * The oauth matrix: the counters of every run added up (not an average of scores), and the score made from the sums.
   * Absent for the two eras of a protocol run, which are scored on their own.
   */
  combined?: {
    runs: number;
    passed: number;
    failed: number;
    couldNotRun: number;
    applicable: number;
    score: number | null;
    verdict: import('./conformance/score.js').RunVerdict;
  };
  exitCode: 0 | 1 | 3;
}
