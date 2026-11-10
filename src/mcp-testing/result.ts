/**
 * The result every `plune mcp` command that tests a server reports: the check states, and the report one run makes.
 * Renderers (src/mcp-testing/render.ts) turn a report into text; a new output format is a new renderer, never a new
 * shape. Field and state names are final; a later version may add fields but never change what these mean, and says
 * so by raising `schemaVersion`.
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
