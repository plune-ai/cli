/**
 * The one input of every report format: a run of `plune mcp lint`, `check`, `diff` or `conformance` as the checks it
 * made, each in the same shape, beside the command's own JSON document. The adapters of ./runs.ts build it from a
 * command's report; the renderers of ./index.ts turn it into text. A new command (or a new format) adds an adapter
 * (or a renderer) and leaves this shape as it is.
 */

import type { ScanReport } from '../scan/report.js';
import type { CheckClass, CheckLevel, CheckState } from '../result.js';
import type {
  McpCheckReport,
  McpConformanceReport,
  McpConformanceReportSet,
  McpDiffReport,
  McpReport,
} from '../result.js';

/** One check of one target, as every format reads it. */
export interface ReportCheck {
  /** Stable: a rule id, a check id or a fixed name. The JUnit case it belongs to. */
  id: string;
  /** What the check is about, the same on every run. */
  title: string;
  /** What was checked: a tool, `tool.param`, an entity of the contract; empty for the server itself. */
  target: string;
  state: CheckState;
  class: CheckClass;
  level: CheckLevel;
  /** One sentence on what was seen. */
  message: string;
  expected: string;
  actual: string;
  /** How to make the check pass, in a sentence or two. */
  fix: string;
  /** Where the requirement is written; empty when nowhere. */
  specRef: string;
  /** Null when the command does not time its checks. */
  durationMs: number | null;
  /** Failed, but below the run's --fail-on: advice, as a heuristic is, not a failure. */
  advisory?: true;
}

export type McpCommand = 'lint' | 'check' | 'diff' | 'conformance' | 'scan';

export interface McpRun {
  command: McpCommand;
  /** The command's own document: what `json` prints. */
  document:
    | McpReport
    | McpCheckReport
    | McpDiffReport
    | McpConformanceReport
    | McpConformanceReportSet
    | ScanReport;
  /**
   * The fixed set of JUnit cases, the same on every run of the command with the same flags, whatever the server says.
   * Empty when nothing was measured: the report then holds one `run` case that could not run. `suite` (conformance)
   * goes into the case's `classname`: `mcp.<command>.<suite>`.
   */
  cases: { id: string; title: string; suite?: string }[];
  /** Every check made, each under one of `cases`; a case with none passed. */
  checks: ReportCheck[];
  /** Why nothing was measured, when `cases` is empty. */
  nothing: string;
  /** `lint --show-info`: the info findings are shown in `human`, `github` and `markdown`. */
  showInfo: boolean;
  /** A command whose formats are its own (`scan`): it renders every format itself, and the shared renderers are not used. */
  custom?: (format: string) => string;
}

export const KIND = {
  lint: 'mcp-lint-report',
  check: 'mcp-check-report',
  diff: 'mcp-diff-report',
  conformance: 'mcp-conformance-report',
} as const;
