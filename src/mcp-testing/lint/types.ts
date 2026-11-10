/**
 * The result format every MCP check shares (lint, agent checks, the security scan): one shape,
 * so a report, a JUnit file or the platform reads them the same way. Field and state names are final; a report may
 * add fields but never change what these mean. The report a command prints around them is in ../result.ts.
 */

/** `measure`: a number against a threshold. `deterministic`: yes or no by a rule. `heuristic`: advice. */
export type CheckClass = 'measure' | 'deterministic' | 'heuristic';

export type CheckLevel = 'error' | 'warn' | 'info';

/**
 * Exactly five. `could-not-run` is never reported, scored or exported as `passed`; a gate with nothing measured
 * (every check `not-applicable` or `pending`) is not green.
 */
export type CheckState = 'passed' | 'failed' | 'not-applicable' | 'could-not-run' | 'pending';

/** What a finding is about: a tool, and for a parameter its path too (`cases[].changes`). */
export interface LintTarget {
  tool: string;
  param?: string;
}

export interface LintFinding {
  /** Stable rule id, e.g. `desc-missing`; it does not change while the check stays the same. */
  id: string;
  class: CheckClass;
  level: CheckLevel;
  state: CheckState;
  target: LintTarget;
  message: string;
  expected: string;
  actual: string;
  /** What to change so the check passes. */
  fix: string;
  /** Where the requirement is written; empty for advice that is not from the specification. */
  specRef: string;
}

/** The tool annotations of the specification; every field is a hint. */
export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** One entry of a `tools/list` answer, read as data: whatever a server sends, nothing here is trusted to be well formed. */
export interface ListedTool {
  name: string;
  title?: string | undefined;
  description?: string | undefined;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: ToolAnnotations | undefined;
}

/**
 * A deliberate exception: this rule on this target is accepted, and why. A target without `tool` covers the rule on
 * every tool; without `param`, every parameter of the tool as well as the tool itself.
 */
export interface LintException {
  id: string;
  target: Partial<LintTarget>;
  reason: string;
}
